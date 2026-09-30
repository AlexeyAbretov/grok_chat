import type { Chunk, SearchFilter } from './types.ts'

export function matchesFilter(chunk: Chunk, filter: SearchFilter | undefined) {
  if (!filter) return true
  if (filter.type && chunk.type !== filter.type) return false
  if (filter.section && chunk.section !== filter.section) return false
  if (filter.dateFrom && chunk.date < filter.dateFrom) return false
  if (filter.dateTo && chunk.date > filter.dateTo) return false
  return true
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
