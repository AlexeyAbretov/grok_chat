import { readFileSync } from 'node:fs'
import { listNotesOnDisk } from './notes/names.ts'
import type { ToolIo } from './types.ts'

export const defaultIo: ToolIo = {
  readFile: (file) => readFileSync(file, 'utf8'),
  listNotes: listNotesOnDisk,
}
