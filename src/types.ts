export const MODELS = ['grok-4.7', 'grok-4.6', 'grok-4.5'] as const
export type ModelId = (typeof MODELS)[number]

export const MAX_TOKEN_OPTIONS = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768] as const

export const EFFORTS = [
  { id: 'low', label: 'мало' },
  { id: 'medium', label: 'средне' },
  { id: 'high', label: 'много' },
  { id: 'xhigh', label: 'максимум' },
] as const

export type Effort = (typeof EFFORTS)[number]['id']

export type Usage = {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number | null
  cachedTokens: number | null
  totalTokens: number
  costTicks: number | null
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning: string
  usage: Usage | null
  error: string | null
  notice: string | null
  stopped: boolean
}

export type Chat = {
  id: string
  title: string
  model: ModelId
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
