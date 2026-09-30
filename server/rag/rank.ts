// bm25Order ищет по словам. Bm25Index — готовый словарь частот.
import { bm25Order, type Bm25Index } from './bm25.ts'
// Константы пулов и лимитов, тип чанка, фильтра и режима поиска.
import { CANDIDATE_POOL, PASSAGE_LIMIT, RERANK_POOL, RRF_K, type Chunk, type SearchFilter, type SearchMode } from './types.ts'

/**
 * Косинусная близость двух векторов: насколько они смотрят в одну сторону.
 * 1 — почти тот же смысл, 0 — не связаны, отрицательное — смыслы противоположны.
 * Эмбеддинг — это список чисел, который модель эмбеддингов ставит в соответствие тексту.
 */
export function cosine(left: readonly number[], right: readonly number[]) {
  // Векторы разной длины сравнивать нельзя: это разные модели или битый кэш.
  if (left.length !== right.length) return 0
  // dot — скалярное произведение. leftSq и rightSq — квадраты длин векторов.
  let dot = 0
  let leftSq = 0
  let rightSq = 0
  for (let index = 0; index < left.length; index += 1) {
    // ?? 0 на случай дырки в массиве: дырка не должна стать NaN и сломать весь балл.
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    dot += a * b
    leftSq += a * a
    rightSq += b * b
  }
  // Нулевой вектор не имеет направления. Деление на ноль здесь дало бы NaN.
  if (leftSq === 0 || rightSq === 0) return 0
  // Делим на длины, чтобы длинный вектор не побеждал только из-за больших чисел.
  return dot / Math.sqrt(leftSq * rightSq)
}

/**
 * Сливает несколько списков id по месту, не по сырому баллу.
 * У BM25 и у косинуса разные шкалы: 12.4 и 0.81 нельзя складывать напрямую.
 * Чанк, который высоко в обоих списках, обгоняет чемпиона только одного списка.
 * k сглаживает разницу мест. По умолчанию это RRF_K = 60.
 */
export function reciprocalRankFusion(rankings: readonly (readonly string[])[], k = RRF_K) {
  const scores = new Map<string, number>()
  for (const ranking of rankings) {
    // index начинается с 0, а место в списке — с 1, поэтому в формуле index + 1.
    ranking.forEach((id, index) => {
      // Вклад этого списка: 1 / (k + место). Вклады всех списков складываются.
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1))
    })
  }
  // Сортируем по баллу и оставляем только id, уже в порядке «лучший первый».
  return [...scores].sort(byIdScore).map(([id]) => id)
}

/**
 * Решает, проходит ли чанк фильтр вопроса.
 * Нет фильтра — проходит любой чанк. Несовпадение любого заданного поля — отсев.
 */
export function matchesFilter(chunk: Chunk, filter: SearchFilter | undefined) {
  if (!filter) return true
  // Тип в шапке и тип в фильтре должны совпасть буквально.
  if (filter.type && chunk.type !== filter.type) return false
  if (filter.section && chunk.section !== filter.section) return false
  // Даты — строки ГГГГ-ММ-ДД, поэтому «меньше» значит «раньше».
  if (filter.dateFrom && chunk.date < filter.dateFrom) return false
  if (filter.dateTo && chunk.date > filter.dateTo) return false
  return true
}

/**
 * Главная сортировка чанков под один вопрос.
 * mode выбирает ветку: только слова, только векторы или оба списка со слиянием.
 * take — сколько id вернуть. Для чата это 5, перед реранком — 24.
 */
