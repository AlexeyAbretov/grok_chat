import { objectArgs, required, unexpected } from '../args.ts'
import { fail, ok } from '../result.ts'
import type { ToolHandler, ToolIo, ToolSpec } from '../types.ts'
import { errorCode, readError } from './errors.ts'
import { collectNoteNames } from './names.ts'
import { locateNote } from './path.ts'

const SNIPPET_RADIUS = 48
const MAX_MATCHES = 20
const MAX_QUERY = 200

export const searchNotes: ToolHandler = {
  name: 'search_notes',
  spec,
  run,
}

function spec(listedNotes: string): ToolSpec {
  return {
    type: 'function',
    name: 'search_notes',
    description: `Ищет точную подстроку в файлах папки notes/ (${listedNotes}). Возвращает имя файла, номер строки и короткий фрагмент вокруг совпадения. Без эмбеддингов.`,
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Подстрока для поиска' },
      },
    },
  }
}

function run(args: unknown, io: ToolIo) {
  const record = objectArgs(args)
  if (!record.ok) return record
  const extra = unexpected(record.value, ['query'])
  if (extra) return fail(extra)
  const missing = required(record.value, ['query'])
  if (missing) return fail(missing)
  if (typeof record.value.query !== 'string') return fail('Неверный тип «query»')

  const query = record.value.query
  if (!query.trim()) return fail('Пустой запрос')
  if (query.length > MAX_QUERY) return fail('Слишком длинный запрос')

  const matches: { file: string; line: number; snippet: string }[] = []
  let truncated = false
  let foundFile = false

  for (const name of collectNoteNames(io.listNotes)) {
    const located = locateNote(name)
    if (!located.ok) continue
    let text = ''
    try {
      text = io.readFile(located.file)
      foundFile = true
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ENOENT' || code === 'ENOTDIR') continue
      return fail(readError(error))
    }

    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      let from = 0
      while (from <= lines[index].length) {
        const at = lines[index].indexOf(query, from)
        if (at < 0) break
        if (matches.length >= MAX_MATCHES) {
          truncated = true
          break
        }
        matches.push({ file: name, line: index + 1, snippet: snippet(lines[index], at, query.length) })
        from = at + Math.max(query.length, 1)
      }
      if (truncated) break
    }
    if (truncated) break
  }

  if (!foundFile) return fail('Нет файлов заметок')
  return ok({ matches, truncated })
}

function snippet(line: string, at: number, length: number) {
  const start = Math.max(0, at - SNIPPET_RADIUS)
  const end = Math.min(line.length, at + length + SNIPPET_RADIUS)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < line.length ? '…' : ''
  return `${prefix}${line.slice(start, end)}${suffix}`
}
