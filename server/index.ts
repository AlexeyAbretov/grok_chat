import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseChatRequest, parseJsonText } from '../shared/json-schema.ts'
import { parsePersistedState } from '../shared/state.ts'
import { chatDbPath, closeChatDb, openChatDb, readChats, writeChats } from './store.ts'
import { createLlmLog } from './llm-log.ts'
import { llmForModel, providerStatus } from './providers/index.ts'
import type { ChatInputMessage } from './providers/types.ts'
import { runTool, TOOLS } from './tools.ts'
import type { Usage } from '../shared/protocol.ts'
import { addUsage, usageToApi } from './turn.ts'

const MAX_BODY = 2_000_000
const MAX_CHAT_BODY = 8_000_000
const PORT = Number(process.env.PORT) || 8787
const DIST = resolve('dist')

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
  openChatDb()
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.writableEnded || res.destroyed) return
      const message = error instanceof Error ? error.message : 'Внутренняя ошибка'
      writeJson(res, 500, { error: { message } })
    })
  })

  server.on('close', () => {
    closeChatDb()
  })

  server.on('error', (error: NodeJS.ErrnoException) => {
    closeChatDb()
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
      console.log(`Чаты ${chatDbPath()}`)
      resolveListen(server)
    })
  })
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const path = (req.url ?? '/').split('?')[0]
  if (path === '/api/status') {
    if (req.method !== 'GET') {
      writeJson(res, 405, { error: { message: 'Метод не поддерживается' } })
      return
    }
    writeJson(res, 200, { providers: providerStatus() })
    return
  }
  if (path === '/api/chat') {
    await handleChat(req, res)
    return
  }
  if (path === '/api/chats') {
    await handleChats(req, res)
    return
  }
  if (serveStatic(req, res)) return
  writeJson(res, 404, { error: { message: 'Не найдено' } })
}

async function handleChats(req: IncomingMessage, res: ServerResponse) {
  if (req.method === 'GET') {
    writeJson(res, 200, readChats())
    return
  }
  if (req.method !== 'PUT') {
    writeJson(res, 405, { error: { message: 'Метод не поддерживается' } })
    return
  }

  const raw = await readBody(req, MAX_CHAT_BODY)
  const parsed = parseJsonText(raw)
  if (!parsed.ok) {
    writeJson(res, 400, { error: { message: parsed.reason === 'truncated' ? 'JSON обрезан' : 'Некорректный JSON' } })
    return
  }
  const state = parsePersistedState(parsed.value)
  if (!state.ok) {
    writeJson(res, 400, { error: { message: state.message } })
    return
  }
  if (state.state.chats.length === 0) {
    writeJson(res, 400, { error: { message: 'Нужен хотя бы один чат' } })
    return
  }
  writeChats(state.state)
  writeJson(res, 200, { ok: true })
}

async function handleChat(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    writeJson(res, 405, { error: { message: 'Метод не поддерживается' } })
    return
  }

  const raw = await readBody(req)
  const parsed = parseChatRequest(raw)
  if (!parsed.ok) {
    writeJson(res, 400, { error: { message: parsed.message } })
    return
  }

  const { chatId, model, reasoningEffort, maxTokens, messages } = parsed.request
  const provider = llmForModel(model)
  if (!provider) {
    writeJson(res, 400, { error: { message: 'Неизвестная модель' } })
    return
  }

  const apiKey = normalizeKey(process.env[provider.envVar] ?? '')
  if (!apiKey) {
    writeJson(res, 400, {
      error: { message: `Нет API-ключа. Задайте ${provider.envVar} в .env и перезапустите сервер.` },
    })
    return
  }

  const input: ChatInputMessage[] = [{ role: 'system', content: provider.systemPrompt }, ...messages]
  let transcript: unknown[] = []
  const llm = createLlmLog(chatId)
  llm.line(`файл logs/${chatId}.log`)
  llm.line(`→ ${provider.id}/${model}, tools: ${TOOLS.map((tool) => tool.name).join(', ')}`)
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

      const turn = await provider.streamTurn({
        apiKey,
        model,
        messages: input,
        transcript,
        tools: TOOLS,
        maxTokens,
        reasoningEffort,
        signal: upstreamAbort.signal,
        beginStream: () => {
          if (streaming) return
          streaming = true
          res.statusCode = 200
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
          res.setHeader('Cache-Control', 'no-cache, no-transform')
          res.setHeader('X-Accel-Buffering', 'no')
        },
        emit: (event) => writeSse(res, event),
      })
      if (upstreamAbort.signal.aborted || res.destroyed) return
      if (turn.failed && !streaming) {
        failed = turn.failed
        failureStatus = turn.httpStatus || 502
        llm.line(`← HTTP ${failureStatus}: ${failed}`)
        break
      }
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

      const outputs = []
      for (const call of turn.calls) {
        const parsedArgs = parseJsonText(call.arguments)
        const result = parsedArgs.ok ? runTool(call.name, parsedArgs.value) : { ok: false as const, output: 'Некорректный JSON' }
        await writeSse(res, { type: 'tool', name: call.name, args: preview(call.arguments), ok: result.ok, output: preview(result.output) })
        llm.tool(call.name, result.ok, result.output)
        outputs.push({ callId: call.callId, ok: result.ok, output: result.output })
      }
      transcript = [...transcript, ...turn.output, ...provider.toolOutputs(outputs)]

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

function normalizeKey(raw: string) {
  const trimmed = raw.trim()
  return trimmed.toLowerCase().startsWith('bearer ') ? trimmed.slice(7).trim() : trimmed
}

function readBody(req: IncomingMessage, max = MAX_BODY) {
  return new Promise<string>((resolveBody, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buffer.length
      if (size > max) {
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startServer()
}
