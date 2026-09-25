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

export type ToolTrace = {
  name: string
  args: string
  ok: boolean
  output: string
}
