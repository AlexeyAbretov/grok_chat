export type ToolResult = { ok: true; output: string } | { ok: false; output: string }

export type ToolIo = {
  readFile: (file: string) => string
  listNotes?: () => string[]
}

export type ToolSpec = {
  type: 'function'
  name: string
  description: string
  parameters: {
    type: 'object'
    required: string[]
    properties: Record<string, { type: string; description: string; enum?: readonly string[] }>
  }
}

export type ToolHandler = {
  name: string
  spec: (listedNotes: string) => ToolSpec
  run: (args: unknown, io: ToolIo) => ToolResult
}
