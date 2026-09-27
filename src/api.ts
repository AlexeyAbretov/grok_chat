import { parsePersistedState, type Chat, type PersistedState } from '../shared/state.ts'
import { applyJson, applySseEvent, errorText, splitSse, type StreamFlags, type StreamHandlers } from '../shared/sse.ts'
import { clearLegacyState, clearStoredApiKeys, createChat, readLegacyState } from './storage.ts'
import type { Effort, ProviderInfo } from './types.ts'

type StreamChatOptions = Omit<StreamHandlers, 'onError'> & {
  chatId: string
  model: string
  maxTokens: number
  reasoningEffort: Effort
  content: string
  userMessageId: string
  assistantMessageId: string
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
      content: options.content,
      userMessageId: options.userMessageId,
      assistantMessageId: options.assistantMessageId,
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
let writeChain: Promise<void> = Promise.resolve()

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
  let remote = await fetchChats()
  const legacy = readLegacyState()
  if (legacy) {
    const known = new Set(remote.chats.map((chat) => chat.id))
    const imported = remote.chats.length === 0 ? legacy.chats : legacy.chats.filter((chat) => !known.has(chat.id))
    for (let index = imported.length - 1; index >= 0; index -= 1) {
      const chat = imported[index]
      if (chat) await createRemoteChat(chat)
    }
    const activeId = imported.some((chat) => chat.id === legacy.activeId) ? legacy.activeId : remote.activeId
    if (activeId) await focusChat(activeId)
    clearLegacyState()
    remote = await fetchChats()
  }
  if (remote.chats.length > 0) return remote
  const chat = createChat()
  await createRemoteChat(chat)
  await focusChat(chat.id)
  return { chats: [chat], activeId: chat.id }
}

async function fetchChats(): Promise<PersistedState> {
  const response = await fetch('/api/chats')
  if (!response.ok) throw new Error('Не удалось загрузить чаты')
  const parsed = parsePersistedState(await response.json())
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.state
}

export function settleChatWrites() {
  return writeChain
}

export function createRemoteChat(chat: Chat) {
  return enqueue(() => sendJson('/api/chats', 'POST', chat))
}

export function deleteRemoteChat(id: string) {
  return enqueue(() => sendJson(`/api/chats/${id}`, 'DELETE'))
}

export function focusChat(id: string) {
  return enqueue(() => sendJson('/api/active', 'POST', { activeId: id }))
}

function enqueue(task: () => Promise<void>) {
  const run = writeChain.then(task, task)
  writeChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function sendJson(url: string, method: string, body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (response.ok) return
  let message = `Ошибка ${response.status}`
  try {
    message = errorText(await response.json()) ?? message
  } catch {
    // The body was not JSON; the status line is enough.
  }
  throw new Error(message)
}
