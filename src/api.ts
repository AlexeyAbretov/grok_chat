import { applyJson, applySseEvent, errorText, splitSse, type StreamFlags, type StreamHandlers } from '../shared/sse.ts'
import type { Effort, ProviderInfo } from './types.ts'

export type ChatTurn = {
  role: 'user' | 'assistant'
  content: string
}

type StreamChatOptions = Omit<StreamHandlers, 'onError'> & {
  chatId: string
  model: string
  maxTokens: number
  reasoningEffort: Effort
  messages: ChatTurn[]
  signal: AbortSignal
}

export async function fetchProviders(): Promise<ProviderInfo[]> {
  const response = await fetch('/api/status')
  if (!response.ok) return []
  const data: unknown = await response.json()
  if (!data || typeof data !== 'object' || !('providers' in data) || !Array.isArray(data.providers)) return []
  const providers: ProviderInfo[] = []
  for (const item of data.providers) {
    const provider = readProvider(item)
    if (provider) providers.push(provider)
  }
  return providers
}

function readProvider(value: unknown): ProviderInfo | null {
  if (!value || typeof value !== 'object') return null
  const provider = value as Partial<ProviderInfo>
  if (typeof provider.id !== 'string' || !provider.id || typeof provider.label !== 'string') return null
  if (!Array.isArray(provider.models) || provider.models.some((model) => typeof model !== 'string' || !model)) return null
  return {
    id: provider.id,
    label: provider.label,
    reasoning: provider.reasoning === true,
    models: provider.models,
  }
}

export async function streamChat(options: StreamChatOptions) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chatId: options.chatId,
      model: options.model,
      maxTokens: options.maxTokens,
      reasoningEffort: options.reasoningEffort,
      messages: options.messages,
    }),
    signal: options.signal,
  })

  if (!response.ok) {
    let message = `Ошибка ${response.status}`
    try {
      message = errorText(await response.json()) ?? message
    } catch {
      // The body was not JSON; the status line is enough.
    }
    throw new Error(message)
  }

  const flags: StreamFlags = { sawTextDelta: false, sawReasoningDelta: false }
  let fatal: string | null = null
  const handlers: StreamHandlers = {
    onText: options.onText,
    onReasoning: options.onReasoning,
    onUsage: options.onUsage,
    onNotice: options.onNotice,
    onTool: options.onTool,
    onError: (message) => {
      fatal = message
    },
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    applyJson(await response.json(), flags, handlers)
    if (fatal) throw new Error(fatal)
    return
  }

  if (!response.body) throw new Error('Пустой ответ')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const split = splitSse(buffer)
    buffer = split.rest
    for (const block of split.blocks) {
      applySseEvent(block, flags, handlers)
      if (fatal) throw new Error(fatal)
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) applySseEvent(buffer, flags, handlers)
  if (fatal) throw new Error(fatal)
}

export function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}
