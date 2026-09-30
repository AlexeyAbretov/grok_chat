import { MarkdownTextSplitter } from '@langchain/textsplitters'
import { OVERLAP, WINDOW, type Chunk, type Document } from './types.ts'

/** Шапка между --- хранит тип, дату, раздел и заголовок. По ним потом фильтруют поиск. */
export function parseDocument(source: string, raw: string): Document {
  const text = raw.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n')
  if (!text.startsWith('---\n')) throw new Error(`Нет шапки: ${source}`)
  const end = text.indexOf('\n---\n', 4)
  if (end < 0) throw new Error(`Нет конца шапки: ${source}`)
  const fields = new Map<string, string>()
  for (const line of text.slice(4, end).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const colon = trimmed.indexOf(':')
    if (colon <= 0) throw new Error(`Неверная шапка: ${source}`)
    fields.set(trimmed.slice(0, colon).trim(), trimmed.slice(colon + 1).trim())
  }
  const type = fields.get('type') ?? ''
  const date = fields.get('date') ?? ''
  const section = fields.get('section') ?? ''
  const title = fields.get('title') ?? ''
  if (!type || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !section || !title) throw new Error(`Неполная шапка: ${source}`)
  return { source, type, date, section, title, body: text.slice(end + 5).trim() }
}

/**
 * Секции режем сами: пакет делит по заголовку только если текст уже длиннее окна.
 * Длинный абзац внутри секции режет MarkdownTextSplitter, с перекрытием.
 * Короткие абзацы не склеиваются: у секции остаётся несколько чанков и один parentId.
 */
export async function chunkDocument(doc: Document, options?: { window?: number; overlap?: number }): Promise<Chunk[]> {
  const window = options?.window ?? WINDOW
  const overlap = Math.min(options?.overlap ?? OVERLAP, Math.max(0, window - 1))
  const splitter = new MarkdownTextSplitter({ chunkSize: window, chunkOverlap: overlap })
  const chunks: Chunk[] = []
  const blocks = sectionBlocks(doc.body, doc.title)
  for (let sectionIndex = 0; sectionIndex < blocks.length; sectionIndex += 1) {
    const block = blocks[sectionIndex]
    if (!block) continue
    const parentId = `${doc.source}#${sectionIndex}`
    const parentText = `# ${block.title}\n\n${block.body}`
    const pieces = await windowPieces(splitter, block.body)
    pieces.forEach((piece, partIndex) => {
      chunks.push({
        id: `${parentId}.${partIndex}`,
        source: doc.source,
        title: block.title,
        parentId,
        text: `${block.title}\n${piece}`,
        parentText,
        type: doc.type,
        date: doc.date,
        section: doc.section,
      })
    })
  }
  return chunks
}

async function windowPieces(splitter: MarkdownTextSplitter, body: string) {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)
  const pieces: string[] = []
  for (const paragraph of paragraphs) pieces.push(...(await splitter.splitText(paragraph)))
  return pieces
}

function sectionBlocks(body: string, fallbackTitle: string) {
  const blocks: { title: string; body: string }[] = []
  let title = fallbackTitle
  let lines: string[] = []
  const push = () => {
    const text = lines.join('\n').trim()
    lines = []
    if (text) blocks.push({ title, body: text })
  }
  for (const line of body.split('\n')) {
    const heading = /^#{1,6}\s+(\S.*)$/.exec(line.trim())
    if (heading?.[1]) {
      push()
      title = heading[1].trim()
      continue
    }
    lines.push(line)
  }
  push()
  return blocks
}
