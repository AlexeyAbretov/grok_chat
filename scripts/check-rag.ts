// Скрипт без сети: проверяет нарезку, BM25, слияние списков, фильтр, синоним и сборку промпта.
// Запуск падает на первом несовпавшем assert. В конце печатает rag ok.

// tokens режет текст так же, как индекс. buildBm25 строит маленький индекс прямо в тесте.
import { buildBm25, tokens } from '../server/rag/bm25.ts'
// Проверка разбора заголовка Retry-After, без настоящего запроса в Cohere.
import { retryAfterMs } from '../server/rag/http.ts'
// Разбор шапки и нарезка документа на чанки.
import { chunkDocument, parseDocument } from '../server/rag/chunk.ts'
// Чтение настоящего корпуса и подстановка слова «ячейка».
import { expandQuery, loadDocuments, loadQuestions } from '../server/rag/corpus.ts'
// Сборка фрагментов, которые увидела бы модель.
import { passagesFromChunks, passagesPrompt } from '../server/rag/prompt.ts'
// Сортировка, слияние, реранк и подсчёт попаданий.
import { applyRerank, hitCount, rankChunkIds, reciprocalRankFusion } from '../server/rag/rank.ts'
// Тип чанка нужен помощнику sample, который собирает фиктивный чанк.
import type { Chunk } from '../server/rag/types.ts'

/** Падает с message, если условие ложно. Так тест показывает, какое правило RAG сломалось. */
function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

// Два списка: в первом b на втором месте, во втором b на первом. Общий высокий b должен победить.
const fused = reciprocalRankFusion([
  ['a', 'b'],
  ['b', 'c'],
])
// b есть в обоих, a только в первом на месте 1, c только во втором на месте 2.
assert(fused[0] === 'b' && fused[1] === 'a' && fused[2] === 'c', 'fusion prefers a chunk that both lists rank high')

// Минимальный файл с шапкой и двумя секциями. Так проверяем разбор без чтения диска.
const heading = parseDocument(
  'corpus/docs/sample.md',
  ['---', 'type: note', 'date: 2026-01-02', 'section: rag', 'title: Общее', '---', '', '# Один', '', 'Абзац один.', '', '# Два', '', 'Абзац два.'].join('\n'),
)
// Два коротких абзаца под двумя заголовками дают два чанка.
const headed = chunkDocument(heading)
assert(headed.length === 2, 'headings become two chunks')
assert(headed[0]?.title === 'Один' && headed[1]?.title === 'Два', 'a chunk keeps its heading')
// Разные секции не должны схлопнуться в один фрагмент промпта.
assert(headed[0]?.parentId !== headed[1]?.parentId, 'sections have different parents')
assert(headed[0]?.source === 'corpus/docs/sample.md' && headed[0].parentText.includes('Абзац один.'), 'a chunk keeps its source and parent text')

// Маркер стоит на стыке окон. Перекрытие обязано оставить его в двух соседних чанках.
const marker = 'СТЫК'
const wide = parseDocument(
  'corpus/docs/wide.md',
  ['---', 'type: note', 'date: 2026-01-02', 'section: rag', 'title: Длинное', '---', '', `${'а'.repeat(22)}${marker}${'б'.repeat(40)}`].join('\n'),
)
// Окно 30 и перекрытие 10 маленькие специально: на короткой строке стык виден сразу.
const parts = chunkDocument(wide, { window: 30, overlap: 10 })
assert(parts.length >= 2 && parts.every((chunk) => chunk.parentId === parts[0]?.parentId), 'windows keep one parent')
assert(parts.filter((chunk) => chunk.text.includes(marker)).length >= 2, 'the overlap keeps the boundary word in two windows')

// Файл без шапки — ошибка с путём. Иначе фильтр получил бы пустые поля.
assertThrows(() => parseDocument('corpus/docs/x.md', 'просто текст'), 'Нет шапки: corpus/docs/x.md')

