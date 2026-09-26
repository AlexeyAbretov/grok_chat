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
      messages: [...request.messages, ...request.transcript],
      tools: chatTools(request.tools),
      tool_choice: 'auto',
      max_tokens: request.maxTokens,
      reasoning_effort: effort,
      google: { thinking_config: { include_thoughts: true, thinking_level: effort } },
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
}

type GeminiState = {
  text: string
  calls: Map<number, GeminiCall>
  usage: Usage | null
  incompleteReason: string | null
  failed: string | null
}

async function readGeminiStream(body: ReadableStream<Uint8Array>, request: ProviderTurnRequest): Promise<StreamTurnResult> {
  const state: GeminiState = {
    text: '',
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
  const calls = finishCalls(state.calls)
  if (!calls.ok) return { ...emptyTurn(calls.error, 200), usage: state.usage, incompleteReason: state.incompleteReason }
  return {
    calls: calls.calls,
    output: assistantMessage(state.text, calls.calls),
    usage: state.usage,
    incompleteReason: state.incompleteReason,
    failed: null,
    httpStatus: 200,
  }
}

function assistantMessage(text: string, calls: FunctionCall[]) {
  if (calls.length === 0) return []
  return [
    {
      role: 'assistant',
      content: text || null,
      tool_calls: calls.map((call) => ({
        id: call.callId,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    },
  ]
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
    state.text += content
    await request.emit({ type: 'response.output_text.delta', delta: content })
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
    const current = calls.get(index) ?? { id: '', name: '', arguments: '' }
    if (typeof record.id === 'string' && record.id) current.id = record.id
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

function reasoningText(delta: Record<string, unknown>) {
  if (typeof delta.reasoning_content === 'string') return delta.reasoning_content
  if (typeof delta.reasoning === 'string') return delta.reasoning
  return ''
}

function finishCalls(calls: Map<number, GeminiCall>): { ok: true; calls: FunctionCall[] } | { ok: false; error: string } {
  const ordered = [...calls.entries()].sort((left, right) => left[0] - right[0]).map((entry) => entry[1])
  const result: FunctionCall[] = []
  for (const call of ordered) {
    if (!call.id || !call.name) return { ok: false, error: 'Вызов инструмента без идентификатора' }
    result.push({ callId: call.id, name: call.name, arguments: call.arguments || '{}' })
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
