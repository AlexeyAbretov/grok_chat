import { createResponsesProvider } from './responses.ts'

export const xaiProvider = createResponsesProvider({
  id: 'xai',
  label: 'Grok',
  envVar: 'XAI_API_KEY',
  reasoning: true,
  models: ['grok-4.7', 'grok-4.6', 'grok-4.5'],
  endpoint: 'https://api.x.ai/v1/responses',
  vendor: 'xAI',
  identity: 'You are Grok, a helpful assistant.',
  extraBody: {
    include: ['reasoning.encrypted_content'],
  },
})
