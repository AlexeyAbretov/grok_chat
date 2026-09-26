import { parsePersistedState, type Chat, type ChatMessage, type PersistedState } from '../shared/state.ts'

const STORAGE_KEY = 'grok-chat.v1'

export function createChat(model = ''): Chat {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    title: 'Новый чат',
    model,
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
    tools: [],
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

export function clearStoredApiKeys() {
  try {
    localStorage.removeItem('grok-chat.api-key')
    localStorage.removeItem('grok-chat.api-keys')
  } catch {
    // Private mode can block storage; there is nothing to delete then.
  }
}

export function readLegacyState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    const state = parsePersistedState(parsed)
    if (!state.ok || state.state.chats.length === 0) return null
    return state.state
  } catch {
    return null
  }
}

export function clearLegacyState() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Private mode can block storage; the server copy is already written.
  }
}
