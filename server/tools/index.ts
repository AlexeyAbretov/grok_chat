import { calculator } from './calculator.ts'
import { defaultIo } from './io.ts'
import { collectNoteNames, describeNoteNames } from './notes/names.ts'
import { readFile } from './notes/read.ts'
import { searchNotes } from './notes/search.ts'
import { fail } from './result.ts'
import type { ToolHandler, ToolIo, ToolResult } from './types.ts'

export type { ToolIo, ToolResult } from './types.ts'
export { locateNote } from './notes/path.ts'

const tools: readonly ToolHandler[] = [calculator, readFile, searchNotes]

export function chatTools(io: ToolIo = defaultIo) {
  const listed = describeNoteNames(collectNoteNames(io.listNotes))
  return tools.map((tool) => tool.spec(listed))
}

export function runTool(name: string, args: unknown, io: ToolIo = defaultIo): ToolResult {
  const tool = tools.find((item) => item.name === name)
  if (!tool) return fail('Неизвестный инструмент')
  return tool.run(args, io)
}

export function noteNames(io: ToolIo = defaultIo) {
  return collectNoteNames(io.listNotes)
}
