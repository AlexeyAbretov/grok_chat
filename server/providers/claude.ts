import { parseJsonText } from '../../shared/json-schema.ts'
import type { Usage } from '../../shared/protocol.ts'
import { errorText, splitSse } from '../../shared/sse.ts'
import type { FunctionCall } from '../turn.ts'
import {
  TOOL_INSTRUCTIONS,
  type ChatInputMessage,
  type LlmProvider,
  type ProviderTurnRequest,
  type StreamTurnResult,
  type ToolExchange,
} from './types.ts'

const ENDPOINT = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

export const claudeProvider: LlmProvider = {
  id: 'anthropic',
  label: 'Claude Opus',
  envVar: 'ANTHROPIC_API_KEY',
  reasoning: true,
  models: ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7'],
  systemPrompt: `You are Claude, a helpful assistant. ${TOOL_INSTRUCTIONS}`,
  streamTurn,
  toolOutputs,
}

function toolOutputs(results: readonly ToolExchange[]) {
  return [
    {
      role: 'user',
      content: results.map((result) => ({
        type: 'tool_result',
        tool_use_id: result.callId,
        content: result.output,
        is_error: !result.ok,
      })),
    },
  ]
}

async function streamTurn(request: ProviderTurnRequest): Promise<StreamTurnResult> {
  const shaped = claudeRequest(request.messages, request.transcript)
  const upstream = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': request.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: request.model,
      max_tokens: request.maxTokens,
      system: shaped.system,
      messages: shaped.messages,
      tools: claudeTools(request.tools),
      thinking: { type: 'adaptive' },
      output_config: { effort: request.reasoningEffort },
      stream: true,
    }),
    signal: request.signal,
  })

  if (!upstream.ok || !upstream.body) {
    const text = upstream.ok ? '' : await upstream.text()
    return emptyTurn(readableUpstreamError(upstream.status, text), upstream.ok ? 502 : upstream.status || 502)
  }

  request.beginStream()
  return readClaudeStream(upstream.body, request)
}

function claudeRequest(messages: readonly ChatInputMessage[], transcript: readonly unknown[]) {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')
  const history = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({ role: message.role, content: message.content }))
  return { system, messages: [...history, ...transcript] }
}

function claudeTools(tools: readonly object[]) {
  return tools.map((tool) => {
    const record = asRecord(tool)
    return {
      name: typeof record?.name === 'string' ? record.name : '',
      description: typeof record?.description === 'string' ? record.description : '',
      input_schema: record?.parameters ?? { type: 'object', properties: {} },
    }
  })
}

type ClaudeState = {
  blocks: Map<number, Record<string, unknown>>
  inputTokens: number
  outputTokens: number
  cachedTokens: number | null
  stopReason: string
  failed: string | null
}

