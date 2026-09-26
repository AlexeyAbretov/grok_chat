import { parsePersistedState, type PersistedState } from '../shared/state.ts'
import { applyJson, applySseEvent, errorText, splitSse, type StreamFlags, type StreamHandlers } from '../shared/sse.ts'
import { clearLegacyState, clearStoredApiKeys, createChat, readLegacyState } from './storage.ts'
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

let chatsBootstrap: Promise<PersistedState> | null = null
let saveChain: Promise<void> = Promise.resolve()
let savedBody = ''

export function resetChatsBootstrap() {
  chatsBootstrap = null
}

export function bootstrapChats() {
  chatsBootstrap ??= loadChats().catch((error: unknown) => {
    chatsBootstrap = null
    throw error
  })
  return chatsBootstrap
}

async function loadChats(): Promise<PersistedState> {
  clearStoredApiKeys()
  const remote = await fetchChats()
  const legacy = readLegacyState()
  if (legacy) {
    const merged = mergeLegacy(remote, legacy)
    if (merged) await saveChats(merged)
    clearLegacyState()
    if (merged) return merged
    if (remote.chats.length > 0) return remote
  }
  if (remote.chats.length > 0) return remote
  const chat = createChat()
  const fresh = { chats: [chat], activeId: chat.id }
  await saveChats(fresh)
  return fresh
}

function mergeLegacy(remote: PersistedState, legacy: PersistedState): PersistedState | null {
  const known = new Set(remote.chats.map((chat) => chat.id))
  const extra = legacy.chats.filter((chat) => !known.has(chat.id))
  if (remote.chats.length === 0) return legacy
  if (extra.length === 0) return null
  const activeId = extra.some((chat) => chat.id === legacy.activeId) ? legacy.activeId : remote.activeId
  return { chats: [...extra, ...remote.chats], activeId }
}

async function fetchChats(): Promise<PersistedState> {
  const response = await fetch('/api/chats')
  if (!response.ok) throw new Error('Не удалось загрузить чаты')
  const parsed = parsePersistedState(await response.json())
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.state
}

export function saveChats(state: PersistedState) {
  const body = JSON.stringify(state)
  if (body === savedBody) return Promise.resolve()
  const run = saveChain.then(async () => {
    if (body === savedBody) return
    const response = await fetch('/api/chats', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: body.length <= 60_000,
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
    savedBody = body
  })
  saveChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
