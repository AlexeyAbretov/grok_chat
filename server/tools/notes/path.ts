import { isAbsolute, relative, resolve, sep } from 'node:path'

export const NOTES_DIR = resolve('notes')

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
