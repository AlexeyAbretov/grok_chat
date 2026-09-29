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
 * Сначала режет по заголовкам, потом по абзацам, длинный абзац — окном с перекрытием.
 * У каждого куска один parentId на всю секцию.
 */
export function chunkDocument(doc: Document, options?: { window?: number; overlap?: number }): Chunk[] {
  const window = options?.window ?? WINDOW
  const overlap = options?.overlap ?? OVERLAP
  const chunks: Chunk[] = []
  sectionBlocks(doc.body, doc.title).forEach((block, sectionIndex) => {
    const parentId = `${doc.source}#${sectionIndex}`
    const parentText = `# ${block.title}\n\n${block.body}`
    let partIndex = 0
    for (const paragraph of paragraphs(block.body)) {
      for (const piece of windows(paragraph, window, overlap)) {
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
        partIndex += 1
      }
    }
  })
  return chunks
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

function paragraphs(text: string) {
  return text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function windows(text: string, window: number, overlap: number) {
  if (text.length <= window) return [text]
  const step = Math.max(1, window - overlap)
  const parts: string[] = []
  for (let start = 0; start < text.length; start += step) {
    const end = Math.min(text.length, start + window)
    parts.push(text.slice(start, end))
    if (end >= text.length) break
  }
  return parts
}
