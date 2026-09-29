import { relative, sep } from 'node:path'
import { objectArgs, required, unexpected } from '../args.ts'
import { fail, ok } from '../result.ts'
import type { ToolHandler, ToolIo, ToolSpec } from '../types.ts'
import { readError } from './errors.ts'
import { NOTES_DIR, locateNote } from './path.ts'

const MAX_NOTE_CHARS = 20_000

export const readFile: ToolHandler = {
  name: 'read_file',
  spec,
  run,
}

function spec(listedNotes: string): ToolSpec {
  return {
    type: 'function',
    name: 'read_file',
    description: `Читает один файл из папки notes/. path — имя файла внутри notes/. Сейчас там: ${listedNotes}. Пути вне этой папки запрещены.`,
    parameters: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Имя файла внутри notes/' },
      },
    },
  }
}

function run(args: unknown, io: ToolIo) {
  const record = objectArgs(args)
  if (!record.ok) return record
  const extra = unexpected(record.value, ['path'])
  if (extra) return fail(extra)
  const missing = required(record.value, ['path'])
  if (missing) return fail(missing)
  if (typeof record.value.path !== 'string') return fail('Неверный тип «path»')

  const located = locateNote(record.value.path)
  if (!located.ok) return fail(located.error)

  let text = ''
  try {
    text = io.readFile(located.file)
  } catch (error) {
    return fail(readError(error))
  }

  const truncated = text.length > MAX_NOTE_CHARS
  return ok({
    path: relative(NOTES_DIR, located.file).split(sep).join('/'),
    content: truncated ? text.slice(0, MAX_NOTE_CHARS) : text,
    truncated,
  })
}
