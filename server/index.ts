import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { modelHistory } from '../shared/history.ts'
import { isChatId, parseChatRequest, parseJsonText } from '../shared/json-schema.ts'
import type { ToolTrace, Usage } from '../shared/protocol.ts'
import { applyJson, type StreamFlags } from '../shared/sse.ts'
import { parsePersistedState, type Chat } from '../shared/state.ts'
import { beginTurn, chatDbPath, closeChatDb, deleteChat, insertChat, openChatDb, readChat, readChats, setActiveId, updateMessage } from './store.ts'
import { createLlmLog } from './llm-log.ts'
import { llmForModel, providerStatus } from './providers/index.ts'
import type { ChatInputMessage } from './providers/types.ts'
import { chatTools, noteNames, runTool } from './tools.ts'
import { apiErrorRecord, MAX_COST_TICKS } from './agent.ts'
import { createAgentRun, runAgentGraph } from './agent-graph.ts'
import { usageToApi } from './turn.ts'

const MAX_BODY = 2_000_000
const MAX_CHAT_BODY = 8_000_000
const PORT = Number(process.env.PORT) || 8787
const DIST = resolve('dist')

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
  if (path === '/api/active') {
    await handleActive(req, res)
    return
  }
  if (path.startsWith('/api/chats/')) {
    await handleOneChat(path.slice('/api/chats/'.length), req, res)
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
  if (req.method !== 'POST') {
    writeJson(res, 405, { error: { message: 'Метод не поддерживается' } })
    return
  }

  const raw = await readBody(req, MAX_CHAT_BODY)
  const parsed = parseJsonText(raw)
  if (!parsed.ok) {
    writeJson(res, 400, { error: { message: parsed.reason === 'truncated' ? 'JSON обрезан' : 'Некорректный JSON' } })
    return
  }
  const chat = parseIncomingChat(parsed.value)
  if (!chat) {
    writeJson(res, 400, { error: { message: 'Некорректный чат' } })
    return
  }
  if (!insertChat(chat)) {
    writeJson(res, 409, { error: { message: 'Чат уже есть' } })
    return
  }
  writeJson(res, 200, { ok: true })
}

async function handleActive(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    writeJson(res, 405, { error: { message: 'Метод не поддерживается' } })
    return
  }
  const raw = await readBody(req, 1000)
  const parsed = parseJsonText(raw)
  if (!parsed.ok) {
    writeJson(res, 400, { error: { message: parsed.reason === 'truncated' ? 'JSON обрезан' : 'Некорректный JSON' } })
    return
  }
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    writeJson(res, 400, { error: { message: 'Неверный тип «тело»' } })
    return
  }
  const activeId = 'activeId' in parsed.value ? parsed.value.activeId : undefined
  if (!isChatId(activeId)) {
    writeJson(res, 400, { error: { message: 'Недопустимое значение «activeId»' } })
    return
  }
  if (!setActiveId(activeId)) {
    writeJson(res, 404, { error: { message: 'Чат не найден' } })
    return
  }
  writeJson(res, 200, { ok: true })
}

