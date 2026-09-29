/**
 * Внешние модели поиска.
 * Эмбеддинг превращает текст в вектор смысла. Реранкер читает вопрос и кандидата вместе и ставит пару точнее, но дороже.
 */
const EMBED_URL = 'https://api.openai.com/v1/embeddings'
const RERANK_URL = 'https://api.cohere.com/v2/rerank'
const EMBED_MODEL = 'text-embedding-3-small'
const RERANK_MODEL = 'rerank-v3.5'
const BATCH = 128
/** Пробный ключ Cohere: 10 вызовов в минуту. Пауза 7 секунд остаётся под этим лимитом. */
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
  return process.env.EMBED_MODEL?.trim() || EMBED_MODEL
}

export async function embedTexts(texts: readonly string[], apiKey: string, model = embedModel(), signal?: AbortSignal) {
  const vectors: number[][] = []
  for (let start = 0; start < texts.length; start += BATCH) {
    const batch = texts.slice(start, start + BATCH)
    const payload = await postJson(
      process.env.EMBED_URL?.trim() || EMBED_URL,
      apiKey,
      { model, input: batch },
      'Эмбеддинги',
      signal,
    )
    vectors.push(...readEmbeddings(payload, batch.length))
  }
  return vectors
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
    if (signal?.aborted || httpStatus(error) !== 429) throw error
    await sleep(retryAfterMs(retryHeader(error)), signal)
    await waitGap(signal)
    return requestRerank(query, texts, apiKey, topN, signal)
  }
}

async function requestRerank(query: string, texts: readonly string[], apiKey: string, topN: number, signal?: AbortSignal) {
  const payload = await postJson(
    process.env.RERANK_URL?.trim() || RERANK_URL,
    apiKey,
    { model: process.env.RERANK_MODEL?.trim() || RERANK_MODEL, query, documents: texts, top_n: topN },
    'Реранк',
    signal,
  )
  return readRerank(payload, texts.length)
}

async function waitGap(signal?: AbortSignal) {
  const rest = RERANK_GAP_MS - (Date.now() - lastRerankAt)
  if (lastRerankAt > 0 && rest > 0) await sleep(rest, signal)
  lastRerankAt = Date.now()
}

function sleep(ms: number, signal?: AbortSignal) {
  if (ms <= 0) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortError() {
  const error = new Error('Реранк отменён')
  error.name = 'AbortError'
  return error
}

async function postJson(url: string, apiKey: string, body: unknown, label: string, parent?: AbortSignal) {
  const timed = deadline(60_000, parent)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: timed.signal,
    })
    const raw = await response.text()
    if (!response.ok) throw httpFailure(label, response.status, response.headers.get('retry-after'), raw)
    return JSON.parse(raw) as unknown
  } catch (error) {
    if (!parent?.aborted && timed.signal.aborted) throw new Error(`${label}: таймаут`)
    throw error
  } finally {
    timed.done()
  }
}

function deadline(ms: number, parent?: AbortSignal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  const onAbort = () => controller.abort()
  if (parent?.aborted) controller.abort()
  else parent?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onAbort)
    },
  }
}

function readEmbeddings(payload: unknown, count: number) {
  const data = record(payload)?.data
  if (!Array.isArray(data) || data.length !== count) throw new Error('Эмбеддинги: неожиданный размер')
  const vectors = new Array<number[]>(count)
  for (const item of data) {
    const row = record(item)
    const index = row?.index
    const embedding = row?.embedding
    if (typeof index !== 'number' || index < 0 || index >= count || !Array.isArray(embedding)) throw new Error('Эмбеддинги: нет вектора')
    vectors[index] = embedding.map((value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Эмбеддинги: не число')
      return value
    })
  }
  if (vectors.some((vector) => !vector?.length)) throw new Error('Эмбеддинги: пропущен индекс')
  return vectors
}

function readRerank(payload: unknown, count: number) {
  const results = record(payload)?.results
  if (!Array.isArray(results)) throw new Error('Реранк: нет results')
  const ranked: { index: number; score: number }[] = []
  for (const item of results) {
    const row = record(item)
    const index = row?.index
    const score = typeof row?.relevance_score === 'number' ? row.relevance_score : row?.score
    if (typeof index !== 'number' || index < 0 || index >= count || typeof score !== 'number') throw new Error('Реранк: нет индекса')
    ranked.push({ index, score })
  }
  ranked.sort((left, right) => right.score - left.score || left.index - right.index)
  return ranked.map((item) => item.index)
}

function httpFailure(label: string, status: number, retryAfter: string | null, raw: string) {
  const error = new Error(`${label}: HTTP ${status} ${raw.slice(0, 180)}`) as Error & { status: number; retryAfter: string | null }
  error.status = status
  error.retryAfter = retryAfter
  return error
}

function httpStatus(error: unknown) {
  if (!error || typeof error !== 'object' || !('status' in error)) return 0
  return typeof error.status === 'number' ? error.status : 0
}

function retryHeader(error: unknown) {
  if (!error || typeof error !== 'object' || !('retryAfter' in error)) return null
  return typeof error.retryAfter === 'string' ? error.retryAfter : null
}

function record(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}
