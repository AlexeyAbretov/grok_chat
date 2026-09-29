import { readdirSync } from 'node:fs'
import { NOTES_DIR } from './path.ts'

const MAX_DESCRIBED_NOTES = 40

export function listNotesOnDisk() {
  return readdirSync(NOTES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
}

export function collectNoteNames(listNotes: (() => string[]) | undefined): string[] {
  try {
    const names = (listNotes ?? listNotesOnDisk)()
    return [...new Set(names.filter((name) => safeNoteName(name)))].sort((left, right) => left.localeCompare(right, 'en'))
  } catch {
    return []
  }
}

export function describeNoteNames(names: readonly string[]) {
  if (names.length === 0) return 'файлов нет'
  const shown = names.slice(0, MAX_DESCRIBED_NOTES).map((name) => `notes/${name}`)
  const extra = names.length - shown.length
  return extra > 0 ? `${shown.join(', ')} и ещё ${extra}` : shown.join(', ')
}

function safeNoteName(name: string) {
  return Boolean(name) && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\') && !name.includes('\0')
}
