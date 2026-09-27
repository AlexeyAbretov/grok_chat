import { parseChatRequest } from '../shared/json-schema.ts'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

const valid = {
  chatId: '11111111-1111-4111-8111-111111111111',
  model: 'grok-4.7',
  reasoningEffort: 'high',
  maxTokens: 4096,
  content: 'привет',
  userMessageId: '22222222-2222-4222-8222-222222222222',
  assistantMessageId: '33333333-3333-4333-8333-333333333333',
}

function messageFor(value: unknown) {
  const result = parseChatRequest(JSON.stringify(value))
  assert(!result.ok, 'expected a schema error')
  if (result.ok) return ''
  return result.message
}

const ok = parseChatRequest(JSON.stringify(valid))
assert(ok.ok && ok.request.content === 'привет' && ok.request.chatId === valid.chatId, 'valid request is accepted')
assert(messageFor({ ...valid, content: '  ' }) === 'Пустое сообщение', 'blank content is rejected')
assert(
  messageFor({ ...valid, assistantMessageId: valid.userMessageId }) === 'Недопустимое значение «assistantMessageId»',
  'message ids must differ',
)

assert(messageFor({ ...valid, store: false }) === 'Лишнее поле «store»', 'extra root field is rejected')
assert(
  messageFor({ ...valid, messages: [{ role: 'user', content: 'привет' }] }) === 'Лишнее поле «messages»',
  'message history is rejected',
)
assert(messageFor({ ...valid, model: 1 }) === 'Неверный тип «model»', 'wrong model type is rejected')
assert(messageFor({ ...valid, maxTokens: '4096' }) === 'Неверный тип «maxTokens»', 'string token limit is rejected')
assert(messageFor({ ...valid, maxTokens: 1.5 }) === 'Неверный тип «maxTokens»', 'fractional token limit is rejected')
assert(messageFor({ ...valid, maxTokens: 0 }) === 'Недопустимое значение «maxTokens»', 'token limit range is checked')
const anyModel = parseChatRequest(JSON.stringify({ ...valid, model: 'gpt' }))
assert(anyModel.ok && anyModel.request.model === 'gpt', 'schema accepts a model id the catalog has not seen')
assert(messageFor({ ...valid, model: '' }) === 'Недопустимое значение «model»', 'empty model is rejected')
assert(messageFor({ ...valid, model: '   ' }) === 'Недопустимое значение «model»', 'blank model is rejected')
assert(
  messageFor({ chatId: valid.chatId, model: 'grok-4.7', reasoningEffort: 'high' }) === 'Нет поля «maxTokens»',
  'missing field is rejected',
)
assert(messageFor({ ...valid, chatId: '../.env' }) === 'Недопустимое значение «chatId»', 'a path is not a chat id')
assert(messageFor({ ...valid, chatId: 'logs/chat' }) === 'Недопустимое значение «chatId»', 'a chat id must be a uuid')
const withoutChat: Record<string, unknown> = { ...valid }
delete withoutChat.chatId
assert(messageFor(withoutChat) === 'Нет поля «chatId»', 'missing chat id is rejected')

const truncated = parseChatRequest('{"model":"grok-4.7"')
assert(!truncated.ok && truncated.message === 'JSON обрезан', 'truncated json is named')
const invalid = parseChatRequest('{]')
assert(!invalid.ok && invalid.message === 'Некорректный JSON', 'invalid json is not called truncated')
const empty = parseChatRequest('')
assert(!empty.ok && empty.message === 'Некорректный JSON', 'empty body is invalid json')
const nil = parseChatRequest('null')
assert(!nil.ok && nil.message === 'Неверный тип «тело»', 'null body is the wrong type')

console.log('schema ok')
