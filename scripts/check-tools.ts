import { readFileSync, unlinkSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { createLlmLog, formatLlmItem, llmLogPath } from '../server/llm-log.ts'
import { locateNote, runTool, type ToolIo } from '../server/tools.ts'
import { claudeToolPayload } from '../server/providers/claude.ts'
import { consumeGeminiText, geminiTextCall, geminiThoughtSignature, geminiToolCall, joinGeminiMessages } from '../server/providers/gemini.ts'
import { addUsage, consumeTurn, executeToolCalls, planToolRound } from '../server/turn.ts'
import { modelHistory } from '../src/api.ts'

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

const cutRound = planToolRound({
  incompleteReason: 'max_output_tokens',
  calls: [{ arguments: '{"op":"div","a":1,"b":0}' }],
})
assert(cutRound.action === 'truncated' && cutRound.noticeReason === 'max_output_tokens', 'a truncated round keeps its stop reason and does not run tools')

const brokenArgs = planToolRound({
  incompleteReason: null,
  calls: [{ arguments: '{"op":"div"' }],
})
assert(brokenArgs.action === 'truncated', 'broken tool json stops the round before execution')

const ready = planToolRound({
  incompleteReason: null,
  calls: [{ arguments: '{"op":"div","a":1,"b":0}' }],
})
assert(ready.action === 'tools', 'complete tool json is still executed')

const plain = planToolRound({ incompleteReason: null, calls: [] })
assert(plain.action === 'finish' && plain.noticeReason === null, 'a plain answer finishes the round')

let toolRuns = 0
const zeroRound = executeToolCalls(
  [
    { callId: '1', name: 'calculator', arguments: '{"op":"div","a":1,"b":0}' },
    { callId: '2', name: 'calculator', arguments: '{"op":"add","a":1,"b":1}' },
  ],
  (name, args) => {
    toolRuns += 1
    return runTool(name, args)
  },
)
assert(zeroRound.stop === 'tool' && toolRuns === 1 && zeroRound.executed[0]?.output === 'Деление на ноль', 'a tool error stops the round')

const kept = modelHistory([
  { role: 'user', content: '2 / 0' },
  { role: 'assistant', content: '', tools: [{ name: 'calculator', args: '{"op":"div","a":2,"b":0}', ok: false, output: 'Деление на ноль' }] },
  { role: 'user', content: 'привет' },
])
assert(
  kept.length === 3 && kept[1]?.role === 'assistant' && kept[1].content.includes('Деление на ноль'),
  'a failed tool stays in the next prompt',
)
assert(modelHistory([{ role: 'assistant', content: '   ', tools: [] }]).length === 0, 'an empty assistant turn is omitted')

const cutPayload = claudeToolPayload('{"op":"div"')
assert(cutPayload.arguments === '{"op":"div"' && typeof cutPayload.input === 'string', 'truncated Claude tool json is not replaced with {}')
const emptyPayload = claudeToolPayload('')
assert(emptyPayload.arguments === '' && emptyPayload.input === '', 'empty Claude tool json is not replaced with {}')
const spoken = { mode: 'answer' as const, pending: '' }
const first = consumeGeminiText(spoken, '<thought>дума')
const second = consumeGeminiText(spoken, 'ю</thought>4')
assert(first.thought === 'дума' && first.answer === '' && second.thought === 'ю' && second.answer === '4', 'thought tags are not answer text')

const written = geminiTextCall('<call:default_api:calculator{a:1,b:1,op:add}')
assert(written?.name === 'calculator' && written.arguments === '{"a":1,"b":1,"op":"add"}', 'a text calculator call is parsed')

const glued = joinGeminiMessages([
  { role: 'user', content: '2+2' },
  { role: 'user', content: '2+2' },
])
const gluedText = (glued[0] as { content?: string }).content
assert(glued.length === 1 && gluedText === '2+2\n2+2', 'consecutive user texts stay on separate lines')

const signature = geminiThoughtSignature({ extra_content: { google: { thought_signature: 'sig' } } })
assert(signature === 'sig', 'a gemini thought signature is read from the tool call')
const replay = geminiToolCall({ id: 'c1', name: 'calculator', arguments: '{"op":"add","a":2,"b":2}', thoughtSignature: signature })
const extra = replay.extra_content as { google?: { thought_signature?: string } } | undefined
assert(extra?.google?.thought_signature === 'sig', 'a gemini tool call is replayed with its thought signature')
const unsigned = geminiToolCall({ id: 'c2', name: 'calculator', arguments: '{}', thoughtSignature: '' })
assert(!Object.prototype.hasOwnProperty.call(unsigned, 'extra_content'), 'a gemini call without a signature stays unsigned')

const wholePayload = claudeToolPayload('{"op":"add","a":1,"b":2}')
assert(
  wholePayload.input && typeof wholePayload.input === 'object' && (wholePayload.input as { op?: string }).op === 'add',
  'complete Claude tool json is parsed',
)

console.log('tools ok')
