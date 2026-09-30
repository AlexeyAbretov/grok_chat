/**
 * Считает recall@5 на 25 вопросах, до генерации ответа.
 * Модель чата здесь не вызывается: проверяем только, попал ли нужный файл в топ-5.
 * Три строки: только вектор, только BM25, гибрид и реранк.
 * Поиск ещё не годится, если гибрид не выше каждого индекса по отдельности.
 * Ключи читаются из .env. Без ключа эмбеддингов печатается только BM25 и код выхода 1.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
// expandQuery дописывает синоним. rankedSources возвращает пути файлов в порядке поиска.
import { expandQuery, loadCorpusIndex, loadQuestions, rankedSources } from '../server/rag/corpus.ts'
// Ключ и запрос векторов вопросов. Векторы чанков уже лежат в индексе.
import { embedApiKey, embedTexts } from '../server/rag/http.ts'
// Сколько вопросов нашли свой файл в первых k результатах.
import { hitCount } from '../server/rag/rank.ts'
// k для recall и тип проверочного вопроса.
import { PASSAGE_LIMIT, type GoldQuestion } from '../server/rag/types.ts'

// Сервер читает .env сам. Этот скрипт запускается отдельно, поэтому читает файл здесь.
loadDotEnv()

const questions = loadQuestions()
// gold[i] — файл, который обязан найтись на вопрос i.
const gold = questions.map((question) => question.document)
// optional: нет ключа — индекс всё равно соберётся, только без векторов.
const index = await loadCorpusIndex({ embed: 'optional' })
const key = embedApiKey()
if (!index.vectors || !index.model || !key) {
  // warning — текст сбоя API. Если ключа просто нет, печатаем короткую подсказку.
  console.log(index.warning || 'Нет ключа эмбеддингов. Задайте OPENAI_API_KEY или EMBED_API_KEY.')
  const lexical: string[][] = []
  for (const question of questions) {
    // Вектора вопроса нет, реранк выключен. Остаётся список BM25.
    lexical.push(await rankedSources(index, expandQuery(question.question), null, question.filter, 'bm25', false))
  }
  console.log(`recall@${PASSAGE_LIMIT} на ${questions.length} вопросах`)
  report('bm25', lexical, gold)
  reportBm25Kind('перефраз', questions, lexical, 'paraphrase')
  reportBm25Kind('точные', questions, lexical, 'exact')
  // Код 1: полный замер без векторов не сделан. Цифры BM25 выше уже напечатаны.
  process.exitCode = 1
} else {
  await measure(index, key, index.model, questions, gold)
}

/**
 * Полный замер трёх режимов.
 * Векторы всех вопросов считаем одним вызовом: так меньше запросов к API.
 */
async function measure(
  index: Awaited<ReturnType<typeof loadCorpusIndex>>,
  key: string,
  model: string,
  rows: readonly GoldQuestion[],
  expected: readonly string[],
) {
  const queryVectors = await embedTexts(
    rows.map((question) => expandQuery(question.question)),
    key,
    model,
  )
  // Три параллельных списка выдач. Индекс в массиве — номер вопроса.
  const vector: string[][] = []
  const lexical: string[][] = []
  const hybrid: string[][] = []
  // Реранк включаем только если ключ Cohere задан. Иначе гибрид остаётся слиянием списков.
  const rerank = Boolean(process.env.RERANK_API_KEY?.trim() || process.env.COHERE_API_KEY?.trim())

  for (let at = 0; at < rows.length; at += 1) {
    const question = rows[at]
    if (!question) continue
    // Вектор этого вопроса. Дырка в ответе API не должна ронять весь цикл.
    const queryVector = queryVectors[at] ?? null
    const query = expandQuery(question.question)
    // Один и тот же фильтр вопроса во всех трёх режимах, иначе цифры нельзя сравнивать.
    vector.push(await rankedSources(index, query, queryVector, question.filter, 'vector', false))
    lexical.push(await rankedSources(index, query, null, question.filter, 'bm25', false))
    hybrid.push(await rankedSources(index, query, queryVector, question.filter, 'hybrid', rerank))
  }

  console.log(`recall@${PASSAGE_LIMIT} на ${rows.length} вопросах`)
  report('вектор', vector, expected)
  report('bm25', lexical, expected)
  report(rerank ? 'гибрид+реранк' : 'гибрид', hybrid, expected)
  if (!rerank) console.log('реранк пропущен: задайте COHERE_API_KEY или RERANK_API_KEY')
  // Отдельные цифры по видам вопросов: перефраз проверяет смысл, точные — редкое слово.
  reportKind('перефраз', rows, vector, lexical, 'paraphrase')
  reportKind('точные', rows, vector, lexical, 'exact')
}

/** Печатает долю попаданий: hits / число вопросов, и ту же дробь в скобках. */
function report(label: string, rankings: readonly (readonly string[])[], expected: readonly string[]) {
  const hits = hitCount(rankings, expected, PASSAGE_LIMIT)
  // padEnd выравнивает подписи, чтобы доли стояли столбиком.
  console.log(`${label.padEnd(16)} ${(hits / expected.length).toFixed(2)}  (${hits}/${expected.length})`)
}

/** Та же доля, но только по вопросам одного kind, и только для BM25. Нужна ветке без ключа эмбеддингов. */
function reportBm25Kind(
  label: string,
  rows: readonly GoldQuestion[],
  rankings: readonly (readonly string[])[],
  kind: GoldQuestion['kind'],
) {
  // Номера вопросов нужного вида. Сами выдачи достаём по этим номерам.
  const picked = rows.flatMap((row, index) => (row.kind === kind ? [index] : []))
  if (picked.length === 0) return
  const expected = picked.map((index) => rows[index]?.document ?? '')
  const hits = hitCount(picked.map((index) => rankings[index] ?? []), expected, PASSAGE_LIMIT)
  console.log(`${label} (${picked.length}): bm25 ${(hits / picked.length).toFixed(2)}`)
}

/** Доли вектора и BM25 на вопросах одного kind. Гибрид сюда не входит: его цифра уже в общей строке. */
function reportKind(
  label: string,
  rows: readonly GoldQuestion[],
  vectorRanks: readonly (readonly string[])[],
  lexicalRanks: readonly (readonly string[])[],
  kind: GoldQuestion['kind'],
) {
  const picked = rows.flatMap((row, index) => (row.kind === kind ? [index] : []))
  if (picked.length === 0) return
  const expected = picked.map((index) => rows[index]?.document ?? '')
  const vectorHits = hitCount(picked.map((index) => vectorRanks[index] ?? []), expected, PASSAGE_LIMIT)
  const lexicalHits = hitCount(picked.map((index) => lexicalRanks[index] ?? []), expected, PASSAGE_LIMIT)
  console.log(`${label} (${picked.length}): вектор ${(vectorHits / picked.length).toFixed(2)}, bm25 ${(lexicalHits / picked.length).toFixed(2)}`)
}

/**
 * Кладёт переменные из .env в process.env, не затирая уже заданные в оболочке.
 * Формат строки: ИМЯ=значение. Кавычки вокруг значения снимаются.
 */
function loadDotEnv() {
  const path = resolve('.env')
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    // Пустая строка и комментарий # не являются переменными.
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    // Строка без знака = или со знаком в начале имени пропускается.
    if (eq <= 0) continue
    const name = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    // "значение" и 'значение' храним без кавычек, как это делает обычный dotenv.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    // Уже заданная переменная окружения важнее файла: так можно временно подменить ключ.
    if (process.env[name] === undefined) process.env[name] = value
  }
}
