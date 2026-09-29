import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildBm25, tokens, type Bm25Index } from './bm25.ts'
import { chunkDocument, parseDocument } from './chunk.ts'
import { embedApiKey, embedModel, embedTexts, rerankApiKey, rerankTexts } from './http.ts'
import { passagesFromChunks, passagesPrompt } from './prompt.ts'
import { applyRerank, rankChunkIds } from './rank.ts'
import {
  PASSAGE_LIMIT,
  RERANK_POOL,
  type Chunk,
  type Document,
  type GoldQuestion,
  type SearchFilter,
  type SearchMode,
} from './types.ts'

/**
 * Сборка корпуса и ответ на один вопрос.
 * Чанки и BM25 считаются локально. Векторы кэшируются в data/rag-index.json.
 * В чат уходит гибрид: BM25 и векторы, затем реранк, если есть ключ Cohere.
 */
const DOCS_DIR = resolve('corpus/docs')
const QUESTIONS_PATH = resolve('corpus/questions.json')
const CACHE_PATH = resolve('data/rag-index.json')

export type CorpusIndex = {
  chunks: Chunk[]
  bm25: Bm25Index
  vectors: Map<string, number[]> | null
  model: string | null
  warning: string | null
}

type LoadOptions = {
  embed?: 'optional' | 'required'
  signal?: AbortSignal
}

let memo: { fingerprint: string; embed: 'optional' | 'required'; index: CorpusIndex } | null = null
let pending: Promise<CorpusIndex> | null = null

