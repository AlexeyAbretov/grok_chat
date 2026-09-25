import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const NOTES_DIR = resolve('notes')
const NOTE_FILES = ['a.md', 'b.md', 'c.md'] as const
const OPS = ['add', 'sub', 'mul', 'div'] as const
const SNIPPET_RADIUS = 48
const MAX_MATCHES = 20
const MAX_NOTE_CHARS = 20_000
const MAX_QUERY = 200

export type ToolResult = { ok: true; output: string } | { ok: false; output: string }

export type ToolIo = {
  readFile: (file: string) => string
}

const defaultIo: ToolIo = {
  readFile: (file) => readFileSync(file, 'utf8'),
}

export const TOOLS = [
  {
    type: 'function',
    name: 'calculator',
    description: 'Складывает, вычитает, умножает или делит два числа. Произвольные выражения не считает.',
    parameters: {
      type: 'object',
      required: ['op', 'a', 'b'],
      properties: {
        op: { type: 'string', enum: ['add', 'sub', 'mul', 'div'], description: 'Операция: add, sub, mul или div' },
        a: { type: 'number', description: 'Первое число' },
        b: { type: 'number', description: 'Второе число' },
      },
    },
  },
  {
    type: 'function',
    name: 'read_file',
    description: 'Читает один файл из папки notes/. path — путь относительно notes/, например a.md. Пути вне этой папки запрещены.',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Путь внутри notes/, например a.md' },
      },
    },
  },
  {
    type: 'function',
    name: 'search_notes',
    description: 'Ищет точную подстроку в notes/a.md, notes/b.md и notes/c.md. Возвращает имя файла, номер строки и короткий фрагмент вокруг совпадения. Без эмбеддингов.',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Подстрока для поиска' },
      },
    },
  },
] as const

export function runTool(name: string, args: unknown, io: ToolIo = defaultIo): ToolResult {
  if (name === 'calculator') return calculator(args)
  if (name === 'read_file') return readNote(args, io)
  if (name === 'search_notes') return searchNotes(args, io)
  return fail('Неизвестный инструмент')
}

export function locateNote(input: string): { ok: true; file: string } | { ok: false; error: string } {
  if (typeof input !== 'string') return { ok: false, error: 'Путь вне папки notes' }
  let trimmed = input.trim().replaceAll('\\', '/')
  if (!trimmed || trimmed.includes('\0')) return { ok: false, error: 'Путь вне папки notes' }
  if (trimmed === 'notes') return { ok: false, error: 'Путь вне папки notes' }
  if (trimmed.startsWith('notes/')) trimmed = trimmed.slice('notes/'.length)
  if (!trimmed || isAbsolute(trimmed)) return { ok: false, error: 'Путь вне папки notes' }

  const target = resolve(NOTES_DIR, trimmed)
  const rel = relative(NOTES_DIR, target)
  const root = NOTES_DIR.endsWith(sep) ? NOTES_DIR : NOTES_DIR + sep
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !target.startsWith(root)) {
    return { ok: false, error: 'Путь вне папки notes' }
  }
  return { ok: true, file: target }
}

function calculator(args: unknown): ToolResult {
  const record = objectArgs(args)
  if (!record.ok) return record
  const extra = unexpected(record.value, ['op', 'a', 'b'])
  if (extra) return fail(extra)
  const missing = required(record.value, ['op', 'a', 'b'])
  if (missing) return fail(missing)

  const { op, a, b } = record.value
  if (typeof op !== 'string' || !OPS.some((item) => item === op)) return fail('Недопустимое значение «op»')
  if (typeof a !== 'number' || !Number.isFinite(a)) return fail('Неверный тип «a»')
  if (typeof b !== 'number' || !Number.isFinite(b)) return fail('Неверный тип «b»')
  if (op === 'div' && b === 0) return fail('Деление на ноль')

  const result = op === 'add' ? a + b : op === 'sub' ? a - b : op === 'mul' ? a * b : a / b
  if (!Number.isFinite(result)) return fail('Результат не конечное число')
  return ok({ result })
}

function readNote(args: unknown, io: ToolIo): ToolResult {
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

function searchNotes(args: unknown, io: ToolIo): ToolResult {
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

  for (const name of NOTE_FILES) {
    const located = locateNote(name)
    if (!located.ok) return fail(located.error)
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

function objectArgs(args: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; output: string } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('Неверные аргументы')
  return { ok: true, value: args as Record<string, unknown> }
}

function unexpected(value: Record<string, unknown>, keys: readonly string[]) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) return `Лишнее поле «${key}»`
  }
  return ''
}

function required(value: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return `Нет поля «${key}»`
  }
  return ''
}

function readError(error: unknown) {
  const code = errorCode(error)
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'Файл не найден'
  if (code === 'EISDIR') return 'Это папка'
  return 'Не удалось прочитать файл'
}

function errorCode(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error) return String(error.code)
  return ''
}

function ok(payload: unknown): ToolResult {
  return { ok: true, output: JSON.stringify(payload) }
}

function fail(output: string): { ok: false; output: string } {
  return { ok: false, output }
}
