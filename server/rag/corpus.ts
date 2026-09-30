// existsSync и остальные — чтение корпуса и запись кэша векторов на диск.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
// join склеивает папку и имя файла, resolve делает путь от текущей рабочей папки проекта.
import { join, resolve } from 'node:path'
// BM25: нарезка на слова, постройка индекса и его тип.
import { buildBm25, tokens, type Bm25Index } from './bm25.ts'
// Разбор markdown и нарезка на чанки.
import { chunkDocument, parseDocument } from './chunk.ts'
// Сеть: ключи, эмбеддинги и реранк.
import { embedApiKey, embedModel, embedTexts, rerankApiKey, rerankTexts } from './http.ts'
// Сборка текста, который увидит чат-модель.
import { passagesFromChunks, passagesPrompt } from './prompt.ts'
// Сортировка id и применение порядка реранкера.
import { applyRerank, rankChunkIds } from './rank.ts'
import {
  // 5 фрагментов в промпт.
  PASSAGE_LIMIT,
  // 24 кандидата, если дальше будет реранк.
  RERANK_POOL,
  type Chunk,
  type Document,
  type GoldQuestion,
  type SearchFilter,
  type SearchMode,
} from './types.ts'

/**
 * Сборка корпуса и ответ на один вопрос.
 * Корпус — коллекция текстов для поиска, папка corpus/docs/. Файл questions.json
 * в той же папке corpus/ — не часть корпуса, а 25 вопросов с известным ответом.
 * Чанки и BM25 считаются локально. Векторы кэшируются в data/rag-index.json,
 * чтобы каждый запуск чата не платил за эмбеддинги заново.
 * В чат уходит гибрид: BM25 и векторы, затем реранк, если есть ключ Cohere.
 */
// Папка markdown-файлов. resolve привязывает её к папке, из которой запущен сервер.
const DOCS_DIR = resolve('corpus/docs')
// 25 проверочных вопросов с известным правильным файлом.
const QUESTIONS_PATH = resolve('corpus/questions.json')
// Кэш векторов. В git его обычно не кладут: он большой и зависит от модели.
const CACHE_PATH = resolve('data/rag-index.json')

/**
 * Всё, что нужно, чтобы ответить на вопрос без повторного чтения файлов.
 * vectors и model равны null, если эмбеддинги не посчитались: тогда остаётся только BM25.
 */
export type CorpusIndex = {
  /** Все чанки всех документов. */
  chunks: Chunk[]
  /** Индекс по словам тех же чанков. */
  bm25: Bm25Index
  /** id чанка -> вектор. null значит «поиск по смыслу выключен». */
  vectors: Map<string, number[]> | null
  /** Имя модели, которой считали векторы. Вопрос эмбеддим той же моделью. */
  model: string | null
  /** Текст сбоя эмбеддингов для лога. null значит «сбоя не было». */
  warning: string | null
}

/** Как грузить индекс. embed=required нужен, когда без векторов продолжать нельзя. */
type LoadOptions = {
  embed?: 'optional' | 'required'
  /** Отмена, если пользователь закрыл ответ, пока индекс ещё строится. */
  signal?: AbortSignal
}

// Память процесса: тот же корпус и тот же режим эмбеддингов не строим второй раз.
let memo: { fingerprint: string; embed: 'optional' | 'required'; index: CorpusIndex } | null = null
// Обещание текущей сборки. Второй вызов во время сборки ждёт его, а не стартует свою.
let pending: Promise<CorpusIndex> | null = null

/**
 * Читает все markdown-файлы корпуса.
 * Нет папки — пустой список, чат просто ответит без фрагментов.
 * Сортировка по имени делает порядок чанков одинаковым на любой машине.
 */
