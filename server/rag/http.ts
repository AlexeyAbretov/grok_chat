/**
 * Эмбеддинги — OpenAIEmbeddings. Реранк — CohereRerank.
 * Пробный ключ Cohere: 10 вызовов в минуту, поэтому между вызовами пауза 7 секунд и один повтор на 429.
 */
import { CohereRerank } from '@langchain/cohere'
import { OpenAIEmbeddings } from '@langchain/openai'
import { CohereClient } from 'cohere-ai'

const EMBED_URL = 'https://api.openai.com/v1/embeddings'
const RERANK_MODEL = 'rerank-v3.5'
const RERANK_GAP_MS = 7_000
const RERANK_RETRY_MS = 60_000

let lastRerankAt = 0
/** Очередь: два реранка подряд не стартуют вместе и не пробивают лимит. */
let rerankTail: Promise<void> = Promise.resolve()

export function embedApiKey() {
  return (process.env.EMBED_API_KEY || process.env.OPENAI_API_KEY || '').trim()
}

export function rerankApiKey() {
  return (process.env.RERANK_API_KEY || process.env.COHERE_API_KEY || '').trim()
}

export function embedModel() {
  return process.env.EMBED_MODEL?.trim() || 'text-embedding-3-small'
}

export async function embedTexts(texts: readonly string[], apiKey: string, model = embedModel(), signal?: AbortSignal) {
  if (texts.length === 0) return []
  if (signal?.aborted) throw abortError('Эмбеддинги')
  const embeddings = new OpenAIEmbeddings({
    apiKey,
    model,
    batchSize: 128,
    stripNewLines: false,
    timeout: 60_000,
    configuration: {
      baseURL: embedBaseUrl(),
      timeout: 60_000,
      maxRetries: 1,
      fetch: (input, init) => fetch(input, { ...init, signal: combine(signal, init?.signal) }),
    },
  })
  try {
    return await embeddings.embedDocuments([...texts])
  } catch (error) {
    if (signal?.aborted) throw error
    const message = error instanceof Error ? error.message : 'сбой'
    throw new Error(`Эмбеддинги: ${message}`)
  }
}

export function retryAfterMs(header: string | null, now = Date.now()) {
  if (!header) return RERANK_RETRY_MS
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(RERANK_RETRY_MS, seconds * 1000)
  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.min(RERANK_RETRY_MS, Math.max(0, date - now))
  return RERANK_RETRY_MS
}

export async function rerankTexts(query: string, texts: readonly string[], apiKey: string, topN: number, signal?: AbortSignal) {
  if (texts.length === 0) return []
  const job = rerankTail.then(() => pacedRerank(query, texts, apiKey, topN, signal))
  rerankTail = job.then(
    () => undefined,
    () => undefined,
  )
  return job
}

async function pacedRerank(query: string, texts: readonly string[], apiKey: string, topN: number, signal?: AbortSignal) {
  await waitGap(signal)
  try {
    return await requestRerank(query, texts, apiKey, topN, signal)
  } catch (error) {
    if (signal?.aborted || statusOf(error) !== 429) throw error
    await sleep(retryAfterMs(retryHeader(error)), signal)
    await waitGap(signal)
    return requestRerank(query, texts, apiKey, topN, signal)
  }
}

async function requestRerank(query: string, texts: readonly string[], apiKey: string, topN: number, signal?: AbortSignal) {
  if (signal?.aborted) throw abortError('Реранк')
  const baseUrl = rerankBaseUrl()
  const reranker = new CohereRerank({
    client: new CohereClient({
      token: apiKey,
      timeoutInSeconds: 60,
      maxRetries: 0,
      ...(baseUrl ? { baseUrl } : {}),
    }),
    model: process.env.RERANK_MODEL?.trim() || RERANK_MODEL,
    topN,
  })
  const ranked = await reranker.rerank([...texts], query, { topN })
  return [...ranked]
    .sort((left, right) => right.relevanceScore - left.relevanceScore || left.index - right.index)
    .map((item) => item.index)
}

function embedBaseUrl() {
  return (process.env.EMBED_URL?.trim() || EMBED_URL).replace(/\/embeddings\/?$/, '')
}

function rerankBaseUrl() {
  const raw = process.env.RERANK_URL?.trim()
  if (!raw) return ''
  return raw.replace(/\/v[12]\/rerank\/?$/, '')
}

function combine(parent?: AbortSignal, child?: AbortSignal | null) {
  if (parent && child) return AbortSignal.any([parent, child])
  return parent ?? child ?? undefined
}

async function waitGap(signal?: AbortSignal) {
  const rest = RERANK_GAP_MS - (Date.now() - lastRerankAt)
  if (lastRerankAt > 0 && rest > 0) await sleep(rest, signal)
  lastRerankAt = Date.now()
}

function sleep(ms: number, signal?: AbortSignal) {
  if (ms <= 0) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(abortError('Реранк'))
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError('Реранк'))
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortError(label: string) {
  const error = new Error(`${label} отменены`)
  error.name = 'AbortError'
  return error
}

function statusOf(error: unknown) {
  if (!error || typeof error !== 'object') return 0
  const row = error as { status?: unknown; statusCode?: unknown }
  if (typeof row.statusCode === 'number') return row.statusCode
  if (typeof row.status === 'number') return row.status
  return 0
}

function retryHeader(error: unknown) {
  if (!error || typeof error !== 'object' || !('rawResponse' in error)) return null
  const raw = (error as { rawResponse?: { headers?: { get?: (name: string) => string | null } } }).rawResponse
  const headers = raw?.headers
  const read = headers?.get
  return typeof read === 'function' ? read.call(headers, 'retry-after') : null
}
