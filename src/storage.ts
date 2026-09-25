import {
  EFFORTS,
  MAX_TOKEN_OPTIONS,
  MODELS,
  type Chat,
  type ChatMessage,
  type Effort,
  type ModelId,
  type PersistedState,
} from './types.ts'

const STORAGE_KEY = 'grok-chat.v1'
export const API_KEY_STORAGE = 'grok-chat.api-key'

export function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return freshState()
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return freshState()
    const record = parsed as { chats?: unknown; activeId?: unknown }
    if (!Array.isArray(record.chats)) return freshState()
    const chats = record.chats.map(normalizeChat).filter((chat) => chat !== null)
    if (chats.length === 0) return freshState()
    const activeId = typeof record.activeId === 'string' && chats.some((chat) => chat.id === record.activeId)
      ? record.activeId
      : chats[0].id
    return { chats, activeId }
  } catch {
    return freshState()
  }
}

export function saveState(state: PersistedState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Quota or private mode: the session still works until reload.
  }
}

export function createChat(): Chat {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    title: 'Новый чат',
    model: 'grok-4.7',
    maxTokens: 4096,
    reasoningEffort: 'high',
    draft: '',
    messages: [],
    createdAt: now,
    updatedAt: now,
  }
}

export function createMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    reasoning: '',
    usage: null,
    error: null,
    notice: null,
    stopped: false,
  }
}

export function titleFrom(text: string) {
  const line = text.trim().replace(/\s+/g, ' ')
  if (!line) return 'Новый чат'
  if (line.length <= 42) return line
  return `${line.slice(0, 42).trimEnd()}…`
}

function freshState(): PersistedState {
  const chat = createChat()
  return { chats: [chat], activeId: chat.id }
}

function normalizeChat(value: unknown): Chat | null {
  if (!value || typeof value !== 'object') return null
  const chat = value as Partial<Chat>
  if (typeof chat.id !== 'string' || !Array.isArray(chat.messages)) return null
  const now = Date.now()
  return {
    id: chat.id,
    title: typeof chat.title === 'string' && chat.title.trim() ? chat.title : 'Новый чат',
    model: isModel(chat.model) ? chat.model : 'grok-4.7',
    maxTokens: isMaxTokens(chat.maxTokens) ? chat.maxTokens : 4096,
    reasoningEffort: isEffort(chat.reasoningEffort) ? chat.reasoningEffort : 'high',
    draft: typeof chat.draft === 'string' ? chat.draft : '',
    messages: chat.messages.map(normalizeMessage).filter((message) => message !== null),
    createdAt: typeof chat.createdAt === 'number' ? chat.createdAt : now,
    updatedAt: typeof chat.updatedAt === 'number' ? chat.updatedAt : now,
  }
}

function normalizeMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== 'object') return null
  const message = value as Partial<ChatMessage>
  if (message.role !== 'user' && message.role !== 'assistant') return null
  if (typeof message.id !== 'string') return null
  return {
    id: message.id,
    role: message.role,
    content: typeof message.content === 'string' ? message.content : '',
    reasoning: typeof message.reasoning === 'string' ? message.reasoning : '',
    usage: normalizeStoredUsage(message.usage),
    error: typeof message.error === 'string' ? message.error : null,
    notice: typeof message.notice === 'string' ? message.notice : null,
    stopped: message.stopped === true,
  }
}

function normalizeStoredUsage(value: unknown): ChatMessage['usage'] {
  if (!value || typeof value !== 'object') return null
  const usage = value as Partial<ChatMessage['usage']>
  if (!usage) return null
  if (typeof usage.inputTokens !== 'number' || typeof usage.outputTokens !== 'number' || typeof usage.totalTokens !== 'number') {
    return null
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: typeof usage.reasoningTokens === 'number' ? usage.reasoningTokens : null,
    cachedTokens: typeof usage.cachedTokens === 'number' ? usage.cachedTokens : null,
    totalTokens: usage.totalTokens,
    costTicks: typeof usage.costTicks === 'number' ? usage.costTicks : null,
  }
}

function isModel(value: unknown): value is ModelId {
  return typeof value === 'string' && MODELS.some((model) => model === value)
}

function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && EFFORTS.some((effort) => effort.id === value)
}

function isMaxTokens(value: unknown): value is Chat['maxTokens'] {
  return typeof value === 'number' && MAX_TOKEN_OPTIONS.some((option) => option === value)
}
