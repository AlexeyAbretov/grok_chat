import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseChatRequest, parseJsonText } from '../src/json-schema.ts'
import { createLlmLog } from './llm-log.ts'
import { runTool, TOOLS } from './tools.ts'
import type { Usage } from '../src/types.ts'
import { addUsage, consumeTurn, usageToApi } from './turn.ts'

const MAX_BODY = 2_000_000
const PORT = Number(process.env.PORT) || 8787
const DIST = resolve('dist')

const SYSTEM_PROMPT = [
  'You are Grok, a helpful assistant. Reply in the same language the user writes in.',
  'Use calculator, read_file, and search_notes when they can answer the question. Do not guess arithmetic or the contents of notes/.',
].join(' ')

const MAX_TOOL_ROUNDS = 5

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

loadEnvFile()

export function startServer() {
  const apiKeyFromEnv = process.env.XAI_API_KEY ?? ''
  const server = createServer((req, res) => {
    void handle(req, res, apiKeyFromEnv).catch((error: unknown) => {
      if (res.writableEnded || res.destroyed) return
      const message = error instanceof Error ? error.message : 'Внутренняя ошибка'
      writeJson(res, 500, { error: { message } })
    })
  })

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Порт ${PORT} уже занят`)
    } else {
      console.error(error.message)
    }
    process.exit(1)
  })

  return new Promise<Server>((resolveListen) => {
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`API http://127.0.0.1:${PORT}`)
      resolveListen(server)
    })
  })
}

async function handle(req: IncomingMessage, res: ServerResponse, apiKeyFromEnv: string) {
  const path = (req.url ?? '/').split('?')[0]
  if (path === '/api/status') {
    if (req.method !== 'GET') {
      writeJson(res, 405, { error: { message: 'Метод не поддерживается' } })
      return
    }
    writeJson(res, 200, { hasServerKey: apiKeyFromEnv.trim().length > 0 })
    return
  }
  if (path === '/api/chat') {
    await handleChat(req, res, apiKeyFromEnv)
    return
  }
  if (serveStatic(req, res)) return
  writeJson(res, 404, { error: { message: 'Не найдено' } })
}

async function handleChat(req: IncomingMessage, res: ServerResponse, apiKeyFromEnv: string) {
  if (req.method !== 'POST') {
    writeJson(res, 405, { error: { message: 'Метод не поддерживается' } })
    return
  }

  const apiKey = normalizeKey(headerValue(req.headers['x-api-key'])) || normalizeKey(apiKeyFromEnv)
  if (!apiKey) {
    writeJson(res, 400, {
      error: { message: 'Нет API-ключа. Вставьте его слева или задайте XAI_API_KEY в .env и перезапустите сервер.' },
    })
    return
  }

  const raw = await readBody(req)
  const parsed = parseChatRequest(raw)
  if (!parsed.ok) {
    writeJson(res, 400, { error: { message: parsed.message } })
    return
  }

  const { chatId, model, reasoningEffort, maxTokens, messages } = parsed.request
  const input: unknown[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages]
  const llm = createLlmLog(chatId)
  llm.line(`файл logs/${chatId}.log`)
  llm.line(`→ ${model}, tools: ${TOOLS.map((tool) => tool.name).join(', ')}`)
  llm.items(input)

  const upstreamAbort = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) upstreamAbort.abort()
  })

  let streaming = false
  let usage: Usage | null = null
  let failed: string | null = null
  let failureStatus = 502
  let noticeReason: string | null = null

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      if (upstreamAbort.signal.aborted || res.destroyed) return
      if (round > 0) llm.line(`→ раунд ${round + 1}`)

      const upstream = await fetch('https://api.x.ai/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input,
          tools: TOOLS,
          max_output_tokens: maxTokens,
          reasoning: { effort: reasoningEffort },
          include: ['reasoning.encrypted_content'],
          stream: true,
          store: false,
        }),
        signal: upstreamAbort.signal,
      })

      if (!upstream.ok || !upstream.body) {
        const text = upstream.ok ? '' : await upstream.text()
        failed = readableUpstreamError(upstream.status, text)
        failureStatus = upstream.ok ? 502 : upstream.status || 502
        llm.line(`← HTTP ${failureStatus}: ${failed}`)
        break
      }

      if (!streaming) {
        streaming = true
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache, no-transform')
        res.setHeader('X-Accel-Buffering', 'no')
      }

      const turn = await consumeTurn(upstream.body, (event) => writeSse(res, event), upstreamAbort.signal)
      if (upstreamAbort.signal.aborted || res.destroyed) return
      usage = addUsage(usage, turn.usage)
      llm.turn(round + 1, turn.output, turn.failed, turn.incompleteReason, turn.usage)
      if (turn.failed) {
        failed = turn.failed
        break
      }
      if (turn.calls.length === 0) {
        noticeReason = turn.incompleteReason
        break
      }

      const outputs: unknown[] = []
      for (const call of turn.calls) {
        const parsedArgs = parseJsonText(call.arguments)
        const result = parsedArgs.ok ? runTool(call.name, parsedArgs.value) : { ok: false as const, output: 'Некорректный JSON' }
        await writeSse(res, { type: 'tool', name: call.name, args: preview(call.arguments), ok: result.ok, output: preview(result.output) })
        llm.tool(call.name, result.ok, result.output)
        outputs.push({
          type: 'function_call_output',
          call_id: call.callId,
          output: result.ok ? result.output : JSON.stringify({ error: result.output }),
        })
      }
      input.push(...turn.output, ...outputs)

      if (round === MAX_TOOL_ROUNDS - 1) noticeReason = 'max_tool_rounds'
    }

    if (upstreamAbort.signal.aborted || res.destroyed) return
    if (!streaming) {
      writeJson(res, failureStatus, { error: { message: failed ?? 'Пустой ответ' } })
      return
    }
    if (failed) {
      await writeSse(res, { type: 'error', error: { message: failed } })
    } else {
      await writeSse(res, {
        type: noticeReason !== null ? 'response.incomplete' : 'response.completed',
        response: {
          status: noticeReason !== null ? 'incomplete' : 'completed',
          ...(noticeReason !== null ? { incomplete_details: noticeReason ? { reason: noticeReason } : {} } : {}),
          ...(usage ? { usage: usageToApi(usage) } : {}),
        },
      })
    }
    res.end()
  } catch (error) {
    if (upstreamAbort.signal.aborted || res.destroyed) return
    if (!streaming) throw error
    const message = error instanceof Error ? error.message : 'Внутренняя ошибка'
    await writeSse(res, { type: 'error', error: { message } })
    if (!res.writableEnded) res.end()
  }
}