async function handleOneChat(id: string, req: IncomingMessage, res: ServerResponse) {
  if (!isChatId(id)) {
    writeJson(res, 404, { error: { message: 'Чат не найден' } })
    return
  }
  if (req.method === 'DELETE') {
    if (!deleteChat(id)) {
      writeJson(res, 404, { error: { message: 'Чат не найден' } })
      return
    }
    writeJson(res, 200, { ok: true })
    return
  }
  writeJson(res, 405, { error: { message: 'Метод не поддерживается' } })
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

  const { chatId, model, reasoningEffort, maxTokens, content, userMessageId, assistantMessageId } = parsed.request
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

  const started = beginTurn({ chatId, content, userMessageId, assistantMessageId, model, maxTokens, reasoningEffort })
  if (!started.ok) {
    writeJson(res, started.reason === 'duplicate' ? 409 : 404, {
      error: { message: started.reason === 'duplicate' ? 'Сообщение уже есть' : 'Чат не найден' },
    })
    return
  }

  const chat = readChat(chatId)
  const history = modelHistory(chat?.messages ?? [])
  const latest = history[history.length - 1]
  if (!latest || latest.role !== 'user' || !latest.content.trim()) {
    writeJson(res, 400, { error: { message: 'Нет сообщения пользователя' } })
    return
  }

  const input: ChatInputMessage[] = [{ role: 'system', content: provider.systemPrompt }, ...history]
  const llm = createLlmLog(chatId)
  llm.line(`файл logs/${chatId}.log`)
  const offered = chatTools()
  const notes = noteNames()
  llm.line(`→ ${provider.id}/${model}, tools: ${offered.map((tool) => tool.name).join(', ')}`)
  llm.line(`заметки: ${notes.length ? notes.join(', ') : 'нет файлов'}`)
  llm.items(input)

  const upstreamAbort = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) upstreamAbort.abort()
  })

  let streaming = false
  let failure: string | null = null
  const spoken = createSpoken()
  const run = createAgentRun(model)
  let observed = run
  llm.line(`запрос ${run.requestId}, бюджет ${MAX_COST_TICKS} тиков`)

  const emit = (event: unknown) => {
    spoken.note(event)
    return writeSse(res, event)
  }

  try {
    const agent = await runAgentGraph(run, {
      signal: upstreamAbort.signal,
      observe: (state) => {
        observed = state
      },
      callModel: async (state) => {
        let startedStream = state.streaming
        const started = performance.now()
        const turn = await provider.streamTurn({
          apiKey,
          model,
          messages: input,
          transcript: state.transcript,
          tools: state.offerTools ? offered : [],
          maxTokens,
          reasoningEffort,
          signal: upstreamAbort.signal,
          beginStream: () => {
            startedStream = true
            if (streaming) return
            streaming = true
            res.statusCode = 200
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
            res.setHeader('Cache-Control', 'no-cache, no-transform')
            res.setHeader('X-Accel-Buffering', 'no')
          },
          emit,
        })
        return { turn, latencyMs: Math.round(performance.now() - started), streaming: startedStream }
      },
      runTool: (name, args) => runTool(name, args),
      toolOutputs: (results) => provider.toolOutputs(results),
      onRound: (step) => llm.line(`→ раунд ${step}`),
      onTurn: llm.turn,
      onTool: async (item) => {
        await emit({ type: 'tool', name: item.name, args: preview(item.arguments), ok: item.ok, output: preview(item.output) })
        llm.tool(item.name, item.ok, item.output)
      },
      onStep: (record) => llm.step(record),
      onHttpError: (status, message) => llm.line(`← HTTP ${status}: ${message}`),
    })
    if (!(agent.aborted || upstreamAbort.signal.aborted || res.destroyed)) {
      if (!streaming) {
        failure = agent.failed ?? 'Пустой ответ'
        writeJson(res, agent.failureStatus, { error: { message: failure } })
      } else if (agent.failed) {
        await emit({ type: 'error', error: { message: agent.failed }, ...(agent.usage ? { usage: usageToApi(agent.usage) } : {}) })
      } else {
        await emit({
          type: agent.noticeReason !== null ? 'response.incomplete' : 'response.completed',
          response: {
            status: agent.noticeReason !== null ? 'incomplete' : 'completed',
            ...(agent.noticeReason !== null ? { incomplete_details: agent.noticeReason ? { reason: agent.noticeReason } : {} } : {}),
            ...(agent.usage ? { usage: usageToApi(agent.usage) } : {}),
          },
        })
      }
      if (streaming && !res.writableEnded) res.end()
    }
  } catch (error) {
    if (!(upstreamAbort.signal.aborted || res.destroyed)) {
      const message = error instanceof Error ? error.message : 'Внутренняя ошибка'
      failure = message
      llm.step(apiErrorRecord(observed, null, observed.usage, message))
      if (!streaming) throw error
      await emit({ type: 'error', error: { message } })
      if (!res.writableEnded) res.end()
    }
  } finally {
    const stopped = upstreamAbort.signal.aborted
    const spokenMessage = spoken.snapshot(stopped)
    updateMessage(chatId, {
      id: assistantMessageId,
      role: 'assistant',
      content: spokenMessage.content,
      reasoning: spokenMessage.reasoning,
      tools: spokenMessage.tools,
      usage: spokenMessage.usage,
      error: stopped ? spokenMessage.error : (spokenMessage.error ?? failure),
      notice: spokenMessage.notice,
      stopped,
    })
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

function createSpoken() {
  const flags: StreamFlags = { sawTextDelta: false, sawReasoningDelta: false }
  let content = ''
  let reasoning = ''
  const tools: ToolTrace[] = []
  let usage: Usage | null = null
  let notice: string | null = null
  let error: string | null = null
  return {
    note(event: unknown) {
      applyJson(event, flags, {
        onText: (delta) => {
          content += delta
        },
        onReasoning: (delta) => {
          reasoning += delta
        },
        onUsage: (value) => {
          usage = value
        },
        onNotice: (value) => {
          notice = value
        },
        onTool: (tool) => {
          tools.push(tool)
        },
        onError: (message) => {
          error = message
        },
      })
    },
    snapshot(stopped: boolean) {
      return { content, reasoning, tools: [...tools], usage, notice, error, stopped }
    },
  }
}

function parseIncomingChat(value: unknown): Chat | null {
  const parsed = parsePersistedState({ chats: [value], activeId: '' })
  if (!parsed.ok || parsed.state.chats.length !== 1) return null
  return parsed.state.chats[0]
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
