import { type Effort, type ToolTrace, type Usage } from '../shared/protocol.ts'

export { EFFORTS, type Effort, type ToolTrace, type Usage } from '../shared/protocol.ts'

export const MAX_TOKEN_OPTIONS = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768] as const

export type ProviderInfo = {
  id: string
  label: string
  reasoning: boolean
  models: readonly string[]
}

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
