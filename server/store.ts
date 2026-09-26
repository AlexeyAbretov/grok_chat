import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { parsePersistedState, type PersistedState } from '../shared/state.ts'

export function chatDbPath() {
  return process.env.CHAT_DB || resolve('data/chats.sqlite')
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  max_tokens INTEGER NOT NULL,
  reasoning_effort TEXT NOT NULL,
  draft TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sort_index INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  tools_json TEXT NOT NULL,
  usage_json TEXT,
  error TEXT,
  notice TEXT,
  stopped INTEGER NOT NULL,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS messages_chat_position ON messages (chat_id, position);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

type Statements = {
  deleteMessages: StatementSync
  deleteChats: StatementSync
  insertChat: StatementSync
  insertMessage: StatementSync
  upsertMeta: StatementSync
  selectChats: StatementSync
  selectMessages: StatementSync
  selectActive: StatementSync
}

let database: DatabaseSync | null = null
let statements: Statements | null = null

export function openChatDb() {
  if (database && statements) return
  const path = chatDbPath()
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  database = db
  statements = prepare(db)
}

export function closeChatDb() {
  database?.close()
  database = null
  statements = null
}

export function readChats(): PersistedState {
  const sql = db()
  const messagesByChat = new Map<string, unknown[]>()
  for (const row of sql.selectMessages.all()) {
    const message = messageFromRow(row)
    if (!message) continue
    const list = messagesByChat.get(message.chatId) ?? []
    list.push(message.message)
    messagesByChat.set(message.chatId, list)
  }

  const chats = []
  for (const row of sql.selectChats.all()) {
    if (typeof row.id !== 'string') continue
    chats.push({
      id: row.id,
      title: text(row.title),
      model: text(row.model),
      maxTokens: integer(row.max_tokens),
      reasoningEffort: text(row.reasoning_effort),
      draft: text(row.draft),
      messages: messagesByChat.get(row.id) ?? [],
      createdAt: integer(row.created_at),
      updatedAt: integer(row.updated_at),
    })
  }

  const activeRow = sql.selectActive.get('active_id')
  const storedActive = activeRow && typeof activeRow.value === 'string' ? activeRow.value : ''
  const parsed = parsePersistedState({
    chats,
    activeId: chats.some((chat) => chat.id === storedActive) ? storedActive : (chats[0]?.id ?? ''),
  })
  if (!parsed.ok) return { chats: [], activeId: '' }
  return parsed.state
}

export function writeChats(state: PersistedState) {
  const sql = db()
  sql.db.exec('BEGIN IMMEDIATE')
  try {
    sql.deleteMessages.run()
    sql.deleteChats.run()
    state.chats.forEach((chat, index) => {
      sql.insertChat.run(
        chat.id,
        chat.title,
        chat.model,
        chat.maxTokens,
        chat.reasoningEffort,
        chat.draft,
        chat.createdAt,
        chat.updatedAt,
        index,
      )
      chat.messages.forEach((message, position) => {
        sql.insertMessage.run(
          message.id,
          chat.id,
          position,
          message.role,
          message.content,
          message.reasoning,
          JSON.stringify(message.tools),
          message.usage ? JSON.stringify(message.usage) : null,
          message.error,
          message.notice,
          message.stopped ? 1 : 0,
        )
      })
    })
    sql.upsertMeta.run('active_id', state.activeId)
    sql.db.exec('COMMIT')
  } catch (error) {
    sql.db.exec('ROLLBACK')
    throw error
  }
}

function db() {
  openChatDb()
  if (!database || !statements) throw new Error('База чатов не открыта')
  return { db: database, ...statements }
}

function prepare(db: DatabaseSync): Statements {
  return {
    deleteMessages: db.prepare('DELETE FROM messages'),
    deleteChats: db.prepare('DELETE FROM chats'),
    insertChat: db.prepare(
      `INSERT INTO chats (
        id, title, model, max_tokens, reasoning_effort, draft, created_at, updated_at, sort_index
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertMessage: db.prepare(
      `INSERT INTO messages (
        id, chat_id, position, role, content, reasoning, tools_json, usage_json, error, notice, stopped
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    upsertMeta: db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ),
    selectChats: db.prepare(
      `SELECT id, title, model, max_tokens, reasoning_effort, draft, created_at, updated_at
       FROM chats ORDER BY sort_index ASC`,
    ),
    selectMessages: db.prepare(
      `SELECT id, chat_id, role, content, reasoning, tools_json, usage_json, error, notice, stopped
       FROM messages ORDER BY chat_id ASC, position ASC`,
    ),
    selectActive: db.prepare('SELECT value FROM meta WHERE key = ?'),
  }
}

function messageFromRow(row: Record<string, unknown>): { chatId: string; message: unknown } | null {
  if (typeof row.id !== 'string' || typeof row.chat_id !== 'string') return null
  if (row.role !== 'user' && row.role !== 'assistant') return null
  return {
    chatId: row.chat_id,
    message: {
      id: row.id,
      role: row.role,
      content: text(row.content),
      reasoning: text(row.reasoning),
      tools: jsonValue(row.tools_json) ?? [],
      usage: jsonValue(row.usage_json),
      error: typeof row.error === 'string' ? row.error : null,
      notice: typeof row.notice === 'string' ? row.notice : null,
      stopped: row.stopped === 1,
    },
  }
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function text(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function integer(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'bigint') return Number(value)
  return 0
}
