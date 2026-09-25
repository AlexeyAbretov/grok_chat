import { openaiProvider } from './openai.ts'
import type { LlmProvider } from './types.ts'
import { xaiProvider } from './xai.ts'

// Register a provider here. /api/status sends this list to the browser.
const llmProviders: readonly LlmProvider[] = [xaiProvider, openaiProvider]

export function llmForModel(model: string): LlmProvider | null {
  return llmProviders.find((provider) => provider.models.some((item) => item === model)) ?? null
}

export function providerStatus() {
  return llmProviders.map((provider) => ({
    id: provider.id,
    label: provider.label,
    reasoning: provider.reasoning,
    models: [...provider.models],
  }))
}