export function loadDocuments(): Document[] {
  if (!existsSync(DOCS_DIR)) return []
  return readdirSync(DOCS_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((name) => parseDocument(`corpus/docs/${name}`, readFileSync(join(DOCS_DIR, name), 'utf8')))
}

export function loadQuestions(): GoldQuestion[] {
  const parsed = JSON.parse(readFileSync(QUESTIONS_PATH, 'utf8')) as unknown
  if (!Array.isArray(parsed) || parsed.length !== 25) throw new Error('Нужно 25 вопросов')
  return parsed.map(readQuestion)
}

export function loadCorpusIndex(options: LoadOptions = {}): Promise<CorpusIndex> {
  const embed = options.embed ?? 'optional'
  const fingerprint = corpusFingerprint()
  if (memo?.fingerprint === fingerprint && memo.embed === embed) return Promise.resolve(memo.index)
  if (!pending) {
    pending = buildIndex(fingerprint, embed, options.signal)
      .then((index) => {
        memo = { fingerprint, embed, index }
        return index
      })
      .finally(() => {
        pending = null
      })
  }
  return pending
}

/**
 * Синоним на стороне запроса, файл корпуса не меняется.
 * «Место» в корпусе значит ранг в списке, а склад записан как «ячейка».
 * Дописанное слово ищут и BM25, и эмбеддинг, и реранкер.
 */
export function expandQuery(query: string) {
  const hasPlace = tokens(query).some((token) => token === 'место')
  return hasPlace ? `${query} ячейка` : query
}

/** Текст, который дописывается в системный промпт перед ответом модели. Пусто, если ничего не нашлось. */
export async function corpusContext(question: string, signal?: AbortSignal) {
  const trimmed = question.trim()
  if (!trimmed) return null
  const query = expandQuery(trimmed)
  const index = await loadCorpusIndex({ embed: 'optional', signal })
  if (index.chunks.length === 0) return null
  const queryVector = await queryVectorFor(index, query, signal)
  let rerank = Boolean(queryVector && rerankApiKey())
  const mode: SearchMode = queryVector ? 'hybrid' : 'bm25'
  let ids: string[]
  try {
    ids = await rankedIds(index, query, queryVector, undefined, mode, rerank, signal)
  } catch (error) {
    if (signal?.aborted || !rerank) throw error
    rerank = false
    ids = await rankedIds(index, query, queryVector, undefined, mode, false, signal)
  }
  const byId = new Map(index.chunks.map((chunk) => [chunk.id, chunk]))
  const hits = ids.flatMap((id) => {
    const chunk = byId.get(id)
    return chunk ? [chunk] : []
  })
  const passages = passagesFromChunks(hits)
  const text = passagesPrompt(passages)
  if (!text) return null
  return { text, mode: rerank ? 'hybrid+rerank' : mode, count: passages.length, warning: index.warning }
}

export async function rankedSources(
  index: CorpusIndex,
  query: string,
  queryVector: readonly number[] | null,
  filter: SearchFilter | undefined,
  mode: SearchMode,
  rerank: boolean,
  signal?: AbortSignal,
) {
  const ids = await rankedIds(index, query, queryVector, filter, mode, rerank, signal)
  const byId = new Map(index.chunks.map((chunk) => [chunk.id, chunk.source]))
  return ids.flatMap((id) => {
    const source = byId.get(id)
    return source ? [source] : []
  })
}

/**
 * vector и bm25 отдают свои первые 5.
 * hybrid сливает верхние 30 и, если просили реранк, пересортировывает 24 кандидата.
 */
async function rankedIds(
  index: CorpusIndex,
  query: string,
  queryVector: readonly number[] | null,
  filter: SearchFilter | undefined,
  mode: SearchMode,
  rerank: boolean,
  signal?: AbortSignal,
) {
  const ids = rankChunkIds({
    chunks: index.chunks,
    index: index.bm25,
    vectors: index.vectors,
    query,
    queryVector,
    filter,
    mode,
    take: mode === 'hybrid' && rerank ? RERANK_POOL : PASSAGE_LIMIT,
  })
  if (mode !== 'hybrid' || !rerank) return ids.slice(0, PASSAGE_LIMIT)
  const key = rerankApiKey()
  if (!key) return ids.slice(0, PASSAGE_LIMIT)
  const byId = new Map(index.chunks.map((chunk) => [chunk.id, chunk.text]))
  const texts = ids.map((id) => byId.get(id) ?? '')
  const order = await rerankTexts(query, texts, key, Math.min(PASSAGE_LIMIT, texts.length), signal)
  return applyRerank(ids, order).slice(0, PASSAGE_LIMIT)
}

async function queryVectorFor(index: CorpusIndex, query: string, signal?: AbortSignal) {
  const key = embedApiKey()
  if (!index.vectors || !key || !index.model) return null
  try {
    return (await embedTexts([query], key, index.model, signal))[0] ?? null
  } catch (error) {
    if (signal?.aborted) throw error
    return null
  }
}

async function buildIndex(fingerprint: string, embed: 'optional' | 'required', signal?: AbortSignal): Promise<CorpusIndex> {
  const chunks = loadDocuments().flatMap((doc) => chunkDocument(doc))
  const bm25 = buildBm25(chunks)
  const model = embedModel()
  const key = embedApiKey()
  if (!key) {
    if (embed === 'required') throw new Error('Нет ключа эмбеддингов. Задайте OPENAI_API_KEY или EMBED_API_KEY.')
    return { chunks, bm25, vectors: null, model: null, warning: null }
  }
  const cached = readCache(fingerprint, model, chunks)
  if (cached) return { chunks, bm25, vectors: cached, model, warning: null }
  try {
    const embedded = await embedTexts(chunks.map((chunk) => chunk.text), key, model, signal)
    if (embedded.length !== chunks.length) throw new Error('Эмбеддинги вернули другой размер')
    const vectors = new Map<string, number[]>()
    chunks.forEach((chunk, index) => {
      const vector = embedded[index]
      if (vector) vectors.set(chunk.id, vector)
    })
    writeCache(fingerprint, model, vectors)
    return { chunks, bm25, vectors, model, warning: null }
  } catch (error) {
    if (signal?.aborted || embed === 'required') throw error
    const message = errorText(error)
    return { chunks, bm25, vectors: null, model: null, warning: message }
  }
}

function errorText(error: unknown) {
  if (!(error instanceof Error)) return 'эмбеддинги недоступны'
  const cause = error.cause
  if (cause instanceof Error && cause.message) return `${error.message}: ${cause.message}`
  return error.message
}

function readQuestion(value: unknown, index: number): GoldQuestion {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  const question = row?.question
  const document = row?.document
  const kind = row?.kind
  if (typeof question !== 'string' || !question.trim()) throw new Error(`Пустой вопрос ${index + 1}`)
  if (typeof document !== 'string' || !document.startsWith('corpus/docs/')) throw new Error(`Нет документа у вопроса ${index + 1}`)
  if (kind !== 'paraphrase' && kind !== 'exact') throw new Error(`Неверный kind у вопроса ${index + 1}`)
  const filter = readFilter(row?.filter, index)
  return filter ? { question, document, kind, filter } : { question, document, kind }
}

function readFilter(value: unknown, index: number): SearchFilter | undefined {
  if (value == null) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Неверный фильтр у вопроса ${index + 1}`)
  const row = value as Record<string, unknown>
  const filter: SearchFilter = {}
  for (const key of ['type', 'section', 'dateFrom', 'dateTo'] as const) {
    const item = row[key]
    if (item == null) continue
    if (typeof item !== 'string' || !item.trim()) throw new Error(`Неверный фильтр у вопроса ${index + 1}`)
    filter[key] = item
  }
  return filter
}

/** Подпись файлов корпуса. Поменялся размер или время — векторы в кэше больше не подходят. */
function corpusFingerprint() {
  if (!existsSync(DOCS_DIR)) return 'missing'
  return readdirSync(DOCS_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((name) => {
      const stat = statSync(join(DOCS_DIR, name))
      return `${name}:${stat.size}:${stat.mtimeMs}`
    })
    .join('|')
}

function readCache(fingerprint: string, model: string, chunks: readonly Chunk[]) {
  if (!existsSync(CACHE_PATH)) return null
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as {
      version?: number
      model?: string
      fingerprint?: string
      vectors?: { id?: string; vector?: unknown }[]
    }
    if (parsed.version !== 1 || parsed.model !== model || parsed.fingerprint !== fingerprint || !Array.isArray(parsed.vectors)) return null
    const map = new Map<string, number[]>()
    for (const item of parsed.vectors) {
      if (!item || typeof item.id !== 'string' || !Array.isArray(item.vector)) return null
      const vector = item.vector.map((value) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('cache')
        return value
      })
      map.set(item.id, vector)
    }
    if (chunks.some((chunk) => !map.has(chunk.id))) return null
    return map
  } catch {
    return null
  }
}

function writeCache(fingerprint: string, model: string, vectors: Map<string, number[]>) {
  mkdirSync(resolve('data'), { recursive: true })
  const payload = {
    version: 1,
    model,
    fingerprint,
    vectors: [...vectors].map(([id, vector]) => ({ id, vector })),
  }
  writeFileSync(CACHE_PATH, JSON.stringify(payload))
}
