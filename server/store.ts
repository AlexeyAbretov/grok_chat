import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { parsePersistedState, titleFrom, type Chat, type ChatMessage, type PersistedState } from '../shared/state.ts'

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
  deleteChat: StatementSync
  insertChat: StatementSync
  insertMessage: StatementSync
  updateChat: StatementSync
  updateMessage: StatementSync
  shiftSort: StatementSync
  maxPosition: StatementSync
  upsertMeta: StatementSync
  selectChats: StatementSync
  selectMessages: StatementSync
  selectChat: StatementSync
  selectChatMessages: StatementSync
  selectMessageId: StatementSync
  selectFirstChat: StatementSync
  selectActive: StatementSync
}

export type StoredTurn = {
  chatId: string
  content: string
  userMessageId: string
  assistantMessageId: string
  model: string
  maxTokens: number
  reasoningEffort: string
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

export function readChat(chatId: string): Chat | null {
  const sql = db()
  const row = sql.selectChat.get(chatId)
  if (!row || typeof row.id !== 'string') return null
  const messages = []
  for (const messageRow of sql.selectChatMessages.all(chatId)) {
    const message = messageFromRow(messageRow)
    if (message) messages.push(message.message)
  }
  const parsed = parsePersistedState({
    chats: [
      {
        id: row.id,
        title: text(row.title),
        model: text(row.model),
        maxTokens: integer(row.max_tokens),
        reasoningEffort: text(row.reasoning_effort),
        draft: text(row.draft),
        messages,
        createdAt: integer(row.created_at),
        updatedAt: integer(row.updated_at),
      },
    ],
    activeId: row.id,
  })
  if (!parsed.ok) return null
  return parsed.state.chats[0] ?? null
}

export function insertChat(chat: Chat): boolean {
  const sql = db()
  if (sql.selectChat.get(chat.id)) return false
  sql.db.exec('BEGIN IMMEDIATE')
  try {
    sql.shiftSort.run()
    sql.insertChat.run(chat.id, chat.title, chat.model, chat.maxTokens, chat.reasoningEffort, chat.draft, chat.createdAt, chat.updatedAt, 0)
    chat.messages.forEach((message, position) => insertMessage(sql, chat.id, position, message))
    sql.db.exec('COMMIT')
  } catch (error) {
    sql.db.exec('ROLLBACK')
    throw error
  }
  return true
}

export function setActiveId(chatId: string): boolean {
  const sql = db()
  if (!sql.selectChat.get(chatId)) return false
  sql.upsertMeta.run('active_id', chatId)
  return true
}

export function deleteChat(chatId: string): boolean {
  const sql = db()
  if (!sql.selectChat.get(chatId)) return false
  sql.db.exec('BEGIN IMMEDIATE')
  try {
    sql.deleteChat.run(chatId)
    const active = sql.selectActive.get('active_id')
    if (!active || active.value === chatId) {
      const next = sql.selectFirstChat.get()
      if (next && typeof next.id === 'string') sql.upsertMeta.run('active_id', next.id)
    }
    sql.db.exec('COMMIT')
  } catch (error) {
    sql.db.exec('ROLLBACK')
    throw error
  }
  return true
}

export function beginTurn(turn: StoredTurn): { ok: true } | { ok: false; reason: 'missing' | 'duplicate' } {
  const sql = db()
  const row = sql.selectChat.get(turn.chatId)
  if (!row) return { ok: false, reason: 'missing' }
  if (sql.selectMessageId.get(turn.userMessageId) || sql.selectMessageId.get(turn.assistantMessageId)) {
    return { ok: false, reason: 'duplicate' }
  }
  const position = integer(sql.maxPosition.get(turn.chatId)?.max_position) + 1
  const now = Date.now()
  const title = text(row.title) === 'Новый чат' ? titleFrom(turn.content) : text(row.title)
  const user: ChatMessage = {
    id: turn.userMessageId,
    role: 'user',
    content: turn.content,
    reasoning: '',
    tools: [],
    usage: null,
    error: null,
    notice: null,
    stopped: false,
  }
  const assistant: ChatMessage = {
    id: turn.assistantMessageId,
    role: 'assistant',
    content: '',
    reasoning: '',
    tools: [],
    usage: null,
    error: null,
    notice: null,
    stopped: false,
  }
  sql.db.exec('BEGIN IMMEDIATE')
  try {
    sql.updateChat.run(turn.model, turn.maxTokens, turn.reasoningEffort, '', title, now, turn.chatId)
    insertMessage(sql, turn.chatId, position, user)
    insertMessage(sql, turn.chatId, position + 1, assistant)
    sql.db.exec('COMMIT')
  } catch (error) {
    sql.db.exec('ROLLBACK')
    throw error
  }
  return { ok: true }
}

export function updateMessage(chatId: string, message: ChatMessage): boolean {
  const sql = db()
  const updated = sql.updateMessage.run(
    message.content,
    message.reasoning,
    JSON.stringify(message.tools),
    message.usage ? JSON.stringify(message.usage) : null,
    message.error,
    message.notice,
    message.stopped ? 1 : 0,
    message.id,
    chatId,
  )
  return updated.changes > 0
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
    deleteChat: db.prepare('DELETE FROM chats WHERE id = ?'),
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
    updateChat: db.prepare(
      `UPDATE chats
       SET model = ?, max_tokens = ?, reasoning_effort = ?, draft = ?, title = ?, updated_at = ?
       WHERE id = ?`,
    ),
    updateMessage: db.prepare(
      `UPDATE messages
       SET content = ?, reasoning = ?, tools_json = ?, usage_json = ?, error = ?, notice = ?, stopped = ?
       WHERE id = ? AND chat_id = ?`,
    ),
    shiftSort: db.prepare('UPDATE chats SET sort_index = sort_index + 1'),
    maxPosition: db.prepare('SELECT COALESCE(MAX(position), -1) AS max_position FROM messages WHERE chat_id = ?'),
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
    selectChat: db.prepare(
      `SELECT id, title, model, max_tokens, reasoning_effort, draft, created_at, updated_at
       FROM chats WHERE id = ?`,
    ),
    selectChatMessages: db.prepare(
      `SELECT id, chat_id, role, content, reasoning, tools_json, usage_json, error, notice, stopped
       FROM messages WHERE chat_id = ? ORDER BY position ASC`,
    ),
    selectMessageId: db.prepare('SELECT id FROM messages WHERE id = ?'),
    selectFirstChat: db.prepare('SELECT id FROM chats ORDER BY sort_index ASC LIMIT 1'),
    selectActive: db.prepare('SELECT value FROM meta WHERE key = ?'),
  }
}

function insertMessage(sql: Statements, chatId: string, position: number, message: ChatMessage) {
  sql.insertMessage.run(
    message.id,
    chatId,
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