export function loadDocuments(): Document[] {
  if (!existsSync(DOCS_DIR)) return []
  return readdirSync(DOCS_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((name) => parseDocument(`corpus/docs/${name}`, readFileSync(join(DOCS_DIR, name), 'utf8')))
}

/**
 * Читает проверочные вопросы. Их ровно 25: recall считается на фиксированном наборе.
 * Битый JSON или лишний вопрос роняют проверку сразу, а не тихо портят цифру.
 */
export function loadQuestions(): GoldQuestion[] {
  const parsed = JSON.parse(readFileSync(QUESTIONS_PATH, 'utf8')) as unknown
  if (!Array.isArray(parsed) || parsed.length !== 25) throw new Error('Нужно 25 вопросов')
  return parsed.map(readQuestion)
}

/**
 * Возвращает готовый индекс корпуса.
 * Повторный вызов с тем же отпечатком файлов отдаёт память.
 * Два одновременных вызова делят одну сборку через pending.
 */
export function loadCorpusIndex(options: LoadOptions = {}): Promise<CorpusIndex> {
  // В чате эмбеддинги необязательны: нет ключа — ответим по BM25.
  const embed = options.embed ?? 'optional'
  // Отпечаток файлов: размер и время правки. Сменился файл — старые векторы не подходят.
  const fingerprint = corpusFingerprint()
  if (memo?.fingerprint === fingerprint && memo.embed === embed) return Promise.resolve(memo.index)
  if (!pending) {
    pending = buildIndex(fingerprint, embed, options.signal)
      .then((index) => {
        // Запоминаем только удачную сборку. Ошибка сюда не попадает: then не вызовется.
        memo = { fingerprint, embed, index }
        return index
      })
      .finally(() => {
        // Сборку отпускаем и после успеха, и после ошибки, иначе следующий вызов ждал бы навсегда.
        pending = null
      })
  }
  return pending
}

/**
 * Синоним на стороне запроса, файл корпуса не меняется.
 * «Место» в вопросе значит складскую ячейку, а в корпусе написано «ячейка».
 * Дописанное слово ищут и BM25, и эмбеддинг, и реранкер: все три видят одну строку.
 */
export function expandQuery(query: string) {
  // tokens режет вопрос так же, как индекс. «Вместо» не содержит токен «место».
  const hasPlace = tokens(query).some((token) => token === 'место')
  return hasPlace ? `${query} ячейка` : query
}

/**
 * Текст, который дописывается в системный промпт перед ответом модели.
 * Пустой вопрос и пустой корпус дают null: промпт остаётся обычным.
 * Возвращает ещё режим поиска и предупреждение, их пишет лог сервера.
 */
export async function corpusContext(question: string, signal?: AbortSignal) {
  const trimmed = question.trim()
  if (!trimmed) return null
  // Синоним дописываем до эмбеддинга и до BM25.
  const query = expandQuery(trimmed)
  // optional: сбой эмбеддингов не должен ронять весь ответ чата.
  const index = await loadCorpusIndex({ embed: 'optional', signal })
  if (index.chunks.length === 0) return null
  // Вектор вопроса той же моделью, что и чанки. null — дальше только слова.
  const queryVector = await queryVectorFor(index, query, signal)
  // Реранк имеет смысл, когда есть и смысл (вектор), и ключ Cohere.
  let rerank = Boolean(queryVector && rerankApiKey())
  // Нет вектора вопроса — гибрид не из чего слить, остаётся BM25.
  const mode: SearchMode = queryVector ? 'hybrid' : 'bm25'
  let ids: string[]
  try {
    ids = await rankedIds(index, query, queryVector, undefined, mode, rerank, signal)
  } catch (error) {
    // Отмена или ошибка без реранка — наружу. Сбой реранка не должен оставлять чат без ответа.
    if (signal?.aborted || !rerank) throw error
    rerank = false
    // Повтор без реранка: остаются места после слияния BM25 и векторов.
    ids = await rankedIds(index, query, queryVector, undefined, mode, false, signal)
  }
  // Словарь id -> чанк, чтобы восстановить текст по списку id.
  const byId = new Map(index.chunks.map((chunk) => [chunk.id, chunk]))
  // flatMap выкидывает id, которого уже нет в индексе, и оставляет чанки в порядке поиска.
  const hits = ids.flatMap((id) => {
    const chunk = byId.get(id)
    return chunk ? [chunk] : []
  })
  // Несколько окон одной секции здесь схлопываются в один фрагмент.
  const passages = passagesFromChunks(hits)
  const text = passagesPrompt(passages)
  if (!text) return null
  // mode в логе отличает гибрид с реранком от голого гибрида и от одного BM25.
  return { text, mode: rerank ? 'hybrid+rerank' : mode, count: passages.length, warning: index.warning }
}

/**
 * То же ранжирование, что у чата, но наружу отдаёт пути файлов, не id чанков.
 * Нужно подсчёту recall: правильный ответ записан как путь документа.
 */
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
 * hybrid сливает верхние 30 и, если просили реранк, пересортировывает до 24 кандидатов,
 * а в ответ всё равно кладёт не больше 5.
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
    // Перед реранком нужен широкий пул. Без реранка сразу режем до пяти.
    take: mode === 'hybrid' && rerank ? RERANK_POOL : PASSAGE_LIMIT,
  })
  if (mode !== 'hybrid' || !rerank) return ids.slice(0, PASSAGE_LIMIT)
  const key = rerankApiKey()
  // Ключ могли забрать между проверкой и вызовом. Тогда оставляем порядок слияния.
  if (!key) return ids.slice(0, PASSAGE_LIMIT)
  // Реранкеру нужен текст кандидата, не id. Дырка заменяется пустой строкой.
  const byId = new Map(index.chunks.map((chunk) => [chunk.id, chunk.text]))
  const texts = ids.map((id) => byId.get(id) ?? '')
  // Просим не больше пяти лучших номеров: в промпт всё равно больше не влезет.
  const order = await rerankTexts(query, texts, key, Math.min(PASSAGE_LIMIT, texts.length), signal)
  // order — номера внутри ids. applyRerank превращает их обратно в id чанков.
  return applyRerank(ids, order).slice(0, PASSAGE_LIMIT)
}

