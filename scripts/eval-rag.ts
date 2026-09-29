/**
 * Считает recall@5 на 25 вопросах, до генерации ответа.
 * Три строки: только вектор, только BM25, гибрид и реранк.
 * Поиск ещё не годится, если гибрид не выше каждого индекса по отдельности.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expandQuery, loadCorpusIndex, loadQuestions, rankedSources } from '../server/rag/corpus.ts'
import { embedApiKey, embedTexts } from '../server/rag/http.ts'
import { hitCount } from '../server/rag/rank.ts'
import { PASSAGE_LIMIT, type GoldQuestion } from '../server/rag/types.ts'

loadDotEnv()

const questions = loadQuestions()
const gold = questions.map((question) => question.document)
const index = await loadCorpusIndex({ embed: 'optional' })
const key = embedApiKey()
if (!index.vectors || !index.model || !key) {
  console.log(index.warning || 'Нет ключа эмбеддингов. Задайте OPENAI_API_KEY или EMBED_API_KEY.')
  const lexical: string[][] = []
  for (const question of questions) {
    lexical.push(await rankedSources(index, expandQuery(question.question), null, question.filter, 'bm25', false))
  }
  console.log(`recall@${PASSAGE_LIMIT} на ${questions.length} вопросах`)
  report('bm25', lexical, gold)
  reportBm25Kind('перефраз', questions, lexical, 'paraphrase')
  reportBm25Kind('точные', questions, lexical, 'exact')
  process.exitCode = 1
} else {
  await measure(index, key, index.model, questions, gold)
}

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
  const vector: string[][] = []
  const lexical: string[][] = []
  const hybrid: string[][] = []
  const rerank = Boolean(process.env.RERANK_API_KEY?.trim() || process.env.COHERE_API_KEY?.trim())

  for (let at = 0; at < rows.length; at += 1) {
    const question = rows[at]
    if (!question) continue
    const queryVector = queryVectors[at] ?? null
    const query = expandQuery(question.question)
    vector.push(await rankedSources(index, query, queryVector, question.filter, 'vector', false))
    lexical.push(await rankedSources(index, query, null, question.filter, 'bm25', false))
    hybrid.push(await rankedSources(index, query, queryVector, question.filter, 'hybrid', rerank))
  }

  console.log(`recall@${PASSAGE_LIMIT} на ${rows.length} вопросах`)
  report('вектор', vector, expected)
  report('bm25', lexical, expected)
  report(rerank ? 'гибрид+реранк' : 'гибрид', hybrid, expected)
  if (!rerank) console.log('реранк пропущен: задайте COHERE_API_KEY или RERANK_API_KEY')
  reportKind('перефраз', rows, vector, lexical, 'paraphrase')
  reportKind('точные', rows, vector, lexical, 'exact')
}

function report(label: string, rankings: readonly (readonly string[])[], expected: readonly string[]) {
  const hits = hitCount(rankings, expected, PASSAGE_LIMIT)
  console.log(`${label.padEnd(16)} ${(hits / expected.length).toFixed(2)}  (${hits}/${expected.length})`)
}

function reportBm25Kind(
  label: string,
  rows: readonly GoldQuestion[],
  rankings: readonly (readonly string[])[],
  kind: GoldQuestion['kind'],
) {
  const picked = rows.flatMap((row, index) => (row.kind === kind ? [index] : []))
  if (picked.length === 0) return
  const expected = picked.map((index) => rows[index]?.document ?? '')
  const hits = hitCount(picked.map((index) => rankings[index] ?? []), expected, PASSAGE_LIMIT)
  console.log(`${label} (${picked.length}): bm25 ${(hits / picked.length).toFixed(2)}`)
}

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

function loadDotEnv() {
  const path = resolve('.env')
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const name = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (process.env[name] === undefined) process.env[name] = value
  }
}
