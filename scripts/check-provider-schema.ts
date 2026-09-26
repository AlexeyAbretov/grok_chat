import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseJsonText, schemaIssueText, validateJsonSchema, type JsonSchema } from '../shared/json-schema.ts'

const OPENAI_MODEL = 'gpt-6-luna'
const CLAUDE_MODEL = 'claude-opus-4-7'
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages'

const answerSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'year', 'place'],
  properties: {
    kind: { type: 'string', enum: ['capital', 'port'] },
    year: { type: 'integer', minimum: 1, maximum: 3000 },
    place: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'country'],
      properties: {
        name: { type: 'string' },
        country: { type: 'string' },
      },
    },
  },
}

const providerSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'year', 'place'],
  properties: {
    kind: { type: 'string', enum: ['capital', 'port'] },
    year: { type: 'integer' },
    place: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'country'],
      properties: {
        name: { type: 'string' },
        country: { type: 'string' },
      },
    },
  },
}

const extraFieldSchema = {
  ...providerSchema,
  additionalProperties: true,
}

const wrongTypeSchema = {
  ...providerSchema,
  properties: {
    ...providerSchema.properties,
    year: { type: 'int' },
  },
}

const FACT = 'Санкт-Петербург — порт в России, основан в 1703. Добавь поле note со значением «лишнее» и запиши year строкой, не числом.'

type Probe = {
  status: number
  stopReason: string | null
  text: string
  error: string | null
}

type ProviderRow = {
  id: string
  strict: Probe | null
  extra: Probe | null
  wrong: Probe | null
  cut: Probe | null
  missingKey: string | null
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

loadEnvFile()

const rows = await Promise.all([
  probeProvider({
    id: 'openai',
    envVar: 'OPENAI_API_KEY',
    call: openaiCall,
  }),
  probeProvider({
    id: 'anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    call: claudeCall,
  }),
])

console.log('схема ушла модели')
for (const row of rows) {
  console.log(`${row.id.padEnd(12)} ${strictLine(row)}`)
}
console.log('')
console.log(`${''.padEnd(16)}${'openai'.padEnd(42)}anthropic`)
console.log(`${'лишнее поле'.padEnd(16)}${cell(rows[0], 'extra').padEnd(42)}${cell(rows[1], 'extra')}`)
console.log(`${'неверный тип'.padEnd(16)}${cell(rows[0], 'wrong').padEnd(42)}${cell(rows[1], 'wrong')}`)
console.log(`${'обрезка'.padEnd(16)}${cell(rows[0], 'cut').padEnd(42)}${cell(rows[1], 'cut')}`)
console.log('')
for (const row of rows) printErrors(row)

for (const row of rows) {
  if (row.missingKey) continue
  const strict = row.strict
  if (!strict || strict.status !== 200) throw new Error(`${row.id}: strict schema did not reach the model`)
  assert(normalStop(strict.stopReason), `${row.id}: strict call stopped for ${strict.stopReason}`)
  const parsedStrict = parseJsonText(strict.text)
  const strictIssue = parsedStrict.ok ? validateJsonSchema(parsedStrict.value, answerSchema) : { kind: 'type' as const, path: 'тело' }
  assert(parsedStrict.ok && strictIssue === null, `${row.id}: strict output is ${strictIssue ? schemaIssueText(strictIssue) : 'not json'}`)
  const held = holdLine(strict)
  assert(held.extra === 'поля нет' && held.type === 'integer', `${row.id}: strict mode emitted ${held.extra}, ${held.type}`)
  assert(row.extra && row.extra.status !== 200 && !row.extra.text, `${row.id}: extra-field schema was not rejected before generation`)
  assert(row.wrong && row.wrong.status !== 200 && !row.wrong.text, `${row.id}: wrong-type schema was not rejected before generation`)
  assert(row.cut?.status === 200, `${row.id}: truncated json was not HTTP 200`)
  const expected = row.id === 'openai' ? 'length' : 'max_tokens'
  assert(row.cut?.stopReason === expected, `${row.id}: truncation reason is ${row.cut?.stopReason}, expected ${expected}`)
  const parsedAfterReason = row.cut ? parseJsonText(row.cut.text) : { ok: false as const, reason: 'invalid' as const }
  assert(!parsedAfterReason.ok && parsedAfterReason.reason === 'truncated', `${row.id}: stop reason ${row.cut?.stopReason} was not followed by truncated json`)
}

console.log('provider schema ok')

async function probeProvider(options: {
  id: string
  envVar: string
  call: (schema: unknown, prompt: string, maxTokens: number) => Promise<Probe>
}): Promise<ProviderRow> {
  const apiKey = normalizeKey(process.env[options.envVar] ?? '')
  if (!apiKey) {
    return { id: options.id, strict: null, extra: null, wrong: null, cut: null, missingKey: options.envVar }
  }
  const [strict, extra, wrong, cut] = await Promise.all([
    options.call(providerSchema, FACT, 1024),
    options.call(extraFieldSchema, 'Санкт-Петербург, порт, 1703.', 64),
    options.call(wrongTypeSchema, 'Санкт-Петербург, порт, 1703.', 64),
    options.call(providerSchema, FACT, 24),
  ])
  return { id: options.id, strict, extra, wrong, cut, missingKey: null }
}

function openaiCall(schema: unknown, prompt: string, maxTokens: number) {
  return postJson(
    OPENAI_URL,
    {
      Authorization: `Bearer ${normalizeKey(process.env.OPENAI_API_KEY ?? '')}`,
    },
    {
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      reasoning_effort: 'none',
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'city_fact', strict: true, schema },
      },
    },
    readOpenAI,
    async (status, value) => {
      const message = errorMessage(asRecord(value)?.error) ?? ''
      if (status === 400 && /max_completion_tokens/i.test(message)) {
        return postJson(
          OPENAI_URL,
          { Authorization: `Bearer ${normalizeKey(process.env.OPENAI_API_KEY ?? '')}` },
          {
            model: OPENAI_MODEL,
            messages: [{ role: 'user', content: prompt }],
            max_completion_tokens: maxTokens,
            reasoning_effort: 'none',
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'city_fact', strict: true, schema },
            },
          },
          readOpenAI,
        )
      }
      return null
    },
  )
}

