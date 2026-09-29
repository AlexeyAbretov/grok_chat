import type { ToolResult } from './types.ts'

export function ok(payload: unknown): ToolResult {
  return { ok: true, output: JSON.stringify(payload) }
}

export function fail(output: string): { ok: false; output: string } {
  return { ok: false, output }
}
