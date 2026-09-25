import { parseJsonText } from './json-schema.ts'
import type { Usage } from './types.ts'

export type StreamFlags = {
  sawTextDelta: boolean
  sawReasoningDelta: boolean
}

export type StreamHandlers = {
  onText: (delta: string) => void
  onReasoning: (delta: string) => void
  onUsage: (usage: Usage) => void
  onError: (message: string) => void
  onNotice: (notice: string) => void
}

export function splitSse(buffer: string): { blocks: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n\n')
  const rest = parts.pop() ?? ''
  return { blocks: parts.filter((part) => part.trim().length > 0), rest }
}

export function applySseEvent(block: string, flags: StreamFlags, handlers: StreamHandlers) {
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  const data = dataLines.join('\n')
  if (!data || data === '[DONE]') return
  const parsed = parseJsonText(data)
  if (!parsed.ok) {
    handlers.onError(parsed.reason === 'truncated' ? 'JSON обрезан' : 'Не удалось разобрать ответ API')
    return
  }
  applyJson(parsed.value, flags, handlers)
}

export function applyJson(value: unknown, flags: StreamFlags, handlers: StreamHandlers) {
  const json = asRecord(value)
  if (!json) return

  const type = typeof json.type === 'string' ? json.type : ''

  if (type === 'error' || type === 'response.failed') {
    const response = asRecord(json.response)
    handlers.onError(errorText(json.error) ?? errorText(response?.error) ?? 'Запрос не выполнен')
    return
  }

  if (type === 'response.completed' || type === 'response.incomplete') {
    const response = asRecord(json.response) ?? json
    const usage = normalizeUsage(response.usage)
    if (usage) handlers.onUsage(usage)
    const extracted = extractOutput(response)
    if (!flags.sawReasoningDelta && extracted.reasoning) {
      flags.sawReasoningDelta = true
      handlers.onReasoning(extracted.reasoning)
    }
    if (!flags.sawTextDelta && extracted.text) {
      flags.sawTextDelta = true
      handlers.onText(extracted.text)
    }
    if (type === 'response.incomplete' || response.status === 'incomplete') {
      const details = asRecord(response.incomplete_details)
      const reason = typeof details?.reason === 'string' ? details.reason : undefined
      const notice = incompleteNotice(reason)
      if (notice) handlers.onNotice(notice)
    }
    return
  }

  if (type.endsWith('.delta')) {
    const delta = typeof json.delta === 'string' ? json.delta : ''
    if (!delta) return
    if (type.includes('reasoning')) {
      flags.sawReasoningDelta = true
      handlers.onReasoning(delta)
      return
    }
    flags.sawTextDelta = true
    handlers.onText(delta)
    return
  }

  if (Array.isArray(json.choices)) {
    const choice = asRecord(json.choices[0])
    const delta = asRecord(choice?.delta)
    if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) {
      flags.sawReasoningDelta = true
      handlers.onReasoning(delta.reasoning_content)
    }
    if (typeof delta?.content === 'string' && delta.content) {
      flags.sawTextDelta = true
      handlers.onText(delta.content)
    }
    const usage = normalizeUsage(json.usage)
    if (usage) handlers.onUsage(usage)
    return
  }

  if (json.output || json.usage || typeof json.output_text === 'string') {
    applyJson({ type: 'response.completed', response: json }, flags, handlers)
  }
}

export function normalizeUsage(value: unknown): Usage | null {
  const usage = asRecord(value)
  if (!usage) return null
  const input = asNumber(usage.input_tokens) ?? asNumber(usage.prompt_tokens)
  const output = asNumber(usage.output_tokens) ?? asNumber(usage.completion_tokens)
  const total = asNumber(usage.total_tokens)
  const outputDetails = asRecord(usage.output_tokens_details) ?? asRecord(usage.completion_tokens_details)
  const inputDetails = asRecord(usage.input_tokens_details) ?? asRecord(usage.prompt_tokens_details)
  const reasoning = outputDetails ? asNumber(outputDetails.reasoning_tokens) : null
  const cached = inputDetails ? asNumber(inputDetails.cached_tokens) : asNumber(usage.cached_tokens)
  const costTicks = asNumber(usage.cost_in_usd_ticks)
  if (input === null && output === null && total === null && reasoning === null && cached === null && costTicks === null) return null
  const inputTokens = input ?? 0
  const outputTokens = output ?? 0
  return {
    inputTokens,
    outputTokens,
    reasoningTokens: reasoning,
    cachedTokens: cached,
    totalTokens: total ?? inputTokens + outputTokens + (reasoning ?? 0),
    costTicks,
  }
}

export function errorText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  const record = asRecord(value)
  if (!record) return null
  if (typeof record.message === 'string' && record.message.trim()) return record.message.trim()
  if (record.error) return errorText(record.error)
  return null
}

function incompleteNotice(reason: string | undefined) {
  if (!reason) return 'Ответ обрезан'
  if (reason === 'max_output_tokens') return 'Достигнут лимит токенов'
  return `Ответ обрезан: ${reason}`
}

function extractOutput(response: Record<string, unknown>) {
  let text = typeof response.output_text === 'string' ? response.output_text : ''
  let reasoning = ''
  let messageText = ''
  if (Array.isArray(response.output)) {
    for (const item of response.output) {
      const record = asRecord(item)
      if (!record) continue
      if (record.type === 'reasoning') {
        reasoning += collectText(record.summary)
        reasoning += collectText(record.content)
      }
      if (record.type === 'message') {
        messageText += typeof record.content === 'string' ? record.content : collectText(record.content)
      }
    }
  }
  if (!text) text = messageText
  return { text, reasoning }
}

function collectText(value: unknown) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  let out = ''
  for (const part of value) {
    const record = asRecord(part)
    if (record && typeof record.text === 'string') out += record.text
  }
  return out
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return null
}

function asNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
