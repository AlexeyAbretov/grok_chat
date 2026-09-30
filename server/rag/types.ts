/**
 * Настройки нарезки и поиска по корпусу.
 * Ищут по короткому чанку, а в промпт кладут parentText — секцию целиком.
 */

/** Длинный абзац режется на окна этой длины. Короткий абзац остаётся одним чанком. */
export const WINDOW = 480
/** Соседние окна заходят друг на друга, чтобы фраза на стыке не пропала. */
export const OVERLAP = 80
/**
 * Reciprocal rank fusion. 60 — константа c у EnsembleRetriever:
 * места в двух списках остаются близкими, и один индекс не задавливает другой.
 */
export const RRF_K = 60
/** Сколько лучших чанков берём из BM25 и отдельно из векторов перед слиянием. */
export const CANDIDATE_POOL = 30
/** Столько кандидатов после слияния отдаём реранкеру. Он дороже обычного поиска. */
export const RERANK_POOL = 24
/** Столько фрагментов видит чат-модель. recall@5 считает попадание в это же число. */
export const PASSAGE_LIMIT = 5

export type SearchMode = 'vector' | 'bm25' | 'hybrid'

/** Фильтр по шапке документа. Применяется до подсчёта близости, а не после выдачи. */
export type SearchFilter = {
  type?: string
  section?: string
  dateFrom?: string
  dateTo?: string
}

export type Document = {
  source: string
  title: string
  type: string
  date: string
  section: string
  body: string
}

/**
 * text — кусок, по которому ищут.
 * parentText — секция вокруг него: модели часто нужен соседний абзац, не одна фраза.
 */
export type Chunk = {
  id: string
  source: string
  title: string
  parentId: string
  text: string
  parentText: string
  type: string
  date: string
  section: string
}

/**
 * Вопрос, для которого правильный файл известен заранее.
 * paraphrase проверяет смысл другими словами, exact — редкий идентификатор вроде SKU или флага.
 */
export type GoldQuestion = {
  question: string
  document: string
  kind: 'paraphrase' | 'exact'
  filter?: SearchFilter
}

export type Passage = {
  ref: number
  source: string
  title: string
  text: string
}
