/**
 * Внешние модели поиска. Сам поиск по корпусу считается локально, эти функции только ходят в API.
 * Эмбеддинг превращает текст в вектор смысла: близкие по смыслу фразы получают близкие векторы.
 * Реранкер читает вопрос и кандидата вместе и ставит пару точнее, но дороже: один вызов на вопрос.
 */
// Куда слать тексты, чтобы получить векторы. Можно переопределить через EMBED_URL.
const EMBED_URL = 'https://api.openai.com/v1/embeddings'
// Куда слать вопрос и кандидатов, чтобы получить новый порядок. Можно переопределить через RERANK_URL.
const RERANK_URL = 'https://api.cohere.com/v2/rerank'
// Маленькая модель эмбеддингов: дешевле большой и достаточна для коротких чанков.
const EMBED_MODEL = 'text-embedding-3-small'
// Модель реранка Cohere. Можно переопределить через RERANK_MODEL.
const RERANK_MODEL = 'rerank-v3.5'
// Сколько текстов кладём в один запрос эмбеддингов. Весь корпус больше, поэтому идём пачками.
const BATCH = 128
/**
 * Пробный ключ Cohere: 10 вызовов в минуту.
 * Пауза 7 секунд между реранками остаётся под этим лимитом (60 / 7 ≈ 8 вызовов).
 */
const RERANK_GAP_MS = 7_000
// Если сервер не сказал, сколько ждать, ждём минуту. Дольше минуты за один ответ чата не ждём.
const RERANK_RETRY_MS = 60_000

// Время последнего старта реранка. 0 значит «ещё не вызывали», паузу тогда не держим.
let lastRerankAt = 0
/**
 * Очередь реранков. Два вопроса подряд не стартуют вместе и не пробивают лимит.
 * Хвост — уже завершённый промис, поэтому первый вызов не ждёт никого.
 */
let rerankTail: Promise<void> = Promise.resolve()

/** Ключ эмбеддингов. Свой EMBED_API_KEY важнее общего ключа OpenAI. Пустая строка значит «ключа нет». */
export function embedApiKey() {
  return (process.env.EMBED_API_KEY || process.env.OPENAI_API_KEY || '').trim()
}

/** Ключ реранкера. Свой RERANK_API_KEY важнее общего ключа Cohere. */
export function rerankApiKey() {
  return (process.env.RERANK_API_KEY || process.env.COHERE_API_KEY || '').trim()
}

/** Имя модели эмбеддингов. Из .env, если задано, иначе text-embedding-3-small. */
export function embedModel() {
  return process.env.EMBED_MODEL?.trim() || EMBED_MODEL
}

/**
 * Считает векторы для списка текстов.
 * Пачки по BATCH, порядок ответов сохраняется: vectors[i] соответствует texts[i].
 * signal позволяет оборвать запрос, если пользователь закрыл ответ чата.
 */
export async function embedTexts(texts: readonly string[], apiKey: string, model = embedModel(), signal?: AbortSignal) {
  const vectors: number[][] = []
  // start прыгает на BATCH: 0, 128, 256, ... пока тексты не кончатся.
  for (let start = 0; start < texts.length; start += BATCH) {
    const batch = texts.slice(start, start + BATCH)
    // Один POST на пачку. Поле input — массив строк, не одна строка.
    const payload = await postJson(
      process.env.EMBED_URL?.trim() || EMBED_URL,
      apiKey,
      { model, input: batch },
      'Эмбеддинги',
      signal,
    )
    // Разбор ответа дописывает векторы в том же порядке, что и тексты пачки.
    vectors.push(...readEmbeddings(payload, batch.length))
  }
  return vectors
}

/**
 * Сколько миллисекунд ждать перед повтором после ответа 429.
 * Заголовок Retry-After бывает числом секунд или датой. now нужен, чтобы дату превратить в паузу.
 */
export function retryAfterMs(header: string | null, now = Date.now()) {
  // Сервер не прислал заголовок — ждём запасную минуту.
  if (!header) return RERANK_RETRY_MS
  const seconds = Number(header)
  // Конечное положительное число читаем как секунды и не даём паузе превысить минуту.
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(RERANK_RETRY_MS, seconds * 1000)
  const date = Date.parse(header)
  // Дата в заголовке: ждём разницу с now, но не отрицательную и не дольше минуты.
  if (Number.isFinite(date)) return Math.min(RERANK_RETRY_MS, Math.max(0, date - now))
  // Ни секунды, ни даты — снова запасная минута.
  return RERANK_RETRY_MS
}

