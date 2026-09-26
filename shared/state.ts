import { isChatId } from './json-schema.ts'
import { EFFORTS, type Effort, type ToolTrace, type Usage } from './protocol.ts'

export const MAX_TOKEN_OPTIONS = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768] as const

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning: string
  tools: ToolTrace[]
  usage: Usage | null
  error: string | null
  notice: string | null
  stopped: boolean
}

export type Chat = {
  id: string
  title: string
  model: string
  maxTokens: number
  reasoningEffort: Effort
  draft: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}

export type PersistedState = {
  chats: Chat[]
  activeId: string
}

export function parsePersistedState(value: unknown): { ok: true; state: PersistedState } | { ok: false; message: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'Неверный тип «тело»' }
  }
  const record = value as { chats?: unknown; activeId?: unknown }
  if (!Array.isArray(record.chats)) return { ok: false, message: 'Неверный тип «chats»' }

  const chatIds = new Set<string>()
  const messageIds = new Set<string>()
  const chats: Chat[] = []
  for (const item of record.chats) {
    const chat = normalizeChat(item, chatIds, messageIds)
    if (chat) chats.push(chat)
  }
  const activeId = typeof record.activeId === 'string' && chats.some((chat) => chat.id === record.activeId)
    ? record.activeId
    : (chats[0]?.id ?? '')
  return { ok: true, state: { chats, activeId } }
}

function normalizeChat(value: unknown, chatIds: Set<string>, messageIds: Set<string>): Chat | null {
  if (!value || typeof value !== 'object') return null
  const chat = value as Partial<Chat>
  if (!isChatId(chat.id) || chatIds.has(chat.id) || !Array.isArray(chat.messages)) return null
  chatIds.add(chat.id)
  const now = Date.now()
  return {
    id: chat.id,
    title: typeof chat.title === 'string' && chat.title.trim() ? chat.title : 'Новый чат',
    model: typeof chat.model === 'string' ? chat.model.trim() : '',
    maxTokens: isMaxTokens(chat.maxTokens) ? chat.maxTokens : 4096,
    reasoningEffort: isEffort(chat.reasoningEffort) ? chat.reasoningEffort : 'high',
    draft: typeof chat.draft === 'string' ? chat.draft : '',
    messages: chat.messages.map((item) => normalizeMessage(item, messageIds)).filter((message) => message !== null),
    createdAt: timestamp(chat.createdAt, now),
    updatedAt: timestamp(chat.updatedAt, now),
  }
}

function normalizeMessage(value: unknown, messageIds: Set<string>): ChatMessage | null {
  if (!value || typeof value !== 'object') return null
  const message = value as Partial<ChatMessage>
  if (message.role !== 'user' && message.role !== 'assistant') return null
  if (!isChatId(message.id) || messageIds.has(message.id)) return null
  messageIds.add(message.id)
  return {
    id: message.id,
    role: message.role,
    content: typeof message.content === 'string' ? message.content : '',
    reasoning: typeof message.reasoning === 'string' ? message.reasoning : '',
    tools: normalizeTools(message.tools),
    usage: normalizeStoredUsage(message.usage),
    error: typeof message.error === 'string' ? message.error : null,
    notice: typeof message.notice === 'string' ? message.notice : null,
    stopped: message.stopped === true,
  }
}

function normalizeTools(value: unknown): ToolTrace[] {
  if (!Array.isArray(value)) return []
  const tools: ToolTrace[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const tool = item as Partial<ToolTrace>
    if (typeof tool.name !== 'string' || typeof tool.output !== 'string') continue
    tools.push({
      name: tool.name,
      args: typeof tool.args === 'string' ? tool.args : '',
      ok: tool.ok === true,
      output: tool.output,
    })
  }
  return tools
}

function normalizeStoredUsage(value: unknown): Usage | null {
  if (!value || typeof value !== 'object') return null
  const usage = value as Partial<Usage>
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

function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && EFFORTS.some((effort) => effort.id === value)
}

function isMaxTokens(value: unknown): value is Chat['maxTokens'] {
  return typeof value === 'number' && MAX_TOKEN_OPTIONS.some((option) => option === value)
}

function timestamp(value: unknown, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.trunc(value)
}