function serveStatic(req: IncomingMessage, res: ServerResponse) {
  if ((req.method !== 'GET' && req.method !== 'HEAD') || !existsSync(join(DIST, 'index.html'))) return false
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] || '/')
  const target = resolve(DIST, `.${urlPath}`)
  const escaped = relative(DIST, target)
  if (escaped.startsWith('..') || isAbsolute(escaped)) {
    writeJson(res, 403, { error: { message: 'Запрещено' } })
    return true
  }

  let filePath = target
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) filePath = join(DIST, 'index.html')
  res.statusCode = 200
  res.setHeader('Content-Type', STATIC_TYPES[extname(filePath)] ?? 'application/octet-stream')
  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  createReadStream(filePath).pipe(res)
  return true
}

function loadEnvFile() {
  const path = resolve('.env')
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

function readableUpstreamError(status: number, text: string) {
  const trimmed = text.trim()
  if (/not available in your region/i.test(trimmed)) return 'Сервис xAI недоступен из этого региона.'
  try {
    const parsed: unknown = JSON.parse(trimmed)
    const record = asRecord(parsed)
    const error = record?.error
    if (typeof error === 'string' && error.trim()) return error.trim()
    const nested = asRecord(error)
    if (typeof nested?.message === 'string' && nested.message.trim()) return nested.message.trim()
    if (typeof record?.message === 'string' && record.message.trim()) return record.message.trim()
  } catch {
    // HTML and plain-text errors fall through.
  }
  const plain = trimmed
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.slice(0, 300) || `xAI вернул ${status}`
}

function normalizeKey(raw: string) {
  const trimmed = raw.trim()
  return trimmed.toLowerCase().startsWith('bearer ') ? trimmed.slice(7).trim() : trimmed
}

function headerValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

function readBody(req: IncomingMessage) {
  return new Promise<string>((resolveBody, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buffer.length
      if (size > MAX_BODY) {
        reject(new Error('Слишком длинный запрос'))
        req.destroy()
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function preview(text: string) {
  const trimmed = text.trim()
  if (trimmed.length <= 500) return trimmed
  return `${trimmed.slice(0, 500)}…`
}

async function writeSse(res: ServerResponse, value: unknown) {
  if (res.destroyed || res.writableEnded) return
  const packet = `data: ${JSON.stringify(value)}\n\n`
  if (res.write(packet)) return
  await new Promise((resolveDrain) => {
    res.once('drain', resolveDrain)
    res.once('close', resolveDrain)
  })
}

function writeJson(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return null
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startServer()
}