/**
 * Ставит реранк в очередь и возвращает номера документов от лучшего к худшему.
 * topN — сколько лучших номеров просим у модели. Сами тексты она не переписывает.
 */
export async function rerankTexts(query: string, texts: readonly string[], apiKey: string, topN: number, signal?: AbortSignal) {
  // Нечего ранжировать — пустой порядок, сеть не трогаем.
  if (texts.length === 0) return []
  // job стартует только когда доделается предыдущий реранк. Ошибка предыдущего очередь не блокирует.
  const job = rerankTail.then(() => pacedRerank(query, texts, apiKey, topN, signal))
  // Хвост очереди не хранит результат и не хранит ошибку: следующему важно лишь «предыдущий закончился».
  rerankTail = job.then(
    () => undefined,
    () => undefined,
  )
  return job
}

/**
 * Один реранк с паузой и одним повтором на 429 (слишком много запросов).
 * Другие ошибки и отмена пользователем наружу летят сразу.
 */
async function pacedRerank(query: string, texts: readonly string[], apiKey: string, topN: number, signal?: AbortSignal) {
  // Держим паузу от прошлого вызова до старта этого.
  await waitGap(signal)
  try {
    return await requestRerank(query, texts, apiKey, topN, signal)
  } catch (error) {
    // Отмена или любая ошибка кроме 429 — не повторяем.
    if (signal?.aborted || httpStatus(error) !== 429) throw error
    // 429: ждём Retry-After, снова держим минимальную паузу и пробуем один раз.
    await sleep(retryAfterMs(retryHeader(error)), signal)
    await waitGap(signal)
    return requestRerank(query, texts, apiKey, topN, signal)
  }
}

/** Сам HTTP-запрос реранка без пауз и повторов. Повторы живут в pacedRerank. */
async function requestRerank(query: string, texts: readonly string[], apiKey: string, topN: number, signal?: AbortSignal) {
  const payload = await postJson(
    process.env.RERANK_URL?.trim() || RERANK_URL,
    apiKey,
    // documents — кандидаты по порядку. Ответ потом ссылается на них номерами.
    { model: process.env.RERANK_MODEL?.trim() || RERANK_MODEL, query, documents: texts, top_n: topN },
    'Реранк',
    signal,
  )
  return readRerank(payload, texts.length)
}

/**
 * Ждёт, пока с прошлого реранка пройдёт RERANK_GAP_MS.
 * Время старта записываем до запроса: параллельный вызов уже увидит занятое окно.
 */
async function waitGap(signal?: AbortSignal) {
  const rest = RERANK_GAP_MS - (Date.now() - lastRerankAt)
  // Первый вызов (lastRerankAt === 0) и случай «пауза уже прошла» не ждут.
  if (lastRerankAt > 0 && rest > 0) await sleep(rest, signal)
  lastRerankAt = Date.now()
}