async function readClaudeStream(body: ReadableStream<Uint8Array>, request: ProviderTurnRequest): Promise<StreamTurnResult> {
  const state: ClaudeState = {
    blocks: new Map(),
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: null,
    stopReason: '',
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

  if (state.failed) return { ...emptyTurn(state.failed, 200), usage: usageOf(state) }
  const built = buildAssistant(state.blocks)
  if (!built.ok) return { ...emptyTurn(built.error, 200), usage: usageOf(state) }
  return {
    calls: built.calls,
    output: built.content.length > 0 ? [{ role: 'assistant', content: built.content }] : [],
    usage: usageOf(state),
    incompleteReason: state.stopReason === 'max_tokens' ? 'max_output_tokens' : null,
    failed: state.stopReason === 'refusal' ? 'Модель отказала в ответе' : null,
    httpStatus: 200,
  }
}

async function applyBlock(block: string, state: ClaudeState, request: ProviderTurnRequest) {
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
  await applyEvent(parsed.value, state, request)
}

async function applyEvent(value: unknown, state: ClaudeState, request: ProviderTurnRequest) {
  const json = asRecord(value)
  if (!json) return
  const type = typeof json.type === 'string' ? json.type : ''
  if (type === 'error') {
    state.failed = errorText(json.error) ?? 'Запрос не выполнен'
    return
  }

  if (type === 'message_start') {
    const message = asRecord(json.message)
    const usage = asRecord(message?.usage)
    const input = asNumber(usage?.input_tokens)
    const cached = asNumber(usage?.cache_read_input_tokens)
    if (input !== null) state.inputTokens = input
    if (cached !== null) state.cachedTokens = cached
    return
  }

  if (type === 'message_delta') {
    const delta = asRecord(json.delta)
    const usage = asRecord(json.usage)
    if (typeof delta?.stop_reason === 'string') state.stopReason = delta.stop_reason
    const output = asNumber(usage?.output_tokens)
    if (output !== null) state.outputTokens = output
    return
  }

  if (type === 'content_block_start') {
    const index = typeof json.index === 'number' ? json.index : state.blocks.size
    const block = asRecord(json.content_block)
    if (block) state.blocks.set(index, { ...block })
    return
  }

  if (type !== 'content_block_delta') return
  const index = typeof json.index === 'number' ? json.index : 0
  const block = state.blocks.get(index)
  const delta = asRecord(json.delta)
  if (!block || !delta) return
  const deltaType = typeof delta.type === 'string' ? delta.type : ''

  if (deltaType === 'text_delta' && typeof delta.text === 'string' && delta.text) {
    block.text = `${textOf(block.text)}${delta.text}`
    await request.emit({ type: 'response.output_text.delta', delta: delta.text })
    return
  }
  if (deltaType === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
    block.thinking = `${textOf(block.thinking)}${delta.thinking}`
    await request.emit({ type: 'response.reasoning_summary_text.delta', delta: delta.thinking })
    return
  }
  if (deltaType === 'signature_delta' && typeof delta.signature === 'string') {
    block.signature = `${textOf(block.signature)}${delta.signature}`
    return
  }
  if (deltaType === 'input_json_delta' && typeof delta.partial_json === 'string') {
    block.partial_json = `${textOf(block.partial_json)}${delta.partial_json}`
  }
}

function buildAssistant(blocks: Map<number, Record<string, unknown>>): { ok: true; content: unknown[]; calls: FunctionCall[] } | { ok: false; error: string } {
  const content: unknown[] = []
  const calls: FunctionCall[] = []
  const ordered = [...blocks.entries()].sort((left, right) => left[0] - right[0]).map((entry) => entry[1])
  for (const block of ordered) {
    const type = typeof block.type === 'string' ? block.type : ''
    if (type === 'text') {
      const text = textOf(block.text)
      if (text) content.push({ type: 'text', text })
      continue
    }
    if (type === 'thinking') {
      content.push({ type: 'thinking', thinking: textOf(block.thinking), signature: textOf(block.signature) })
      continue
    }
    if (type === 'tool_use') {
      const id = typeof block.id === 'string' ? block.id : ''
      const name = typeof block.name === 'string' ? block.name : ''
      if (!id || !name) return { ok: false, error: 'Вызов инструмента без идентификатора' }
      const raw = textOf(block.partial_json) || '{}'
      let input: unknown = {}
      try {
        input = JSON.parse(raw)
      } catch {
        input = {}
      }
      content.push({ type: 'tool_use', id, name, input })
      calls.push({ callId: id, name, arguments: raw })
      continue
    }
    if (type) content.push(replayBlock(block))
  }
  return { ok: true, content, calls }
}

function replayBlock(block: Record<string, unknown>) {
  const copy = { ...block }
  delete copy.partial_json
  return copy
}

function usageOf(state: ClaudeState): Usage | null {
  if (state.inputTokens === 0 && state.outputTokens === 0 && state.cachedTokens === null) return null
  return {
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    reasoningTokens: null,
    cachedTokens: state.cachedTokens,
    totalTokens: state.inputTokens + state.outputTokens,
    costTicks: null,
  }
}

function emptyTurn(failed: string, httpStatus: number): StreamTurnResult {
  return { calls: [], output: [], usage: null, incompleteReason: null, failed, httpStatus }
}

function readableUpstreamError(status: number, text: string) {
  const trimmed = text.trim()
  const message = errorText(parseJson(trimmed))
  if (message) return message
  const plain = trimmed
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.slice(0, 300) || `Claude вернул ${status}`
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function textOf(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return null
}
