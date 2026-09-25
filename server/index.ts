import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseChatRequest } from '../src/json-schema.ts'

const MAX_BODY = 2_000_000
const PORT = Number(process.env.PORT) || 8787
const DIST = resolve('dist')

const SYSTEM_PROMPT = 'You are Grok, a helpful assistant. Reply in the same language the user writes in.'

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

  const { model, reasoningEffort, maxTokens, messages } = parsed.request
  const input = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages]

  const upstreamAbort = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) upstreamAbort.abort()
  })

  try {
    const upstream = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input,
        max_output_tokens: maxTokens,
        reasoning: { effort: reasoningEffort },
        stream: true,
        store: false,
      }),
      signal: upstreamAbort.signal,
    })

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text()
      writeJson(res, upstream.status || 502, { error: { message: readableUpstreamError(upstream.status, text) } })
      return
    }

    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('X-Accel-Buffering', 'no')

    const reader = upstream.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (res.destroyed) {
        upstreamAbort.abort()
        return
      }
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolveDrain) => res.once('drain', resolveDrain))
      }
    }
    res.end()
  } catch (error) {
    if (upstreamAbort.signal.aborted || res.destroyed) return
    throw error
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
