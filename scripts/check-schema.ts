import { parseChatRequest } from '../src/json-schema.ts'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

const valid = {
  model: 'grok-4.7',
  reasoningEffort: 'high',
  maxTokens: 4096,
  messages: [{ role: 'user', content: 'привет' }],
}

function messageFor(value: unknown) {
  const result = parseChatRequest(JSON.stringify(value))
  assert(!result.ok, 'expected a schema error')
  if (result.ok) return ''
  return result.message
}

const ok = parseChatRequest(JSON.stringify(valid))
assert(ok.ok && ok.request.messages[0].content === 'привет', 'valid request is accepted')

assert(messageFor({ ...valid, store: false }) === 'Лишнее поле «store»', 'extra root field is rejected')
assert(
  messageFor({ ...valid, messages: [{ role: 'user', content: 'привет', id: '1' }] }) === 'Лишнее поле «messages[0].id»',
  'extra message field is rejected',
)
assert(messageFor({ ...valid, model: 1 }) === 'Неверный тип «model»', 'wrong model type is rejected')
assert(messageFor({ ...valid, maxTokens: '4096' }) === 'Неверный тип «maxTokens»', 'string token limit is rejected')
assert(messageFor({ ...valid, maxTokens: 1.5 }) === 'Неверный тип «maxTokens»', 'fractional token limit is rejected')
assert(messageFor({ ...valid, maxTokens: 0 }) === 'Недопустимое значение «maxTokens»', 'token limit range is checked')
assert(messageFor({ ...valid, model: 'gpt' }) === 'Недопустимое значение «model»', 'unknown model is rejected')
assert(messageFor({ model: 'grok-4.7', reasoningEffort: 'high', maxTokens: 4096 }) === 'Нет поля «messages»', 'missing field is rejected')
assert(messageFor({ ...valid, messages: [] }) === 'Пустое сообщение', 'empty history is rejected')
assert(messageFor({ ...valid, messages: [{ role: 'user', content: '  ' }] }) === 'Пустое сообщение', 'blank content is rejected')

const truncated = parseChatRequest('{"model":"grok-4.7"')
assert(!truncated.ok && truncated.message === 'JSON обрезан', 'truncated json is named')
const invalid = parseChatRequest('{]')
assert(!invalid.ok && invalid.message === 'Некорректный JSON', 'invalid json is not called truncated')
const empty = parseChatRequest('')
assert(!empty.ok && empty.message === 'Некорректный JSON', 'empty body is invalid json')
const nil = parseChatRequest('null')
assert(!nil.ok && nil.message === 'Неверный тип «тело»', 'null body is the wrong type')

console.log('schema ok')