/**
 * Вектор одного вопроса той же моделью, что векторы чанков.
 * Нет кэша, ключа или имени модели — null, и поиск пойдёт по словам.
 * Сбой сети тоже даёт null: чат не должен падать из-за эмбеддинга вопроса.
 * Отмену не прячем: закрытый ответ нужно прекратить, а не искать дальше.
 */
async function queryVectorFor(index: CorpusIndex, query: string, signal?: AbortSignal) {
  const key = embedApiKey()
  if (!index.vectors || !key || !index.model) return null
  try {
    // embedTexts всегда возвращает массив. Берём первый и единственный вектор.
    return (await embedTexts([query], key, index.model, signal))[0] ?? null
  } catch (error) {
    if (signal?.aborted) throw error
    return null
  }
}

/**
 * Собирает индекс с нуля или из кэша.
 * embed=required бросает ошибку без ключа и при сбое API.
 * embed=optional в тех же случаях возвращает индекс только с BM25 и текст предупреждения.
 */
async function buildIndex(fingerprint: string, embed: 'optional' | 'required', signal?: AbortSignal): Promise<CorpusIndex> {
  // Каждый документ режется на чанки, списки склеиваются в один.
  const chunks = loadDocuments().flatMap((doc) => chunkDocument(doc))
  // Индекс слов считается всегда, даже когда векторы тоже будут.
  const bm25 = buildBm25(chunks)
  const model = embedModel()
  const key = embedApiKey()
  if (!key) {
    if (embed === 'required') throw new Error('Нет ключа эмбеддингов. Задайте OPENAI_API_KEY или EMBED_API_KEY.')
    // warning здесь null: ключа просто нет, это не сбой запроса.
    return { chunks, bm25, vectors: null, model: null, warning: null }
  }
  // Кэш подходит, только если файлы и модель те же и вектор есть у каждого чанка.
  const cached = readCache(fingerprint, model, chunks)
  if (cached) return { chunks, bm25, vectors: cached, model, warning: null }
  try {
    // В API уходит text чанка: короткий кусок, по которому потом ищем, не вся секция.
    const embedded = await embedTexts(chunks.map((chunk) => chunk.text), key, model, signal)
    if (embedded.length !== chunks.length) throw new Error('Эмбеддинги вернули другой размер')
    const vectors = new Map<string, number[]>()
    chunks.forEach((chunk, index) => {
      const vector = embedded[index]
      // Пустую ячейку в Map не кладём. readCache потом потребует вектор у каждого id.
      if (vector) vectors.set(chunk.id, vector)
    })
    writeCache(fingerprint, model, vectors)
    return { chunks, bm25, vectors, model, warning: null }
  } catch (error) {
    // Отмена и обязательный режим не превращаем в тихий индекс без векторов.
    if (signal?.aborted || embed === 'required') throw error
    const message = errorText(error)
    // Чат продолжит на BM25, а лог покажет, почему векторов нет.
    return { chunks, bm25, vectors: null, model: null, warning: message }
  }
}

