import { parsePersistedState, type Chat, type ChatMessage, type PersistedState } from '../shared/state.ts'

const STORAGE_KEY = 'grok-chat.v1'
const DRAFTS_KEY = 'grok-chat.drafts'

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

export { titleFrom } from '../shared/state.ts'

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

export function applyDrafts(chats: Chat[]): Chat[] {
  const drafts = readDrafts()
  return chats.map((chat) => ({ ...chat, draft: drafts[chat.id] ?? '' }))
}

export function writeDraft(chatId: string, draft: string) {
  const drafts = readDrafts()
  if (draft) drafts[chatId] = draft
  else delete drafts[chatId]
  try {
    sessionStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts))
  } catch {
    // Private mode can block storage; the draft stays in memory for this page.
  }
}

function readDrafts(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem(DRAFTS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const drafts: Record<string, string> = {}
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === 'string') drafts[id] = value
    }
    return drafts
  } catch {
    return {}
  }
}

export function clearLegacyState() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Private mode can block storage; the server copy is already written.
  }
}
