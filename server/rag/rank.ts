import { bm25Order, type Bm25Index } from './bm25.ts'
import { CANDIDATE_POOL, PASSAGE_LIMIT, RERANK_POOL, RRF_K, type Chunk, type SearchFilter, type SearchMode } from './types.ts'

/** Насколько два вектора смотрят в одну сторону. 1 — почти тот же смысл, 0 — не связаны. */
export function cosine(left: readonly number[], right: readonly number[]) {
  if (left.length !== right.length) return 0
  let dot = 0
  let leftSq = 0
  let rightSq = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    dot += a * b
    leftSq += a * a
    rightSq += b * b
  }
  if (leftSq === 0 || rightSq === 0) return 0
  return dot / Math.sqrt(leftSq * rightSq)
}

/**
 * Сливает списки по месту, не по сырому баллу: у BM25 и у векторов разные шкалы.
 * Чанк, который высоко в обоих списках, обгоняет чемпиона только одного списка.
 */
export function reciprocalRankFusion(rankings: readonly (readonly string[])[], k = RRF_K) {
  const scores = new Map<string, number>()
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1))
    })
  }
  return [...scores].sort(byIdScore).map(([id]) => id)
}

export function matchesFilter(chunk: Chunk, filter: SearchFilter | undefined) {
  if (!filter) return true
  if (filter.type && chunk.type !== filter.type) return false
  if (filter.section && chunk.section !== filter.section) return false
  if (filter.dateFrom && chunk.date < filter.dateFrom) return false
  if (filter.dateTo && chunk.date > filter.dateTo) return false
  return true
}

export function rankChunkIds(args: {
  chunks: readonly Chunk[]
  index: Bm25Index
  vectors: ReadonlyMap<string, readonly number[]> | null
  query: string
  queryVector: readonly number[] | null
  filter?: SearchFilter
  mode: SearchMode
  take?: number
}) {
  const take = args.take ?? PASSAGE_LIMIT
  // Фильтр раньше поиска: чанк чужого раздела не занимает место в топе.
  const allowed = args.chunks.filter((chunk) => matchesFilter(chunk, args.filter))
  const allowedIds = new Set(allowed.map((chunk) => chunk.id))
  if (args.mode === 'bm25') return bm25Order(args.index, args.query, allowedIds).slice(0, take)
  if (args.mode === 'vector') return vectorOrder(allowed, args.vectors, args.queryVector).slice(0, take)
  const lexical = bm25Order(args.index, args.query, allowedIds).slice(0, CANDIDATE_POOL)
  const dense = vectorOrder(allowed, args.vectors, args.queryVector).slice(0, CANDIDATE_POOL)
  const lists = [lexical, dense].filter((list) => list.length > 0)
  return reciprocalRankFusion(lists).slice(0, RERANK_POOL).slice(0, take)
}

/** Реранкер возвращает номера кандидатов, не новые id. 2 значит «третий чанк из пула». */
export function applyRerank(ids: readonly string[], order: readonly number[]) {
  return order.flatMap((index) => {
    const id = ids[index]
    return id ? [id] : []
  })
}

/** Сколько вопросов нашли свой файл среди первых k чанков. recall@5 — это hits / число вопросов. */
export function hitCount(rankings: readonly (readonly string[])[], gold: readonly string[], k: number) {
  return rankings.reduce((sum, sources, index) => sum + (sources.slice(0, k).includes(gold[index] ?? '') ? 1 : 0), 0)
}

function vectorOrder(chunks: readonly Chunk[], vectors: ReadonlyMap<string, readonly number[]> | null, query: readonly number[] | null) {
  if (!vectors || !query) return []
  const scored: { id: string; score: number }[] = []
  for (const chunk of chunks) {
    const vector = vectors.get(chunk.id)
    if (!vector) continue
    scored.push({ id: chunk.id, score: cosine(vector, query) })
  }
  scored.sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  return scored.map((item) => item.id)
}

function byIdScore(left: [string, number], right: [string, number]) {
  return right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
}