// near ближе по вектору, но из чужого раздела. far дальше, зато из раздела фильтра.
const near = sample('near', 'other', 'чужой')
const far = sample('far', 'git', 'свой')
const index = buildBm25([
  // Точный флаг есть только здесь. Второе предложение содержит те же обычные слова без флага.
  { id: 'flag', text: 'флаг --no-verify пропускает хуки' },
  { id: 'plain', text: 'флаг пропускает хуки без точного имени' },
  { id: near.id, text: near.text },
  { id: far.id, text: far.text },
])
const flagRank = rankChunkIds({
  chunks: [sample('flag', 'git', 'флаг --no-verify пропускает хуки'), sample('plain', 'git', 'флаг пропускает хуки без точного имени')],
  index,
  // Векторов нет: этот тест только про слова.
  vectors: null,
  query: '--no-verify',
  queryVector: null,
  mode: 'bm25',
})
// Редкий токен --no-verify должен перевесить общие слова «флаг» и «хуки».
assert(flagRank[0] === 'flag', 'BM25 ranks the exact flag first')

// Векторы нарочно двумерные: [0, 1] близок к запросу, [1, 0] перпендикулярен ему.
const vectors = new Map<string, number[]>([
  ['near', [0, 1]],
  ['far', [1, 0]],
])
const filtered = rankChunkIds({
  chunks: [near, far],
  index,
  vectors,
  // Слова «кворум» в текстах нет, поэтому решает только вектор. near ближе, но другой раздел.
  query: 'кворум',
  queryVector: [0, 1],
  filter: { section: 'git' },
  mode: 'vector',
  take: 1,
})
assert(filtered.length === 1 && filtered[0] === 'far', 'a closer chunk from another section is dropped before vector search')

const hybrid = rankChunkIds({
  chunks: [sample('alpha', 'rag', 'alpha token'), sample('beta', 'rag', 'beta token')],
  index: buildBm25([
    { id: 'alpha', text: 'alpha token' },
    { id: 'beta', text: 'beta token' },
  ]),
  vectors: new Map([
    ['alpha', [1, 0]],
    ['beta', [0, 1]],
  ]),
  // И слова, и вектор указывают на alpha. Без реранкера побеждает слияние, не отдельный чемпион.
  query: 'alpha token',
  queryVector: [1, 0],
  mode: 'hybrid',
  take: 2,
})
assert(hybrid[0] === 'alpha', 'hybrid without a reranker follows fusion')

// Настоящий корпус маленький специально: промах на 30–50 файлах ещё видно глазами.
const docs = loadDocuments()
assert(docs.length >= 30 && docs.length <= 50, 'the corpus stays small enough to see a miss')
const questions = loadQuestions()
assert(questions.length === 25, 'recall is measured on 25 questions')
// Множество токенов каждого файла: заголовок и тело, без шапки. Так проверяем честность вопросов.
const bySource = new Map(docs.map((doc) => [doc.source, new Set(tokens(`${doc.title}\n${doc.body}`))]))
for (const question of questions) {
  const gold = bySource.get(question.document)
  if (!gold) throw new Error(`missing ${question.document}`)
  const query = tokens(question.question)
  if (question.kind === 'paraphrase') {
    // Длинное общее слово сделало бы «перефраз» обычным поиском по словам. Таких быть не должно.
    const shared = query.filter((token) => token.length >= 5 && gold.has(token))
    assert(shared.length === 0, `paraphrase shares ${shared.join(', ')} with ${question.document}`)
  } else {
    // Точный вопрос обязан содержать редкий токен, который есть только в его файле.
    const unique = query.filter(
      (token) => token.length >= 4 && gold.has(token) && [...bySource].every(([source, set]) => source === question.document || !set.has(token)),
    )
    assert(unique.length > 0, `exact token missing for ${question.document}`)
  }
}
// Хотя бы один вопрос фильтрует и по дате, и по разделу: так проверяем оба поля сразу.
const dated = questions.find((question) => question.filter?.dateFrom)
assert(dated?.filter?.section, 'one question filters by section and date')
const goldDoc = docs.find((doc) => doc.source === dated?.document)
// В том же разделе есть более старый файл. Без фильтра по дате поиск мог бы отдать его.
const older = docs.filter((doc) => doc.section === goldDoc?.section && doc.date < (dated?.filter?.dateFrom ?? ''))
assert(goldDoc && older.length >= 1, 'the date filter has an older document in the same section')