/** Пауза, которую можно оборвать через signal. Ноль и отрицательное время завершаются сразу. */
function sleep(ms: number, signal?: AbortSignal) {
  if (ms <= 0) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    // Отмена снимает таймер, иначе промис висел бы до конца паузы после закрытия чата.
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

/** Ошибка отмены. Имя AbortError нужно, чтобы вызывающий код отличил отмену от сбоя сети. */
function abortError() {
  const error = new Error('Реранк отменён')
  error.name = 'AbortError'
  return error
}

/**
 * POST JSON и разбор ответа.
 * label попадает в текст ошибки, чтобы было видно, упали эмбеддинги или реранк.
 * parent — отмена чата. Свой таймер на 60 секунд не даёт запросу висеть бесконечно.
 */
async function postJson(url: string, apiKey: string, body: unknown, label: string, parent?: AbortSignal) {
  const timed = deadline(60_000, parent)
  try {
    const response = await fetch(url, {
      method: 'POST',
      // Bearer — обычная схема ключа и у OpenAI, и у Cohere.
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: timed.signal,
    })
    // Тело читаем как текст: и удачный JSON, и текст ошибки сервера приходят одной строкой.
    const raw = await response.text()
    if (!response.ok) throw httpFailure(label, response.status, response.headers.get('retry-after'), raw)
    return JSON.parse(raw) as unknown
  } catch (error) {
    // Сработал наш таймер, а пользователь чат не закрывал — это таймаут, не чужая ошибка.
    if (!parent?.aborted && timed.signal.aborted) throw new Error(`${label}: таймаут`)
    throw error
  } finally {
    // Таймер и слушатель отмены снимаем и при успехе, и при ошибке.
    timed.done()
  }
}

/**
 * AbortController, который сработает через ms или когда сработает parent.
 * done() обязателен: иначе таймер держал бы процесс после уже готового ответа.
 */
function deadline(ms: number, parent?: AbortSignal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  const onAbort = () => controller.abort()
  // Родитель уже отменён — отменяем сразу, слушатель вешать поздно.
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

/**
 * Достаёт векторы из ответа OpenAI.
 * В ответе у каждого элемента есть index: пачка может прийти не по порядку строк.
 * count — сколько векторов мы ждём. Другое число значит, что ответ битый.
 */
function readEmbeddings(payload: unknown, count: number) {
  const data = record(payload)?.data
  if (!Array.isArray(data) || data.length !== count) throw new Error('Эмбеддинги: неожиданный размер')
  // Массив заранее нужной длины: дырка по индексу останется пустой и поймается ниже.
  const vectors = new Array<number[]>(count)
  for (const item of data) {
    const row = record(item)
    const index = row?.index
    const embedding = row?.embedding
    // Индекс вне пачки или эмбеддинг не массив — ответ нельзя класть в кэш.
    if (typeof index !== 'number' || index < 0 || index >= count || !Array.isArray(embedding)) throw new Error('Эмбеддинги: нет вектора')
    vectors[index] = embedding.map((value) => {
      // NaN и Infinity сломали бы косинус. Такое число в кэш не пишем.
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Эмбеддинги: не число')
      return value
    })
  }
  // some ловит пропущенный index: ячейка так и осталась пустой.
  if (vectors.some((vector) => !vector?.length)) throw new Error('Эмбеддинги: пропущен индекс')
  return vectors
}

/**
 * Достаёт порядок из ответа Cohere.
 * Каждый элемент — index исходного документа и балл. Наружу уходят только индексы, лучший первый.
 */
function readRerank(payload: unknown, count: number) {
  const results = record(payload)?.results
  if (!Array.isArray(results)) throw new Error('Реранк: нет results')
  const ranked: { index: number; score: number }[] = []
  for (const item of results) {
    const row = record(item)
    const index = row?.index
    // У разных версий API балл называется relevance_score или score. Берём тот, что есть.
    const score = typeof row?.relevance_score === 'number' ? row.relevance_score : row?.score
    // Индекс вне пула кандидатов применять нельзя: он показал бы на чужой чанк.
    if (typeof index !== 'number' || index < 0 || index >= count || typeof score !== 'number') throw new Error('Реранк: нет индекса')
    ranked.push({ index, score })
  }
  // Больший балл первый. При равенстве меньший исходный индекс, чтобы порядок был стабильным.
  ranked.sort((left, right) => right.score - left.score || left.index - right.index)
  return ranked.map((item) => item.index)
}

/**
 * Ошибка HTTP с полями, которые читает повтор на 429.
 * В сообщение кладём только начало тела: полный ответ может быть длинным и с лишними данными.
 */
function httpFailure(label: string, status: number, retryAfter: string | null, raw: string) {
  const error = new Error(`${label}: HTTP ${status} ${raw.slice(0, 180)}`) as Error & { status: number; retryAfter: string | null }
  error.status = status
  error.retryAfter = retryAfter
  return error
}

/** Достаёт код HTTP из ошибки postJson. Чужая ошибка без поля status даёт 0, и повтор не включится. */
function httpStatus(error: unknown) {
  if (!error || typeof error !== 'object' || !('status' in error)) return 0
  return typeof error.status === 'number' ? error.status : 0
}

/** Достаёт заголовок Retry-After, который мы сами положили на ошибку. Нет поля — null. */
function retryHeader(error: unknown) {
  if (!error || typeof error !== 'object' || !('retryAfter' in error)) return null
  return typeof error.retryAfter === 'string' ? error.retryAfter : null
}

/** Узкая проверка «это обычный объект, не null и не массив». Массив сюда не подходит: у него нет полей ответа. */
function record(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}