/** Текст ошибки для лога. Если внутри есть cause (сеть Node), дописываем и его. */
function errorText(error: unknown) {
  if (!(error instanceof Error)) return 'эмбеддинги недоступны'
  const cause = error.cause
  if (cause instanceof Error && cause.message) return `${error.message}: ${cause.message}`
  return error.message
}

/** Проверяет один объект из questions.json и собирает GoldQuestion. index нужен только для текста ошибки. */
function readQuestion(value: unknown, index: number): GoldQuestion {
  // JSON.parse даёт unknown. Сначала убеждаемся, что это объект, не массив и не null.
  const row = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  const question = row?.question
  const document = row?.document
  const kind = row?.kind
  if (typeof question !== 'string' || !question.trim()) throw new Error(`Пустой вопрос ${index + 1}`)
  // Правильный ответ — путь внутри корпуса, а не произвольная строка.
  if (typeof document !== 'string' || !document.startsWith('corpus/docs/')) throw new Error(`Нет документа у вопроса ${index + 1}`)
  if (kind !== 'paraphrase' && kind !== 'exact') throw new Error(`Неверный kind у вопроса ${index + 1}`)
  const filter = readFilter(row?.filter, index)
  // Поле filter не кладём, если его не было: так объект совпадает с типом без фильтра.
  return filter ? { question, document, kind, filter } : { question, document, kind }
}

/** Читает необязательный фильтр вопроса. null и отсутствие поля значат «фильтра нет». */
function readFilter(value: unknown, index: number): SearchFilter | undefined {
  if (value == null) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Неверный фильтр у вопроса ${index + 1}`)
  const row = value as Record<string, unknown>
  const filter: SearchFilter = {}
  // Берём только известные поля. Лишние ключи в JSON игнорируем.
  for (const key of ['type', 'section', 'dateFrom', 'dateTo'] as const) {
    const item = row[key]
    if (item == null) continue
    if (typeof item !== 'string' || !item.trim()) throw new Error(`Неверный фильтр у вопроса ${index + 1}`)
    filter[key] = item
  }
  return filter
}

/**
 * Подпись файлов корпуса. Поменялся размер или время — векторы в кэше больше не подходят.
 * В подпись входят имя, размер и mtime. Содержимое целиком не хешируем: stat дешевле чтения.
 */
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

/**
 * Читает кэш векторов. Любая несостыковка даёт null, и векторы посчитают заново.
 * null здесь не ошибка: битый файл кэша просто не используем.
 */
function readCache(fingerprint: string, model: string, chunks: readonly Chunk[]) {
  if (!existsSync(CACHE_PATH)) return null
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as {
      version?: number
      model?: string
      fingerprint?: string
      vectors?: { id?: string; vector?: unknown }[]
    }
    // Версия 1, та же модель и тот же отпечаток файлов. Иначе кэш от другого корпуса.
    if (parsed.version !== 1 || parsed.model !== model || parsed.fingerprint !== fingerprint || !Array.isArray(parsed.vectors)) return null
    const map = new Map<string, number[]>()
    for (const item of parsed.vectors) {
      if (!item || typeof item.id !== 'string' || !Array.isArray(item.vector)) return null
      const vector = item.vector.map((value) => {
        // throw внутри map попадёт в catch ниже и тоже даст null.
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('cache')
        return value
      })
      map.set(item.id, vector)
    }
    // Новый чанк без вектора делает весь кэш непригодным: дырку поиском не закрыть.
    if (chunks.some((chunk) => !map.has(chunk.id))) return null
    return map
  } catch {
    return null
  }
}

/** Пишет кэш одной записью. Папку data создаём, если сервер запущен в первый раз. */
function writeCache(fingerprint: string, model: string, vectors: Map<string, number[]>) {
  mkdirSync(resolve('data'), { recursive: true })
  const payload = {
    version: 1,
    model,
    fingerprint,
    // Map в JSON сам не сериализуется, поэтому раскладываем пары в массив.
    vectors: [...vectors].map(([id, vector]) => ({ id, vector })),
  }
  writeFileSync(CACHE_PATH, JSON.stringify(payload))
}
