/**
 * Лексический поиск: балл за общие слова, не за смысл.
 * Редкое слово весит больше частого, поэтому флаг или артикул не тонет в слове «ошибка».
 * Первая ветка регулярки сохраняет --no-verify целиком, вторая — sku-4419 и слова.
 */
const TOKEN = /--[a-z0-9][a-z0-9_-]*|[a-zа-яё0-9]+(?:[_-][a-zа-яё0-9]+)*/gi

export type Bm25Index = {
  count: number
  avg: number
  k1: number
  b: number
  docs: Map<string, number>
  postings: Map<string, { id: string; tf: number }[]>
}

export function tokens(text: string) {
  return text.toLowerCase().match(TOKEN) ?? []
}

export function buildBm25(docs: readonly { id: string; text: string }[]): Bm25Index {
  const postings = new Map<string, { id: string; tf: number }[]>()
  const lengths = new Map<string, number>()
  let total = 0
  for (const doc of docs) {
    const counts = new Map<string, number>()
    for (const token of tokens(doc.text)) counts.set(token, (counts.get(token) ?? 0) + 1)
    let length = 0
    for (const [token, tf] of counts) {
      length += tf
      const list = postings.get(token) ?? []
      list.push({ id: doc.id, tf })
      postings.set(token, list)
    }
    lengths.set(doc.id, length)
    total += length
  }
  return { count: docs.length, avg: docs.length ? total / docs.length : 0, k1: 1.2, b: 0.75, docs: lengths, postings }
}

export function bm25Order(index: Bm25Index, query: string, allowed: ReadonlySet<string>) {
  const scores = new Map<string, number>()
  const seen = new Set<string>()
  for (const token of tokens(query)) {
    if (seen.has(token)) continue
    seen.add(token)
    const list = index.postings.get(token)
    if (!list) continue
    // Чем в меньшем числе чанков встречается слово, тем выше его вес.
    const idf = Math.log(1 + (index.count - list.length + 0.5) / (list.length + 0.5))
    for (const posting of list) {
      if (!allowed.has(posting.id)) continue
      const length = index.docs.get(posting.id) ?? 0
      const normal = index.avg ? length / index.avg : 0
      const denom = posting.tf + index.k1 * (1 - index.b + index.b * normal)
      const add = idf * ((posting.tf * (index.k1 + 1)) / (denom || 1))
      scores.set(posting.id, (scores.get(posting.id) ?? 0) + add)
    }
  }
  return [...scores].sort(byIdScore).map(([id]) => id)
}

function byIdScore(left: [string, number], right: [string, number]) {
  return right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
}
