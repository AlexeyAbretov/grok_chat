import { readFileSync, unlinkSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { createLlmLog, formatLlmItem, llmLogPath } from '../server/llm-log.ts'
import { locateNote, runTool, type ToolIo } from '../server/tools.ts'
import { addUsage, consumeTurn } from '../server/turn.ts'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

const notesRoot = resolve('notes')

function blockingRead(file: string): string {
  throw new Error(`readFile вызван для ${file}`)
}

const blocked: ToolIo = { readFile: blockingRead }

const added = runTool('calculator', { op: 'add', a: 2, b: 3 })
assert(added.ok && added.output === '{"result":5}', 'add returns the sum')

const subtracted = runTool('calculator', { op: 'sub', a: 2, b: 3 })
assert(subtracted.ok && subtracted.output === '{"result":-1}', 'sub returns the difference')

const multiplied = runTool('calculator', { op: 'mul', a: 2, b: 3 })
assert(multiplied.ok && multiplied.output === '{"result":6}', 'mul returns the product')

const divided = runTool('calculator', { op: 'div', a: 1, b: 2 })
assert(divided.ok && divided.output === '{"result":0.5}', 'div returns the quotient')

const zero = runTool('calculator', { op: 'div', a: 1, b: 0 })
assert(!zero.ok && zero.output === 'Деление на ноль', 'division by zero is a tool error')

const negativeZero = runTool('calculator', { op: 'div', a: 1, b: -0 })
assert(!negativeZero.ok && negativeZero.output === 'Деление на ноль', 'negative zero is still zero')

assert(!runTool('calculator', { op: 'eval', a: 1, b: 1 }).ok, 'unknown operation is rejected')
assert(!runTool('calculator', { op: 'add', a: '2', b: 3 }).ok, 'string operands are rejected')
assert(runTool('calculator', { op: 'add', a: 1, b: 2, expr: '1+2' }).output === 'Лишнее поле «expr»', 'extra calculator field is rejected')
assert(!runTool('nope', {}).ok, 'unknown tool is rejected')

for (const path of ['../../.env', '..\\..\\.env', 'notes/../../.env', 'a.md/../../../.env', './../../.env', resolve('.env')]) {
  const denied = runTool('read_file', { path }, blocked)
  assert(!denied.ok && denied.output === 'Путь вне папки notes', `path is rejected before readFile: ${path}`)
  assert(!locateNote(path).ok, `locateNote rejects ${path}`)
}

let reads = 0
const read = runTool('read_file', { path: 'notes/a.md' }, {
  readFile(file) {
    reads += 1
    const rel = relative(notesRoot, file)
    assert(rel === `a.md` || rel === 'a.md', 'read stays inside notes')
    assert(file.startsWith(notesRoot + sep), 'absolute path is under notes')
    return '# Калькулятор\n'
  },
})
assert(reads === 1, 'a note path is read once')
assert(read.ok && read.output.includes('"path":"a.md"') && read.output.includes('Калькулятор'), 'read returns the note')

const missing = runTool('read_file', { path: 'missing.md' }, {
  readFile() {
    const error = new Error('missing') as NodeJS.ErrnoException
    error.code = 'ENOENT'
    throw error
  },
})
assert(!missing.ok && missing.output === 'Файл не найден', 'missing note is a tool error')

assert(runTool('search_notes', { query: '   ' }, blocked).output === 'Пустой запрос', 'blank search does not read files')

const found = runTool('search_notes', { query: 'Санкт-Петербург' }, {
  readFile(file) {
    if (file.endsWith(`${sep}a.md`)) return `${'x'.repeat(80)}город Санкт-Петербург стоит${'y'.repeat(80)}`
    if (file.endsWith(`${sep}b.md`)) return 'бета'
    if (file.endsWith(`${sep}c.md`)) return 'вторая строка\nещё Санкт-Петербург'
    throw new Error(`unexpected ${file}`)
  },
})
assert(found.ok, 'search succeeds')
const payload = JSON.parse(found.output) as { matches: { file: string; line: number; snippet: string }[] }
assert(payload.matches.length === 2, 'search finds both notes')
assert(payload.matches[0].file === 'a.md' && payload.matches[0].line === 1, 'first hit keeps file and line')
assert(payload.matches[0].snippet.startsWith('…') && payload.matches[0].snippet.endsWith('…'), 'snippet is a short window')
assert(payload.matches[0].snippet.includes('Санкт-Петербург'), 'snippet contains the match')
assert(payload.matches[1].file === 'c.md' && payload.matches[1].line === 2, 'second hit is on the next line')

function sse(events: unknown[]) {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

const emitted: unknown[] = []
const turn = await consumeTurn(
  sse([
    { type: 'response.output_text.delta', delta: 'считаю' },
    { type: 'response.function_call_arguments.delta', delta: '{"op":"add"}' },
    {
      type: 'response.completed',
      response: {
        output_text: 'считаю целиком',
        output: [
          { type: 'function_call', call_id: 'call_1', name: 'calculator', arguments: '{"op":"add","a":2,"b":3}' },
        ],
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5, cost_in_usd_ticks: 10 },
      },
    },
  ]),
  (event) => {
    emitted.push(event)
  },
  new AbortController().signal,
)
assert(emitted.length === 1 && (emitted[0] as { delta?: string }).delta === 'считаю', 'argument deltas are not forwarded')
assert(turn.calls.length === 1 && turn.calls[0].name === 'calculator' && turn.calls[0].callId === 'call_1', 'function call is captured')
assert(turn.usage?.inputTokens === 3 && turn.usage.costTicks === 10, 'turn usage is read')

const finalOnly = await consumeTurn(
  sse([
    {
      type: 'response.completed',
      response: {
        output_text: '42',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '42' }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]),
  (event) => {
    emitted.push(event)
  },
  new AbortController().signal,
)
assert(finalOnly.calls.length === 0, 'a plain answer has no tool call')
assert((emitted.at(-1) as { delta?: string }).delta === '42', 'final text is forwarded when nothing was streamed')

const broken = await consumeTurn(
  sse([{ type: 'response.completed', response: { output: [{ type: 'function_call', name: 'calculator', arguments: '{}' }] } }]),
  () => undefined,
  new AbortController().signal,
)
assert(broken.failed === 'Вызов инструмента без идентификатора', 'a call without an id is rejected')

const summed = addUsage(
  { inputTokens: 1, outputTokens: 2, reasoningTokens: null, cachedTokens: 1, totalTokens: 3, costTicks: 4 },
  { inputTokens: 5, outputTokens: 6, reasoningTokens: 7, cachedTokens: null, totalTokens: 8, costTicks: null },
)
assert(summed?.inputTokens === 6 && summed.reasoningTokens === 7 && summed.cachedTokens === 1 && summed.costTicks === 4, 'usage from tool rounds is summed')

const secret = 'x'.repeat(80)
const loggedCall = formatLlmItem({ type: 'function_call', name: 'calculator', arguments: '{"op":"div","a":1,"b":0}' })
assert(loggedCall.includes('function_call calculator') && loggedCall.includes('"op":"div"'), 'a function call is logged')
const loggedReasoning = formatLlmItem({
  type: 'reasoning',
  summary: [{ text: 'думаю' }],
  encrypted_content: secret,
})
assert(loggedReasoning.includes('думаю') && loggedReasoning.includes('скрыт'), 'reasoning text is logged')
assert(!loggedReasoning.includes(secret), 'encrypted reasoning is not logged')
assert(formatLlmItem({ role: 'user', content: 'привет' }) === 'user: привет', 'a chat message is logged')

assert(llmLogPath('../.env') === null, 'a log path cannot leave logs/')
assert(llmLogPath('notes/a.md') === null, 'a note path is not a chat log')
const logId = '33333333-3333-4333-8333-333333333333'
const logFile = llmLogPath(logId)
assert(logFile?.endsWith(`${sep}logs${sep}${logId}.log`), 'a chat log stays inside logs/')
const chatLog = createLlmLog(logId)
chatLog.line('проверка файла')
assert(logFile && readFileSync(logFile, 'utf8').includes(`[llm] проверка файла`) && readFileSync(logFile, 'utf8').includes(logId), 'a chat log is appended to its file')
if (logFile) unlinkSync(logFile)

console.log('tools ok')