export function rankChunkIds(args: {
  /** Все чанки корпуса. Фильтр применяется к ним до подсчёта баллов. */
  chunks: readonly Chunk[]
  /** Готовый BM25-индекс тех же чанков. */
  index: Bm25Index
  /** Векторы чанков или null, если эмбеддинги недоступны. */
  vectors: ReadonlyMap<string, readonly number[]> | null
  /** Текст вопроса, уже после подстановки синонима. */
  query: string
  /** Вектор того же вопроса или null, если эмбеддинг вопроса не посчитали. */
  queryVector: readonly number[] | null
  /** Ограничение по шапке. Может отсутствовать. */
  filter?: SearchFilter
  mode: SearchMode
  /** Сколько id нужно вызывающему коду. Без числа берём PASSAGE_LIMIT. */
  take?: number
}) {
  const take = args.take ?? PASSAGE_LIMIT
  // Фильтр раньше поиска: чанк чужого раздела не занимает место в топе.
  const allowed = args.chunks.filter((chunk) => matchesFilter(chunk, args.filter))
  // Множество id нужно BM25: он не знает про объекты Chunk, только про id.
  const allowedIds = new Set(allowed.map((chunk) => chunk.id))
  // Чистый лексический режим не смотрит на векторы даже если они есть.
  if (args.mode === 'bm25') return bm25Order(args.index, args.query, allowedIds).slice(0, take)
  // Чистый векторный режим не смотрит на слова.
  if (args.mode === 'vector') return vectorOrder(allowed, args.vectors, args.queryVector).slice(0, take)
  // Гибрид: верхние 30 каждого списка, затем слияние. Берём не больше RERANK_POOL и не больше take.
  const lexical = bm25Order(args.index, args.query, allowedIds).slice(0, CANDIDATE_POOL)
  const dense = vectorOrder(allowed, args.vectors, args.queryVector).slice(0, CANDIDATE_POOL)
  // Пустой список (нет векторов или нет совпадений) в слияние не кладём: он не должен обнулять второй.
  const lists = [lexical, dense].filter((list) => list.length > 0)
  return reciprocalRankFusion(lists).slice(0, RERANK_POOL).slice(0, take)
}

/**
 * Применяет ответ реранкера к списку id.
 * Реранкер возвращает номера кандидатов, не новые id. 2 значит «третий чанк из пула».
 * Номер вне списка или дырка пропускается, а не роняет весь ответ.
 */
export function applyRerank(ids: readonly string[], order: readonly number[]) {
  return order.flatMap((index) => {
    const id = ids[index]
    // flatMap с [] выкидывает плохой номер, с [id] оставляет годный.
    return id ? [id] : []
  })
}

/**
 * Сколько вопросов нашли свой файл среди первых k чанков.
 * rankings[i] — список файлов для вопроса i, gold[i] — правильный файл.
 * recall@5 — это hits / число вопросов. Здесь возвращаются только hits.
 */
export function hitCount(rankings: readonly (readonly string[])[], gold: readonly string[], k: number) {
  return rankings.reduce((sum, sources, index) => sum + (sources.slice(0, k).includes(gold[index] ?? '') ? 1 : 0), 0)
}

/**
 * Сортирует чанки по косинусу с вектором вопроса, лучший первый.
 * Нет векторов корпуса или нет вектора вопроса — пустой список, поиск по смыслу молчит.
 */
function vectorOrder(chunks: readonly Chunk[], vectors: ReadonlyMap<string, readonly number[]> | null, query: readonly number[] | null) {
  if (!vectors || !query) return []
  const scored: { id: string; score: number }[] = []
  for (const chunk of chunks) {
    const vector = vectors.get(chunk.id)
    // Чанк без вектора (дырка кэша) в этот список не входит.
    if (!vector) continue
    scored.push({ id: chunk.id, score: cosine(vector, query) })
  }
  // При равном косинусе порядок фиксируем по id, чтобы выдача не мигала.
  scored.sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  return scored.map((item) => item.id)
}

/**
 * Та же сортировка, что в BM25: больший балл первый, при равенстве id по алфавиту.
 * Отдельная функция, потому что rank.ts не зависит от внутренней сортировки bm25.ts.
 */
function byIdScore(left: [string, number], right: [string, number]) {
  return right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
}
