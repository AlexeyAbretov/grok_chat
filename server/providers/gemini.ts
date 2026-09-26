import { parseJsonText } from '../../shared/json-schema.ts'
import type { Effort, Usage } from '../../shared/protocol.ts'
import { errorText, normalizeUsage, splitSse } from '../../shared/sse.ts'
import type { FunctionCall } from '../turn.ts'
import {
  TOOL_INSTRUCTIONS,
  type LlmProvider,
  type ProviderTurnRequest,
  type StreamTurnResult,
  type ToolExchange,
} from './types.ts'

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'

export const geminiProvider: LlmProvider = {
  id: 'gemini',
  label: 'Gemini',
  envVar: 'GEMINI_API_KEY',
  reasoning: true,
  models: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite'],
  systemPrompt: `You are Gemini, a helpful assistant. ${TOOL_INSTRUCTIONS}`,
  streamTurn,
  toolOutputs,
}

function toolOutputs(results: readonly ToolExchange[]) {
  return results.map((result) => ({
    role: 'tool',
    tool_call_id: result.callId,
    content: result.ok ? result.output : JSON.stringify({ error: result.output }),
  }))
}

async function streamTurn(request: ProviderTurnRequest): Promise<StreamTurnResult> {
  const effort = geminiEffort(request.reasoningEffort)
  const upstream = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${request.apiKey}`,
    },
    body: JSON.stringify({
      model: request.model,
      messages: joinGeminiMessages([...request.messages, ...request.transcript]),
      tools: chatTools(request.tools),
      tool_choice: 'auto',
      max_tokens: request.maxTokens,
      stream_options: { include_usage: true },
      extra_body: {
        google: { thinking_config: { include_thoughts: true, thinking_level: effort } },
      },
      stream: true,
    }),
    signal: request.signal,
  })

  if (!upstream.ok || !upstream.body) {
    const text = upstream.ok ? '' : await upstream.text()
    return emptyTurn(readableUpstreamError(upstream.status, text), upstream.ok ? 502 : upstream.status || 502)
  }

  request.beginStream()
  return readGeminiStream(upstream.body, request)
}

export function joinGeminiMessages(messages: readonly unknown[]) {
  const joined: unknown[] = []
  for (const message of messages) {
    const current = asRecord(message)
    const previous = asRecord(joined.at(-1))
    if (
      current &&
      previous &&
      typeof current.role === 'string' &&
      current.role === previous.role &&
      typeof current.content === 'string' &&
      typeof previous.content === 'string'
    ) {
      joined[joined.length - 1] = { ...previous, content: `${previous.content}\n${current.content}` }
      continue
    }
    joined.push(message)
  }
  return joined
}

function chatTools(tools: readonly object[]) {
  return tools.map((tool) => {
    const record = asRecord(tool)
    return {
      type: 'function',
      function: {
        name: typeof record?.name === 'string' ? record.name : '',
        description: typeof record?.description === 'string' ? record.description : '',
        parameters: record?.parameters ?? { type: 'object', properties: {} },
      },
    }
  })
}

function geminiEffort(effort: Effort) {
  return effort === 'xhigh' ? 'high' : effort
}

type GeminiCall = {
  id: string
  name: string
  arguments: string
  thoughtSignature: string
}

type GeminiTextState = {
  mode: 'answer' | 'thought'
  pending: string
}

type GeminiState = {
  text: string
  shown: number
  textState: GeminiTextState
  calls: Map<number, GeminiCall>
  usage: Usage | null
  incompleteReason: string | null
  failed: string | null
}

async function readGeminiStream(body: ReadableStream<Uint8Array>, request: ProviderTurnRequest): Promise<StreamTurnResult> {
  const state: GeminiState = {
    text: '',
    shown: 0,
    textState: { mode: 'answer', pending: '' },
    calls: new Map(),
    usage: null,
    incompleteReason: null,
    failed: null,
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (!request.signal.aborted && !state.failed) {
      let done = false
      let value: Uint8Array | undefined
      try {
        const next = await reader.read()
        done = next.done
        value = next.value
      } catch (error) {
        if (request.signal.aborted) break
        throw error
      }
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const split = splitSse(buffer)
      buffer = split.rest
      for (const block of split.blocks) {
        await applyBlock(block, state, request)
        if (state.failed) break
      }
    }
    buffer += decoder.decode()
    if (!state.failed && buffer.trim()) await applyBlock(buffer, state, request)
  } finally {
    await reader.cancel().catch(() => undefined)
  }

  if (state.failed) return { ...emptyTurn(state.failed, 200), usage: state.usage, incompleteReason: state.incompleteReason }
  const tail = flushGeminiText(state.textState)
  if (tail.answer) state.text += tail.answer
  if (tail.thought) await request.emit({ type: 'response.reasoning_summary_text.delta', delta: tail.thought })
  const ordered = orderedCalls(state.calls)
  const textCall = ordered.length === 0 ? geminiTextCall(state.text) : null
  if (textCall) {
    ordered.push({
      id: 'call_text',
      name: textCall.name,
      arguments: textCall.arguments,
      thoughtSignature: 'skip_thought_signature_validator',
    })
    state.text = ''
    state.shown = 0
  } else {
    await emitAnswer(state, request, true)
  }
  const calls = finishCalls(ordered)
  if (!calls.ok) return { ...emptyTurn(calls.error, 200), usage: state.usage, incompleteReason: state.incompleteReason }
  return {
    calls: calls.calls,
    output: assistantMessage(state.text, ordered),
    usage: state.usage,
    incompleteReason: state.incompleteReason,
    failed: null,
    httpStatus: 200,
  }
}

function assistantMessage(text: string, calls: readonly GeminiCall[]) {
  if (calls.length === 0) return text ? [{ role: 'assistant', content: text }] : []
  return [
    {
      role: 'assistant',
      content: text || null,
      tool_calls: calls.map((call) => geminiToolCall(call)),
    },
  ]
}

export function geminiToolCall(call: GeminiCall) {
  const replay: Record<string, unknown> = {
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: call.arguments },
  }
  if (call.thoughtSignature) {
    replay.extra_content = { google: { thought_signature: call.thoughtSignature } }
  }
  return replay
}

export function geminiThoughtSignature(value: unknown) {
  const record = asRecord(value)
  const extra = asRecord(record?.extra_content)
  const google = asRecord(extra?.google)
  return typeof google?.thought_signature === 'string' ? google.thought_signature : ''
}

async function applyBlock(block: string, state: GeminiState, request: ProviderTurnRequest) {
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  const data = dataLines.join('\n')
  if (!data || data === '[DONE]') return
  const parsed = parseJsonText(data)
  if (!parsed.ok) {
    state.failed = parsed.reason === 'truncated' ? 'JSON обрезан' : 'Не удалось разобрать ответ API'
    return
  }
  await applyChunk(parsed.value, state, request)
}

async function applyChunk(value: unknown, state: GeminiState, request: ProviderTurnRequest) {
  const json = asRecord(value)
  if (!json) return
  const failed = errorText(json.error)
  if (failed) {
    state.failed = failed
    return
  }

  state.usage = normalizeUsage(json.usage) ?? state.usage
  const choice = asRecord(asArray(json.choices)[0])
  if (!choice) return
  const finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : ''
  if (finish === 'length') state.incompleteReason = 'max_output_tokens'

  const delta = asRecord(choice.delta)
  const message = !delta && state.text.length === 0 && state.calls.size === 0 ? asRecord(choice.message) : null
  const piece = delta ?? message
  if (!piece) return
  const content = typeof piece.content === 'string' ? piece.content : ''
  if (content) {
    const parts = consumeGeminiText(state.textState, content)
    if (parts.answer) {
      state.text += parts.answer
      await emitAnswer(state, request, false)
    }
    if (parts.thought) await request.emit({ type: 'response.reasoning_summary_text.delta', delta: parts.thought })
  }
  const reasoning = reasoningText(piece)
  if (reasoning) await request.emit({ type: 'response.reasoning_summary_text.delta', delta: reasoning })
  appendToolCalls(piece.tool_calls, state.calls)
}

function appendToolCalls(value: unknown, calls: Map<number, GeminiCall>) {
  if (!Array.isArray(value)) return
  for (const item of value) {
    const record = asRecord(item)
    if (!record) continue
    const index = typeof record.index === 'number' ? record.index : lastIndex(calls)
    const current = calls.get(index) ?? { id: '', name: '', arguments: '', thoughtSignature: '' }
    if (typeof record.id === 'string' && record.id) current.id = record.id
    const signature = geminiThoughtSignature(record)
    if (signature) current.thoughtSignature = signature
    const fn = asRecord(record.function)
    if (typeof fn?.name === 'string') current.name += fn.name
    if (typeof fn?.arguments === 'string') current.arguments += fn.arguments
    calls.set(index, current)
  }
}

function lastIndex(calls: Map<number, GeminiCall>) {
  if (calls.size === 0) return 0
  return Math.max(...calls.keys())
}

async function emitAnswer(state: GeminiState, request: ProviderTurnRequest, done: boolean) {
  if (!done && mightBeTextCall(state.text)) return
  const rest = state.text.slice(state.shown)
  state.shown = state.text.length
  if (rest) await request.emit({ type: 'response.output_text.delta', delta: rest })
}

function mightBeTextCall(text: string) {
  const trimmed = text.trimStart()
  if (!trimmed) return false
  const prefix = '<call:default_api:'
  return (prefix.startsWith(trimmed) && trimmed.length <= prefix.length) || trimmed.startsWith(prefix)
}

const THOUGHT_OPEN = '<thought>'
const THOUGHT_CLOSE = '</thought>'

export function consumeGeminiText(state: GeminiTextState, chunk: string) {
  state.pending += chunk
  let answer = ''
  let thought = ''
  while (state.pending) {
    const tag = state.mode === 'answer' ? THOUGHT_OPEN : THOUGHT_CLOSE
    const at = state.pending.indexOf('<')
    if (at < 0) {
      if (state.mode === 'answer') answer += state.pending
      else thought += state.pending
      state.pending = ''
      break
    }
    const tail = state.pending.slice(at)
    if (tag.startsWith(tail) && tail.length < tag.length) {
      if (state.mode === 'answer') answer += state.pending.slice(0, at)
      else thought += state.pending.slice(0, at)
      state.pending = tail
      break
    }
    if (tail.startsWith(tag)) {
      if (state.mode === 'answer') answer += state.pending.slice(0, at)
      else thought += state.pending.slice(0, at)
      state.pending = tail.slice(tag.length)
      state.mode = state.mode === 'answer' ? 'thought' : 'answer'
      continue
    }
    if (state.mode === 'answer') answer += state.pending.slice(0, at + 1)
    else thought += state.pending.slice(0, at + 1)
    state.pending = state.pending.slice(at + 1)
  }
  return { answer, thought }
}

export function flushGeminiText(state: GeminiTextState) {
  const text = state.pending
  state.pending = ''
  if (!text) return { answer: '', thought: '' }
  return state.mode === 'thought' ? { answer: '', thought: text } : { answer: text, thought: '' }
}

export function geminiTextCall(text: string): { name: string; arguments: string } | null {
  const match = text.trim().match(/^<call:default_api:([A-Za-z0-9_]+)\{([\s\S]*)$/)
  if (!match) return null
  let body = match[2].trim()
  if (body.endsWith('>')) body = body.slice(0, -1).trim()
  if (body.endsWith('}')) body = body.slice(0, -1)
  const args = looseArgs(body)
  if (!args) return null
  return { name: match[1], arguments: JSON.stringify(args) }
}

function looseArgs(body: string) {
  const wrapped = `{${body}}`
  try {
    const parsed: unknown = JSON.parse(wrapped)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // Gemini sometimes writes {a:1,b:1,op:add} instead of JSON.
  }
  const args: Record<string, unknown> = {}
  if (!body.trim()) return null
  for (const part of body.split(',')) {
    const eq = part.indexOf(':')
    if (eq <= 0) return null
    const key = part.slice(0, eq).trim()
    const raw = part.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !raw) return null
    args[key] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw
  }
  return args
}

function reasoningText(delta: Record<string, unknown>) {
  if (typeof delta.reasoning_content === 'string') return delta.reasoning_content
  if (typeof delta.reasoning === 'string') return delta.reasoning
  return ''
}

function orderedCalls(calls: Map<number, GeminiCall>) {
  return [...calls.entries()].sort((left, right) => left[0] - right[0]).map((entry) => entry[1])
}

function finishCalls(calls: readonly GeminiCall[]): { ok: true; calls: FunctionCall[] } | { ok: false; error: string } {
  const result: FunctionCall[] = []
  for (const call of calls) {
    if (!call.id || !call.name) return { ok: false, error: 'Вызов инструмента без идентификатора' }
    result.push({ callId: call.id, name: call.name, arguments: call.arguments })
  }
  return { ok: true, calls: result }
}

function emptyTurn(failed: string, httpStatus: number): StreamTurnResult {
  return { calls: [], output: [], usage: null, incompleteReason: null, failed, httpStatus }
}

function readableUpstreamError(status: number, text: string) {
  const trimmed = text.trim()
  if (/not available in your region|User location is not supported/i.test(trimmed)) return 'Сервис Gemini недоступен из этого региона.'
  const message = errorText(parseJson(trimmed))
  if (message) return message
  const plain = trimmed
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.slice(0, 300) || `Gemini вернул ${status}`
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : []
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return null
}
