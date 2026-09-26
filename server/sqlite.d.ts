declare module 'node:sqlite' {
  export type SQLInputValue = string | number | bigint | null | Uint8Array

  export class StatementSync {
    run(...params: SQLInputValue[]): { changes: number; lastInsertRowid: number | bigint }
    get(...params: SQLInputValue[]): Record<string, unknown> | undefined
    all(...params: SQLInputValue[]): Record<string, unknown>[]
  }

  export class DatabaseSync {
    constructor(path: string)
    exec(sql: string): void
    prepare(sql: string): StatementSync
    close(): void
  }
}
