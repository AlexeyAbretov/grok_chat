import { applyJson, applySseEvent, splitSse, type StreamFlags, type StreamHandlers } from '../src/sse.ts'

const flags = (): StreamFlags => ({ sawTextDelta: false, sawReasoningDelta: false })

function collect() {
  const events = {
    text: '',
    reasoning: '',
    usage: null as unknown,
    errors: [] as string[],
    notices: [] as string[],
  }
  const handlers: StreamHandlers = {
    onText: (delta) => {
      events.text += delta
    },
    onReasoning: (delta) => {
      events.reasoning += delta
    },
    onUsage: (usage) => {
      events.usage = usage
    },
    onError: (message) => events.errors.push(message),
    onNotice: (notice) => events.notices.push(notice),
  }
  return { events, handlers }
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

const split = splitSse('data: {"type":"response.output_text.delta","delta":"Hi"}\n\ndata: {"type":"response.output_text.delta","delta":"!"}\n\npartial')
assert(split.blocks.length === 2, 'split keeps complete events')
assert(split.rest === 'partial', 'split keeps the tail')

const streamed = collect()
const streamedFlags = flags()
applySseEvent('event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"думаю "}', streamedFlags, streamed.handlers)
applySseEvent('data: {"type":"response.output_text.delta","delta":"ответ"}', streamedFlags, streamed.handlers)
applyJson(
  {
    type: 'response.completed',
    response: {
      output_text: 'ответ целиком',
      output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'думаю целиком' }] }],
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        total_tokens: 20,
        output_tokens_details: { reasoning_tokens: 6 },
        input_tokens_details: { cached_tokens: 4 },
        cost_in_usd_ticks: 37756000,
      },
    },
  },
  streamedFlags,
  streamed.handlers,
)
assert(streamed.events.reasoning === 'думаю ', 'deltas are not duplicated by the final summary')
assert(streamed.events.text === 'ответ', 'deltas are not duplicated by output_text')
assert(streamed.events.usage && (streamed.events.usage as { reasoningTokens: number }).reasoningTokens === 6, 'reasoning tokens are read')
assert((streamed.events.usage as { cachedTokens: number }).cachedTokens === 4, 'cached input tokens are read')
assert((streamed.events.usage as { costTicks: number }).costTicks === 37756000, 'cost ticks are read')

const fallback = collect()
applyJson(
  {
    output: [
      { type: 'reasoning', summary: [{ text: 'ход мысли' }] },
      { type: 'message', content: [{ type: 'output_text', text: '42' }] },
    ],
    usage: {
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 8,
      completion_tokens_details: { reasoning_tokens: 3 },
      prompt_tokens_details: { cached_tokens: 1 },
      cost_in_usd_ticks: 100000000,
    },
  },
  flags(),
  fallback.handlers,
)
assert(fallback.events.reasoning === 'ход мысли', 'final reasoning summary is kept when nothing was streamed')
assert(fallback.events.text === '42', 'final answer is kept when nothing was streamed')
assert((fallback.events.usage as { inputTokens: number }).inputTokens === 3, 'chat usage names are accepted')
assert((fallback.events.usage as { cachedTokens: number }).cachedTokens === 1, 'chat cached tokens are read')
assert((fallback.events.usage as { costTicks: number }).costTicks === 100000000, 'chat cost ticks are read')

const chunk = collect()
applyJson(
  { choices: [{ delta: { reasoning_content: 'шаг', content: 'ок' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  flags(),
  chunk.handlers,
)
assert(chunk.events.reasoning === 'шаг' && chunk.events.text === 'ок', 'chat completion chunks are read')

const failed = collect()
applyJson({ type: 'error', error: { message: 'нет ключа' } }, flags(), failed.handlers)
assert(failed.events.errors[0] === 'нет ключа', 'api errors surface')

const limited = collect()
applyJson(
  { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } },
  flags(),
  limited.handlers,
)
assert(limited.events.notices[0] === 'Достигнут лимит токенов', 'token limit is explained')

console.log('sse ok')
