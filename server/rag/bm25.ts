/**
 * Лексический поиск BM25: балл за общие слова, не за смысл.
 * «Гаечный ключ» и «инструмент для гаек» для BM25 почти не пересекаются,
 * зато редкое слово вроде --no-verify или SKU-4419 находится точно.
 * Редкое слово весит больше частого, поэтому флаг или артикул не тонет в слове «ошибка».
 * Первая ветка регулярки сохраняет --no-verify целиком, вторая — sku-4419 и обычные слова.
 */
const TOKEN = /--[a-z0-9][a-z0-9_-]*|[a-zа-яё0-9]+(?:[_-][a-zа-яё0-9]+)*/gi

/**
 * Готовый индекс BM25 по всем чанкам.
 * Считается один раз при загрузке корпуса и потом только читается на каждый вопрос.
 */
export type Bm25Index = {
  /** Сколько чанков в индексе. Нужно формуле idf: редкость слова зависит от числа документов. */
  count: number
  /** Средняя длина чанка в токенах. Длинный чанк без нормировки побеждал бы только за счёт размера. */
  avg: number
  /** Насколько повтор слова в одном чанке ещё поднимает балл. 1.2 — обычное значение BM25. */
  k1: number
  /** Насколько сильно штрафовать длинный чанк. 0 — длина не важна, 1 — штраф полный. 0.75 — обычное. */
  b: number
  /** Длина каждого чанка в токенах: id чанка -> число слов. */
  docs: Map<string, number>
  /**
   * Обратный список: слово -> чанки, где оно есть, и сколько раз (tf).
   * Поиск идёт от слов вопроса к чанкам, а не перечитывает все тексты.
   */
  postings: Map<string, { id: string; tf: number }[]>
}

/**
 * Режет текст на токены поиска: нижний регистр, флаги с -- и слова через дефис.
 * «Место» и «место» из разного регистра станут одним токеном.
 * Нет совпадений — пустой массив, а не null: дальше можно спокойно идти циклом.
 */
export function tokens(text: string) {
  return text.toLowerCase().match(TOKEN) ?? []
}

/**
 * Строит индекс по чанкам. На вход достаточно id и text: остальное BM25 не читает.
 * Индекс не хранит исходный текст, только частоты слов.
 */
export function buildBm25(docs: readonly { id: string; text: string }[]): Bm25Index {
  const postings = new Map<string, { id: string; tf: number }[]>()
  const lengths = new Map<string, number>()
  // Сумма длин всех чанков. Потом делим на число чанков и получаем avg.
  let total = 0
  for (const doc of docs) {
    // Сколько раз каждое слово встретилось в этом чанке.
    const counts = new Map<string, number>()
    for (const token of tokens(doc.text)) counts.set(token, (counts.get(token) ?? 0) + 1)
    // Длина чанка — сумма частот, то есть число токенов, а не число разных слов.
    let length = 0
    for (const [token, tf] of counts) {
      length += tf
      // Список чанков для этого слова. Если слово новое, начинаем с пустого списка.
      const list = postings.get(token) ?? []
      list.push({ id: doc.id, tf })
      postings.set(token, list)
    }
    lengths.set(doc.id, length)
    total += length
  }
  // k1 и b не подбираем по корпусу: это стандартные константы BM25.
  return { count: docs.length, avg: docs.length ? total / docs.length : 0, k1: 1.2, b: 0.75, docs: lengths, postings }
}

/**
 * Сортирует id чанков по убыванию балла BM25 для вопроса.
 * allowed — чанки, прошедшие фильтр. Остальные даже не получают балл.
 * Возвращает только id, которые хоть как-то совпали. Чанк без общих слов в список не входит.
 */
export function bm25Order(index: Bm25Index, query: string, allowed: ReadonlySet<string>) {
  const scores = new Map<string, number>()
  // Повтор слова в вопросе не должен удваивать его вес: «место место» и «место» ищут одинаково.
  const seen = new Set<string>()
  for (const token of tokens(query)) {
    if (seen.has(token)) continue
    seen.add(token)
    // Слова вопроса, которого нет ни в одном чанке, просто пропускаем.
    const list = index.postings.get(token)
    if (!list) continue
    // idf: чем в меньшем числе чанков встречается слово, тем выше его вес.
    // +0.5 сглаживает крайние случаи, когда слово есть почти везде или только в одном чанке.
    const idf = Math.log(1 + (index.count - list.length + 0.5) / (list.length + 0.5))
    for (const posting of list) {
      // Чанк отфильтрован по разделу или дате — его балл не считаем и в топ он не попадёт.
      if (!allowed.has(posting.id)) continue
      const length = index.docs.get(posting.id) ?? 0
      // normal = 1 у чанка средней длины, больше 1 у длинного, меньше 1 у короткого.
      const normal = index.avg ? length / index.avg : 0
      // Знаменатель растёт с длиной чанка (из-за b) и с частотой слова (из-за tf).
      const denom = posting.tf + index.k1 * (1 - index.b + index.b * normal)
      // Повтор слова помогает, но всё слабее: дробь стремится к idf * (k1+1), а не растёт бесконечно.
      const add = idf * ((posting.tf * (index.k1 + 1)) / (denom || 1))
      // Баллы разных слов вопроса складываются. Чанк с двумя редкими словами обгоняет чанк с одним.
      scores.set(posting.id, (scores.get(posting.id) ?? 0) + add)
    }
  }
  // В наружу уходят только id, уже по порядку «лучший первый».
  return [...scores].sort(byIdScore).map(([id]) => id)
}

/**
 * Сравнение для сортировки пар [id, балл].
 * Сначала больший балл. При равном балле — id по алфавиту, чтобы порядок не прыгал между запусками.
 */
function byIdScore(left: [string, number], right: [string, number]) {
  return right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
}
