import { BM25Retriever } from '@langchain/community/retrievers/bm25'
import { EnsembleRetriever } from '@langchain/classic/retrievers/ensemble'
import { MemoryVectorStore } from '@langchain/classic/vectorstores/memory'
import { Document } from '@langchain/core/documents'
import { BaseRetriever } from '@langchain/core/retrievers'
import type { EmbeddingsInterface } from '@langchain/core/embeddings'
import { matchesFilter } from './rank.ts'
import { CANDIDATE_POOL, RRF_K, type Chunk, type SearchFilter, type SearchMode } from './types.ts'

/**
 * Поиск готовыми классами.
 * BM25Retriever — совпадение слов. MemoryVectorStore — близость векторов, фильтр шапки до топа.
 * EnsembleRetriever складывает два списка через reciprocal rank fusion, константа c = 60.
 */
const idleEmbeddings: EmbeddingsInterface = {
  embedDocuments: async () => [],
  embedQuery: async () => [],
}

export async function searchChunkIds(args: {
  chunks: readonly Chunk[]
  vectors: ReadonlyMap<string, readonly number[]> | null
  query: string
  queryVector: readonly number[] | null
  filter?: SearchFilter
  mode: SearchMode
  take: number
}) {
  const allowed = args.chunks.filter((chunk) => matchesFilter(chunk, args.filter))
  if (args.mode === 'vector') {
    if (!args.vectors || !args.queryVector) return []
    return vectorIds(allowed, args.vectors, args.queryVector, args.take)
  }
  if (args.mode === 'bm25' || !args.vectors || !args.queryVector) return bm25Ids(allowed, args.query, args.take)
  const lexical = await bm25Ids(allowed, args.query, CANDIDATE_POOL)
  const dense = await vectorIds(allowed, args.vectors, args.queryVector, CANDIDATE_POOL)
  return fuse(args.query, [lexical, dense], args.take)
}

async function bm25Ids(chunks: readonly Chunk[], query: string, take: number) {
  if (chunks.length === 0 || !query.trim()) return []
  const retriever = BM25Retriever.fromDocuments(
    chunks.map(
      (chunk) =>
        new Document({
          pageContent: chunk.text.toLowerCase(),
          metadata: { id: chunk.id },
          id: chunk.id,
        }),
    ),
    { k: chunks.length, includeScore: true },
  )
  const found = await retriever.invoke(query)
  return found
    .filter((doc) => {
      const score = doc.metadata.bm25Score
      return typeof score === 'number' && Number.isFinite(score) && score > 0
    })
    .slice(0, take)
    .map((doc) => docId(doc))
}

async function vectorIds(
  chunks: readonly Chunk[],
  vectors: ReadonlyMap<string, readonly number[]>,
  query: readonly number[],
  take: number,
) {
  const rows = chunks.flatMap((chunk) => {
    const vector = vectors.get(chunk.id)
    return vector ? [{ chunk, vector: [...vector] }] : []
  })
  if (rows.length === 0 || query.length === 0) return []
  const store = new MemoryVectorStore(idleEmbeddings)
  await store.addVectors(
    rows.map((row) => row.vector),
    rows.map(
      (row) =>
        new Document({
          pageContent: row.chunk.id,
          metadata: { id: row.chunk.id },
          id: row.chunk.id,
        }),
    ),
  )
  const found = await store.similaritySearchVectorWithScore([...query], take)
  return found.map(([doc]) => docId(doc))
}

/** Списки уже отсортированы. Пакет сливает их по месту, ключ — id чанка. */
async function fuse(query: string, rankings: readonly (readonly string[])[], take: number) {
  const lists = rankings.filter((list) => list.length > 0)
  const only = lists[0]
  if (!only) return []
  if (lists.length === 1) return only.slice(0, take)
  const ensemble = new EnsembleRetriever({
    retrievers: lists.map((ids) => new RankList(ids.map((id) => new Document({ pageContent: id })))),
    c: RRF_K,
  })
  const fused = await ensemble.invoke(query)
  return fused.map((doc) => doc.pageContent).slice(0, take)
}

class RankList extends BaseRetriever {
  lc_namespace = ['grok-chat', 'retrievers', 'rank-list']
  private docs: Document[]

  constructor(docs: Document[]) {
    super()
    this.docs = docs
  }

  async _getRelevantDocuments(query: string) {
    void query
    return this.docs
  }
}

function docId(doc: Document) {
  const id = doc.metadata.id
  if (typeof id === 'string' && id) return id
  return doc.id ?? ''
}
