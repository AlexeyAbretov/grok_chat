import { EFFORTS, type Effort } from './protocol.ts'

export type JsonSchema =
  | { type: 'string'; enum?: readonly string[] }
  | { type: 'integer'; minimum: number; maximum: number }
  | { type: 'array'; items: JsonSchema }
  | {
      type: 'object'
      additionalProperties: false
      required: readonly string[]
      properties: Readonly<Record<string, JsonSchema>>
    }

export type SchemaIssue =
  | { kind: 'extra'; path: string }
  | { kind: 'type'; path: string }
  | { kind: 'value'; path: string }
  | { kind: 'missing'; path: string }

export type ChatRequest = {
  chatId: string
  model: string
  reasoningEffort: Effort
  maxTokens: number
  content: string
  userMessageId: string
  assistantMessageId: string
}

const effortIds = EFFORTS.map((item) => item.id)

export const json_schema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['chatId', 'model', 'reasoningEffort', 'maxTokens', 'content', 'userMessageId', 'assistantMessageId'],
  properties: {
    chatId: { type: 'string' },
    model: { type: 'string' },
    reasoningEffort: { type: 'string', enum: effortIds },
    maxTokens: { type: 'integer', minimum: 1, maximum: 128_000 },
    content: { type: 'string' },
    userMessageId: { type: 'string' },
    assistantMessageId: { type: 'string' },
  },
}

export function parseJsonText(raw: string): { ok: true; value: unknown } | { ok: false; reason: 'truncated' | 'invalid' } {
  const text = raw.trim()
  if (!text) return { ok: false, reason: 'invalid' }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (/unexpected end of json input|unterminated string/i.test(message) || unclosedJson(text)) {
      return { ok: false, reason: 'truncated' }
    }
    return { ok: false, reason: 'invalid' }
  }
}

export function parseChatRequest(raw: string): { ok: true; request: ChatRequest } | { ok: false; message: string } {
  const parsed = parseJsonText(raw)
  if (!parsed.ok) {
    return { ok: false, message: parsed.reason === 'truncated' ? 'JSON обрезан' : 'Некорректный JSON' }
  }
  const issue = validateJsonSchema(parsed.value, json_schema)
  if (issue) return { ok: false, message: schemaIssueText(issue) }
  if (!isRecord(parsed.value)) return { ok: false, message: 'Неверный тип «тело»' }

  const chatId = parsed.value.chatId
  const model = parsed.value.model
  const reasoningEffort = parsed.value.reasoningEffort
  const maxTokens = parsed.value.maxTokens
  const content = parsed.value.content
  const userMessageId = parsed.value.userMessageId
  const assistantMessageId = parsed.value.assistantMessageId
  if (!isChatId(chatId)) return { ok: false, message: 'Недопустимое значение «chatId»' }
  if (!isModel(model)) return { ok: false, message: 'Недопустимое значение «model»' }
  if (!isEffort(reasoningEffort) || typeof maxTokens !== 'number' || typeof content !== 'string') {
    return { ok: false, message: 'Недопустимое значение «тело»' }
  }
  if (!content.trim()) return { ok: false, message: 'Пустое сообщение' }
  if (!isChatId(userMessageId)) return { ok: false, message: 'Недопустимое значение «userMessageId»' }
  if (!isChatId(assistantMessageId) || assistantMessageId === userMessageId) {
    return { ok: false, message: 'Недопустимое значение «assistantMessageId»' }
  }

  return {
    ok: true,
    request: { chatId, model, reasoningEffort, maxTokens, content: content.trim(), userMessageId, assistantMessageId },
  }
}

export function validateJsonSchema(value: unknown, schema: JsonSchema, path = ''): SchemaIssue | null {
  if (schema.type === 'string') {
    if (typeof value !== 'string') return { kind: 'type', path: label(path) }
    if (schema.enum && !schema.enum.includes(value)) return { kind: 'value', path: label(path) }
    return null
  }
  if (schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return { kind: 'type', path: label(path) }
    if (value < schema.minimum || value > schema.maximum) return { kind: 'value', path: label(path) }
    return null
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return { kind: 'type', path: label(path) }
    for (let index = 0; index < value.length; index += 1) {
      const issue = validateJsonSchema(value[index], schema.items, `${path}[${index}]`)
      if (issue) return issue
    }
    return null
  }
  if (!isRecord(value)) return { kind: 'type', path: label(path) }
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
      return { kind: 'extra', path: join(path, key) }
    }
  }
  for (const key of schema.required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return { kind: 'missing', path: join(path, key) }
  }
  for (const key of Object.keys(schema.properties)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    const issue = validateJsonSchema(value[key], schema.properties[key], join(path, key))
    if (issue) return issue
  }
  return null
}

export function schemaIssueText(issue: SchemaIssue) {
  if (issue.kind === 'extra') return `Лишнее поле «${issue.path}»`
  if (issue.kind === 'type') return `Неверный тип «${issue.path}»`
  if (issue.kind === 'missing') return `Нет поля «${issue.path}»`
  return `Недопустимое значение «${issue.path}»`
}

function unclosedJson(text: string) {
  let depth = 0
  let inString = false
  let escape = false
  for (const char of text) {
    if (inString) {
      if (escape) {
        escape = false
        continue
      }
      if (char === '\\') {
        escape = true
        continue
      }
      if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      depth -= 1
      if (depth < 0) return false
    }
  }
  return inString || depth > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function isChatId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function isModel(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200
}

function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && EFFORTS.some((effort) => effort.id === value)
}

function label(path: string) {
  return path || 'тело'
}

function join(path: string, key: string) {
  return path ? `${path}.${key}` : key
}