const chunks = docs.flatMap((doc) => chunkDocument(doc))
const parents = new Map<string, number>()
for (const chunk of chunks) {
  // Пустые поля сломали бы и ссылку в промпте, и фильтр.
  assert(chunk.source && chunk.title && chunk.parentId && chunk.parentText, 'a chunk keeps source, title, and parent')
  parents.set(chunk.parentId, (parents.get(chunk.parentId) ?? 0) + 1)
}
// Хотя бы одна секция длиннее одного окна: иначе parentId нечего схлопывать.
assert([...parents.values()].some((count) => count >= 2), 'a parent section has more than one chunk')
const placeIndex = buildBm25(chunks)
const placeArgs = { chunks, index: placeIndex, vectors: null, queryVector: null, mode: 'bm25' as const, take: 5 }
// Голое «место» не должно вытаскивать складские SKU: в них написано «ячейка», не «место».
const plainPlace = rankChunkIds({ ...placeArgs, query: 'место' })
const expandedPlace = rankChunkIds({ ...placeArgs, query: expandQuery('место') })
const placeSource = (id: string) => chunks.find((chunk) => chunk.id === id)?.source ?? ''
assert(!plainPlace.some((id) => placeSource(id).includes('sku-')), 'plain место stays off the sku notes')
assert(expandedPlace.some((id) => placeSource(id) === 'corpus/docs/sku-4419.md'), 'expanded место reaches the screw sku')

// Два чанка одного родителя и третий из другой секции. В промпт должны попасть двое, не трое.
const sibling = passagesFromChunks([
  { ...chunks[0], parentId: 'p', text: 'a', parentText: 'родитель' },
  { ...chunks[0], id: 'other', parentId: 'p', text: 'b', parentText: 'родитель' },
  { ...chunks[0], id: 'third', parentId: 'q', source: 'corpus/docs/other.md', title: 'Второй', parentText: 'другой' },
])
assert(sibling.length === 2 && sibling[0]?.ref === 1 && sibling[1]?.text === 'другой', 'the prompt keeps one parent and the next section')
const prompt = passagesPrompt(sibling)
assert(
  // Промпт нумерует фрагменты, разрешает другие слова и требует честный отказ, если фрагмент не про вопрос.
  prompt.includes('[1] ') && prompt.includes('другими словами') && prompt.includes('«в документах этого нет»'),
  'passages are cited data and a paraphrase still counts',
)
assert(expandQuery('место') === 'место ячейка', 'a place query also searches for a warehouse cell')
// «Вместо» содержит буквы «место», но токен другой. Синоним к нему не клеится.
assert(expandQuery('вместо этого') === 'вместо этого', 'a different word is not expanded')
// Реранкер сказал: сначала индекс 2 (это c), потом индекс 0 (это a). b он выбросил.
assert(applyRerank(['a', 'b', 'c'], [2, 0]).join() === 'c,a', 'a reranker moves its first index to the front')
const retryNow = Date.parse('2026-09-29T12:00:00.000Z')
assert(retryAfterMs(null) === 60_000, 'a missing retry header waits a minute')
assert(retryAfterMs('6') === 6_000, 'retry-after seconds are kept')
// 120 секунд больше потолка в минуту: ждём минуту, не две.
assert(retryAfterMs('120') === 60_000, 'a long retry wait stays within a minute')
assert(retryAfterMs('nope') === 60_000, 'an unreadable retry header waits a minute')
// Заголовок-дата: пауза равна разнице с now, здесь 15 секунд.
assert(retryAfterMs(new Date(retryNow + 15_000).toUTCString(), retryNow) === 15_000, 'a retry-after date is a delay')
// Первый вопрос нашёл файл только вторым. При k=1 это промах, при k=2 попадание.
assert(hitCount([['a.md', 'b.md'], ['c.md']], ['b.md', 'c.md'], 1) === 1, 'recall@1 misses a hit in second place')
assert(hitCount([['a.md', 'b.md'], ['c.md']], ['b.md', 'c.md'], 2) === 2, 'recall@2 counts both')

/** Собирает чанк с нужными id, разделом и текстом. Остальные поля для этих проверок не важны. */
function sample(id: string, section: string, text: string): Chunk {
  return {
    id,
    source: `corpus/docs/${id}.md`,
    title: id,
    parentId: id,
    text,
    parentText: text,
    type: 'note',
    date: '2026-01-01',
    section,
  }
}

/** Проверяет, что функция бросила ошибку ровно с этим текстом. Другой текст — тоже провал. */
function assertThrows(run: () => void, message: string) {
  let thrown = ''
  try {
    run()
  } catch (error) {
    thrown = error instanceof Error ? error.message : ''
  }
  assert(thrown === message, `expected ${message}, got ${thrown}`)
}

// До этой строки доходим только если все проверки выше прошли.
console.log('rag ok')
