import { extractOutput, errorText, normalizeUsage, splitSse } from '../src/sse.ts'
import { parseJsonText } from '../src/json-schema.ts'
import type { Usage } from '../src/types.ts'

export type FunctionCall = {
  callId: string
  name: string
  arguments: string
}

export type TurnResult = {
  calls: FunctionCall[]
  output: unknown[]
  usage: Usage | null
  incompleteReason: string | null
  failed: string | null
}

type TurnState = {
  items: unknown[]
  usage: Usage | null
  incompleteReason: string | null
  failed: string | null
  sawText: boolean
  sawReasoning: boolean
}

export async function consumeTurn(
  body: ReadableStream<Uint8Array>,
  emit: (event: unknown) => Promise<void> | void,
  signal: AbortSignal,
): Promise<TurnResult> {
  const state: TurnState = {
    items: [],
    usage: null,
    incompleteReason: null,
    failed: null,
    sawText: false,
    sawReasoning: false,
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (!signal.aborted && !state.failed) {
      let done = false
      let value: Uint8Array | undefined
      try {
        const next = await reader.read()
        done = next.done
        value = next.value
      } catch (error) {
        if (signal.aborted) break
        throw error
      }
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const split = splitSse(buffer)
      buffer = split.rest
      for (const block of split.blocks) {
        await handleBlock(block, state, emit)
        if (state.failed) break
      }
    }
    buffer += decoder.decode()
    if (!state.failed && buffer.trim()) await handleBlock(buffer, state, emit)
  } finally {
    await reader.cancel().catch(() => undefined)
  }

  if (state.failed) {
    return { calls: [], output: [], usage: state.usage, incompleteReason: state.incompleteReason, failed: state.failed }
  }

  const calls = readCalls(state.items)
  if (!calls.ok) {
    return { calls: [], output: state.items, usage: state.usage, incompleteReason: state.incompleteReason, failed: calls.error }
  }
  return {
    calls: calls.calls,
    output: state.items,
    usage: state.usage,
    incompleteReason: state.incompleteReason,
    failed: null,
  }
}

export function addUsage(left: Usage | null, right: Usage | null): Usage | null {
  if (!left) return right
  if (!right) return left
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: addOptional(left.reasoningTokens, right.reasoningTokens),
    cachedTokens: addOptional(left.cachedTokens, right.cachedTokens),
    totalTokens: left.totalTokens + right.totalTokens,
    costTicks: addOptional(left.costTicks, right.costTicks),
  }
}

export function usageToApi(usage: Usage) {
  const payload: Record<string, unknown> = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
  }
  if (usage.reasoningTokens !== null) payload.output_tokens_details = { reasoning_tokens: usage.reasoningTokens }
  if (usage.cachedTokens !== null) payload.input_tokens_details = { cached_tokens: usage.cachedTokens }
  if (usage.costTicks !== null) payload.cost_in_usd_ticks = usage.costTicks
  return payload
}

async function handleBlock(block: string, state: TurnState, emit: (event: unknown) => Promise<void> | void) {
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
  await applyUpstream(parsed.value, state, emit)
}

async function applyUpstream(value: unknown, state: TurnState, emit: (event: unknown) => Promise<void> | void) {
  const json = asRecord(value)
  if (!json) return
  const type = typeof json.type === 'string' ? json.type : ''

  if (type === 'error' || type === 'response.failed') {
    const response = asRecord(json.response)
    state.failed = errorText(json.error) ?? errorText(response?.error) ?? 'Запрос не выполнен'
    return
  }

  if (type === 'response.output_item.done' && json.item) state.items.push(json.item)

  if (type === 'response.completed' || type === 'response.incomplete') {
    const response = asRecord(json.response) ?? json
    state.usage = normalizeUsage(response.usage) ?? state.usage
    if (Array.isArray(response.output)) state.items = [...response.output]
    const extracted = extractOutput(response)
    if (!state.sawReasoning && extracted.reasoning) {
      state.sawReasoning = true
      await emit({ type: 'response.reasoning_summary_text.delta', delta: extracted.reasoning })
    }
    if (!state.sawText && extracted.text) {
      state.sawText = true
      await emit({ type: 'response.output_text.delta', delta: extracted.text })
    }
    if (type === 'response.incomplete' || response.status === 'incomplete') {
      const details = asRecord(response.incomplete_details)
      state.incompleteReason = typeof details?.reason === 'string' ? details.reason : ''
    }
    return
  }

  if (type.includes('function_call') || type.includes('arguments')) return

  if (type.endsWith('.delta')) {
    const delta = typeof json.delta === 'string' ? json.delta : ''
    if (!delta) return
    if (type.includes('reasoning')) state.sawReasoning = true
    else state.sawText = true
    await emit(json)
  }
}

function readCalls(output: unknown[]): { ok: true; calls: FunctionCall[] } | { ok: false; error: string } {
  const calls: FunctionCall[] = []
  for (const item of output) {
    const record = asRecord(item)
    if (!record || record.type !== 'function_call') continue
    if (typeof record.name !== 'string' || typeof record.call_id !== 'string' || !record.call_id) {
      return { ok: false, error: 'Вызов инструмента без идентификатора' }
    }
    const args = typeof record.arguments === 'string' ? record.arguments : JSON.stringify(record.arguments ?? {})
    calls.push({ callId: record.call_id, name: record.name, arguments: args })
  }
  return { ok: true, calls }
}

function addOptional(left: number | null, right: number | null) {
  if (left === null && right === null) return null
  return (left ?? 0) + (right ?? 0)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return null
}