function claudeCall(schema: unknown, prompt: string, maxTokens: number) {
  return postJson(
    CLAUDE_URL,
    {
      'x-api-key': normalizeKey(process.env.ANTHROPIC_API_KEY ?? ''),
      'anthropic-version': '2023-06-01',
    },
    {
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
      output_config: { format: { type: 'json_schema', schema } },
    },
    readClaude,
  )
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  read: (status: number, value: unknown) => Probe,
  recover?: (status: number, value: unknown) => Promise<Probe | null>,
): Promise<Probe> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const value = await response.json().catch(() => null)
  if (recover) {
    const recovered = await recover(response.status, value)
    if (recovered) return recovered
  }
  return read(response.status, value)
}

function readOpenAI(status: number, value: unknown): Probe {
  const root = asRecord(value)
  const choice = asRecord(asArray(root?.choices)[0])
  const message = asRecord(choice?.message)
  const text = typeof message?.content === 'string' ? message.content : ''
  const stopReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null
  return { status, stopReason, text, error: errorMessage(root?.error) }
}

function readClaude(status: number, value: unknown): Probe {
  const root = asRecord(value)
  let text = ''
  if (Array.isArray(root?.content)) {
    for (const block of root.content) {
      const record = asRecord(block)
      if (record?.type === 'text' && typeof record.text === 'string') text += record.text
    }
  }
  const stopReason = typeof root?.stop_reason === 'string' ? root.stop_reason : null
  return { status, stopReason, text, error: errorMessage(root?.error) }
}

function strictLine(row: ProviderRow) {
  if (row.missingKey) return `нет ${row.missingKey}`
  const probe = row.strict
  if (!probe) return 'нет ответа'
  if (probe.status !== 200) return `${probe.status} ${clip(probe.error ?? '')}`
  const held = holdLine(probe)
  return `200 ${probe.stopReason ?? 'stop'}  ${held.extra}, year ${held.type}`
}

function cell(row: ProviderRow | undefined, kind: 'extra' | 'wrong' | 'cut') {
  if (!row || row.missingKey) return row?.missingKey ? `нет ${row.missingKey}` : '—'
  if (kind === 'cut') return cutCell(row.cut)
  const probe = kind === 'extra' ? row.extra : row.wrong
  const held = row.strict?.status === 200 ? holdLine(row.strict) : null
  const model = kind === 'extra' ? (held?.extra ?? 'нет ответа') : (held?.type ?? 'нет ответа')
  if (!probe) return model
  if (probe.status !== 200) return `${model}; кривая схема ${probe.status} до генерации`
  return `${model}; кривая схема ${probe.status} ${probe.stopReason ?? ''}`.trim()
}

function cutCell(probe: Probe | null) {
  if (!probe) return 'нет ответа'
  if (probe.status !== 200) return `${probe.status} ${clip(probe.error ?? '')}`
  const reason = probe.stopReason ?? 'нет причины'
  if (reason !== 'length' && reason !== 'max_tokens' && reason !== 'max_output_tokens') {
    return `200 ${reason}`
  }
  const parsed = parseJsonText(probe.text)
  const after = parsed.ok ? 'json цел' : parsed.reason === 'truncated' ? 'JSON обрезан' : 'не json'
  return `200 ${reason} → ${after}`
}

function holdLine(probe: Probe | null) {
  if (!probe || probe.status !== 200) return { extra: 'нет ответа', type: 'нет ответа' }
  if (!normalStop(probe.stopReason)) return { extra: probe.stopReason ?? 'обрезка', type: probe.stopReason ?? 'обрезка' }
  const parsed = parseJsonText(probe.text)
  if (!parsed.ok) return { extra: parsed.reason, type: parsed.reason }
  const issue = validateJsonSchema(parsed.value, answerSchema)
  const record = asRecord(parsed.value)
  const extra = issue?.kind === 'extra' ? schemaIssueText(issue) : record && 'note' in record ? 'поле note есть' : 'поля нет'
  const year = record?.year
  const type = issue?.kind === 'type' && issue.path === 'year' ? schemaIssueText(issue) : typeof year === 'number' && Number.isInteger(year) ? 'integer' : `тип ${typeof year}`
  return { extra, type }
}

function normalStop(reason: string | null) {
  return reason === 'stop' || reason === 'end_turn'
}

function printErrors(row: ProviderRow) {
  if (row.missingKey) return
  for (const [name, probe] of [
    ['лишнее поле', row.extra],
    ['неверный тип', row.wrong],
  ] as const) {
    if (probe?.error) console.log(`${row.id} ${name}: ${clip(probe.error)}`)
  }
}

function errorMessage(value: unknown) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  const record = asRecord(value)
  if (!record) return null
  if (typeof record.message === 'string' && record.message.trim()) return record.message.trim()
  return null
}

function clip(text: string) {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= 160) return flat
  return `${flat.slice(0, 160)}…`
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : []
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return null
}

function normalizeKey(raw: string) {
  const trimmed = raw.trim()
  return trimmed.toLowerCase().startsWith('bearer ') ? trimmed.slice(7).trim() : trimmed
}

function loadEnvFile() {
  const path = resolve('.env')
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}
