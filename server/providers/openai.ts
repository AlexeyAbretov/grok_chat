import { createResponsesProvider } from './responses.ts'

export const openaiProvider = createResponsesProvider({
  id: 'openai',
  label: 'ChatGPT',
  envVar: 'OPENAI_API_KEY',
  reasoning: true,
  models: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'],
  endpoint: 'https://api.openai.com/v1/responses',
  vendor: 'OpenAI',
  identity: 'You are ChatGPT, a helpful assistant.',
})
