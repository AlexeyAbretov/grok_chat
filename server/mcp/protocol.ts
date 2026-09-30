// MCP здесь — JSON-RPC 2.0 по строкам. Одно сообщение, одна строка, без перевода строки внутри.
// Клиент сначала шлёт initialize, потом уведомление notifications/initialized (у него нет id и на него нет ответа).
// Дальше tools/list отдаёт чужие инструменты вместе со схемой аргументов, а tools/call их исполняет.
// Схема не зашита в цикл чата: её привозит ответ tools/list.
import { mcpTools, runMcpTool } from './tools.ts'

/** Версия протокола, на которой говорит этот сервер. Другую мы не обещаем. */
export const MCP_PROTOCOL = '2024-11-05'

export type McpSession = {
  /** Пока false, сервер принимает только initialize. Список и вызов инструментов раньше этого — ошибка. */
  initialized: boolean
}

type JsonRpcId = string | number | null

/**
 * Одна строка со stdin. Ответ — строка JSON или null, если отвечать не нужно.
 * Уведомление без id ответа не получает: клиент его не ждёт.
 */
export async function replyToMcpLine(line: string, session: McpSession): Promise<string | null> {
  const trimmed = line.trim()
  if (!trimmed) return null
  let message: unknown
  try {
    message = JSON.parse(trimmed) as unknown
  } catch {
    return JSON.stringify(rpcError(null, -32700, 'Некорректный JSON'))
  }
  const response = await dispatchMcp(message, session)
  if (!response) return null
  return JSON.stringify(response)
}

/** Разбирает уже распарсенное сообщение и возвращает объект ответа или null. */
export async function dispatchMcp(message: unknown, session: McpSession): Promise<Record<string, unknown> | null> {
  const record = asRecord(message)
  if (!record || record.jsonrpc !== '2.0') return rpcError(idOf(record), -32600, 'Некорректный запрос')

  const hasId = Object.prototype.hasOwnProperty.call(record, 'id')
  const id = idOf(record)
  if (hasId && record.id !== null && typeof record.id !== 'string' && typeof record.id !== 'number') {
    return rpcError(null, -32600, 'Некорректный запрос')
  }

  if (typeof record.method !== 'string') return hasId ? rpcError(id, -32600, 'Некорректный запрос') : null
  const method = record.method

  // Уведомление: id нет. initialized только поднимает флаг, писать в stdout нечего.
  if (!hasId) {
    if (method === 'notifications/initialized') session.initialized = true
    return null
  }

  if (method === 'initialize') {
    session.initialized = true
    return rpcResult(id, {
      protocolVersion: MCP_PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'grok-corpus', version: '0.0.0' },
    })
  }

  if (!session.initialized) return rpcError(id, -32600, 'Сначала нужен initialize')
  if (method === 'tools/list') return rpcResult(id, { tools: mcpTools })
  if (method === 'tools/call') return callTool(id, record.params)
  return rpcError(id, -32601, 'Метод не поддерживается')
}

async function callTool(id: JsonRpcId, params: unknown): Promise<Record<string, unknown>> {
  const record = asRecord(params)
  const name = record?.name
  if (typeof name !== 'string' || !name) return rpcError(id, -32602, 'Нет имени инструмента')
  const args = record?.arguments ?? {}
  try {
    // Ошибка аргументов и запрещённый путь — это ответ инструмента, не ошибка JSON-RPC.
    // Модель видит isError и текст. Протокол при этом отработал.
    const result = await runMcpTool(name, args)
    return rpcResult(id, { content: [{ type: 'text', text: result.output }], isError: !result.ok })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ошибка инструмента'
    return rpcResult(id, { content: [{ type: 'text', text: message }], isError: true })
  }
}

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function idOf(record: Record<string, unknown> | null): JsonRpcId {
  if (!record || !Object.prototype.hasOwnProperty.call(record, 'id')) return null
  const id = record.id
  if (typeof id === 'string' || typeof id === 'number' || id === null) return id
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return null
}
