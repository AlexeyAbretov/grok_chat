import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { agentBlock, answerText, apiErrorRecord, blockedStepRecord, createAgentState, finishStop, MAX_COST_TICKS, MAX_COST_TOKENS, MAX_TOOL_ROUNDS, modelStepRecord, runAgentTools } from '../server/agent.ts'
import { createLlmLog, formatLlmItem, llmLogPath, llmTracePath } from '../server/llm-log.ts'
import { chatTools, locateNote, runTool, type ToolIo } from '../server/tools/index.ts'
import { claudeToolPayload } from '../server/providers/claude.ts'
import { consumeGeminiText, geminiTextCall, geminiThoughtSignature, geminiToolCall, joinGeminiMessages } from '../server/providers/gemini.ts'
import { addUsage, consumeTurn, executeToolCalls, planToolRound } from '../server/turn.ts'
import { modelHistory } from '../shared/history.ts'

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
  listNotes: () => ['c.md', 'a.md', 'b.md'],
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

const addedNote = runTool('search_notes', { query: 'новый' }, {
  listNotes: () => ['d.md', 'a.md'],
  readFile(file) {
    if (file.endsWith(`${sep}d.md`)) return 'новый файл'
    if (file.endsWith(`${sep}a.md`)) return 'старый'
    throw new Error(`unexpected ${file}`)
  },
})
const addedPayload = JSON.parse(addedNote.output) as { matches: { file: string }[] }
assert(addedNote.ok && addedPayload.matches.length === 1 && addedPayload.matches[0].file === 'd.md', 'search includes a file that is in the folder now')

let readOutside = false
const ignored = runTool('search_notes', { query: 'x' }, {
  listNotes: () => ['../../.env', 'a.md'],
  readFile(file) {
    if (file.includes('.env')) readOutside = true
    return 'x'
  },
})
assert(ignored.ok && !readOutside, 'a listed path outside notes is not read')

const missingDir = runTool('search_notes', { query: 'x' }, {
  listNotes() {
    throw new Error('notes missing')
  },
  readFile: blockingRead,
})
assert(!missingDir.ok && missingDir.output === 'Нет файлов заметок', 'a missing notes folder is a tool error')

const described = chatTools({
  listNotes: () => ['b.md', 'd.md'],
  readFile: blockingRead,
})
const searchTool = described.find((tool) => tool.name === 'search_notes')
const readTool = described.find((tool) => tool.name === 'read_file')
if (!searchTool || !readTool) throw new Error('tool descriptions are missing')
assert(searchTool.description.includes('notes/b.md') && searchTool.description.includes('notes/d.md'), 'the tool description lists the current notes')
assert(!searchTool.description.includes('c.md'), 'the tool description omits a file that is not in the folder')
assert(readTool.description.includes('notes/d.md'), 'read_file mentions the current notes')

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
const traceFile = llmTracePath(logId)
assert(logFile?.endsWith(`${sep}logs${sep}${logId}.log`), 'a chat log stays inside logs/')
assert(traceFile?.endsWith(`${sep}logs${sep}${logId}.jsonl`), 'a step trace stays inside logs/')
assert(llmTracePath('../.env') === null, 'a step trace cannot leave logs/')
const chatLog = createLlmLog(logId)
chatLog.line('проверка файла')
chatLog.turn(1, [], null, null, { inputTokens: 1, outputTokens: 2, reasoningTokens: null, cachedTokens: null, totalTokens: 3, costTicks: 10 }, 15)
const loggedText = logFile ? readFileSync(logFile, 'utf8') : ''
assert(loggedText.includes(`[llm] проверка файла`) && loggedText.includes(logId), 'a chat log is appended to its file')
assert(loggedText.includes('стоимость 10') && loggedText.includes('латентность 15 мс'), 'cost and latency are written to the text log')
const longQuery = 'q'.repeat(500)
const longArgs = JSON.stringify({ query: longQuery })
assert(!formatLlmItem({ type: 'function_call', name: 'search_notes', arguments: longArgs }).includes(longQuery), 'the text log still clips long arguments')
const traced = createAgentState('grok-test', 'req-long')
traced.step = 1
const longRun = await runAgentTools(
  traced,
  [{ callId: '1', name: 'search_notes', arguments: longArgs }],
  () => ({ ok: true, output: longQuery }),
  33,
  { inputTokens: 4, outputTokens: 5, reasoningTokens: null, cachedTokens: null, totalTokens: 9, costTicks: 11 },
)
const longRecord = longRun.records[0]
if (!longRecord) throw new Error('a long call writes a step record')
chatLog.step(longRecord)
const traceLines = traceFile ? readFileSync(traceFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>) : []
const longRow = traceLines.find((row) => row.request_id === 'req-long')
assert(longRow?.arguments === longArgs && longRow.output === longQuery, 'a step record keeps the raw arguments and output')
assert(longRow?.latency_ms === 33 && longRow.cost_ticks === 11 && longRow.step === 1 && longRow.model === 'grok-test', 'a step record has latency, cost, step, and model')
assert(longRow?.input_tokens === 4 && longRow.total_tokens === 9, 'a step record has the turn tokens')
const plainAgent = createAgentState('grok-test', 'req-plain')
plainAgent.step = 1
chatLog.step(
  modelStepRecord(plainAgent, 15, { inputTokens: 1, outputTokens: 2, reasoningTokens: null, cachedTokens: null, totalTokens: 3, costTicks: 10 }, 'Готово', null),
)
const plainLines = traceFile ? readFileSync(traceFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>) : []
const plainRow = plainLines.find((row) => row.request_id === 'req-plain')
assert(plainRow?.tool === null && plainRow.arguments === null && plainRow.output === null, 'a round without tools still writes a step record')
assert(plainRow?.text === 'Готово', 'a plain step record keeps the answer text')
assert(plainRow?.latency_ms === 15 && plainRow.cost_ticks === 10, 'a plain step record keeps latency and cost')
if (logFile) unlinkSync(logFile)
if (traceFile && existsSync(traceFile)) unlinkSync(traceFile)

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

let searches = 0
const searchAgent = createAgentState('grok-test', 'req-search')
searchAgent.step = 1
const city = runTool('search_notes', { query: 'город' })
const firstSearch = await runAgentTools(
  searchAgent,
  [{ callId: '1', name: 'search_notes', arguments: '{"query":"город"}' }],
  () => {
    searches += 1
    return city
  },
  20,
  null,
)
const repeatSearch = await runAgentTools(
  searchAgent,
  [{ callId: '2', name: 'search_notes', arguments: '{ "query" : "город" }' }],
  () => {
    searches += 1
    return city
  },
  21,
  null,
)
assert(firstSearch.stop === null && searchAgent.calls.length === 1, 'the first search is remembered on the agent')
assert(repeatSearch.stop === 'duplicate_tool' && searches === 1 && repeatSearch.executed.length === 0, 'the same search is not run again')
const blockedCall = repeatSearch.records[0]
if (!blockedCall) throw new Error('a blocked repeat is recorded')
assert(blockedCall.request_id === 'req-search' && blockedCall.step === 1, 'a blocked repeat is recorded from the agent state')
assert(blockedCall.arguments === '{ "query" : "город" }' && blockedCall.output === null, 'a blocked repeat keeps the raw arguments and no result')

const honest = createAgentState('grok-test', 'req-honest')
honest.step = 1
const honestRun = await runAgentTools(
  honest,
  [{ callId: '1', name: 'calculator', arguments: '{"op":"add","a":2,"b":3}' }],
  (name, args) => runTool(name, args),
  4,
  null,
)
assert(honestRun.stop === null && honestRun.executed[0]?.output === '{"result":5}', 'a true calculator result continues')

let lies = 0
const liar = createAgentState('grok-test', 'req-lie')
liar.step = 2
const lied = await runAgentTools(
  liar,
  [{ callId: '1', name: 'calculator', arguments: '{"op":"add","a":2,"b":3}' }],
  () => {
    lies += 1
    return { ok: true, output: '{"result":9}' }
  },
  8,
  { inputTokens: 1, outputTokens: 1, reasoningTokens: null, cachedTokens: null, totalTokens: 2, costTicks: 3 },
)
const repeatedLie = await runAgentTools(
  liar,
  [{ callId: '3', name: 'calculator', arguments: '{"b":3,"a":2,"op":"add"}' }],
  () => {
    lies += 1
    return { ok: true, output: '{"result":9}' }
  },
  1,
  null,
)
const lieRecord = lied.records[0]
if (!lieRecord) throw new Error('a lie writes a step record')
assert(lied.stop === 'tool_mismatch' && lieRecord.output === '{"result":9}' && lieRecord.ok === true, 'a wrong calculator result stops the step')
assert(lieRecord.stop === 'tool_mismatch' && lieRecord.cost_ticks === 3 && lieRecord.latency_ms === 8, 'the lie record keeps cost and latency')
assert(repeatedLie.stop === 'duplicate_tool' && lies === 1, 'the same lying call is not run again')

const zeroAgent = createAgentState('grok-test', 'req-zero')
zeroAgent.step = 1
const zeroStop = await runAgentTools(
  zeroAgent,
  [{ callId: '1', name: 'calculator', arguments: '{"op":"div","a":1,"b":0}' }],
  (name, args) => runTool(name, args),
  1,
  null,
)
assert(zeroStop.stop === 'tool' && zeroStop.records[0]?.stop === null, 'division by zero stays a tool error')

const pairAgent = createAgentState('grok-test', 'req-pair')
pairAgent.step = 1
const pairUsage = { inputTokens: 9, outputTokens: 8, reasoningTokens: null, cachedTokens: null, totalTokens: 17, costTicks: 40 }
const paired = await runAgentTools(
  pairAgent,
  [
    { callId: '1', name: 'calculator', arguments: '{"op":"add","a":2,"b":3}' },
    { callId: '2', name: 'calculator', arguments: '{"op":"sub","a":5,"b":1}' },
  ],
  (name, args) => runTool(name, args),
  40,
  pairUsage,
  'считаю',
)
const firstBill = paired.records[0]
const secondBill = paired.records[1]
if (!firstBill || !secondBill) throw new Error('both tool calls are recorded')
assert(paired.stop === null && firstBill.output === '{"result":5}' && secondBill.output === '{"result":4}', 'two tools in one answer both run')
assert(firstBill.cost_ticks === 40 && firstBill.latency_ms === 40 && firstBill.text === 'считаю', 'the turn cost stays on the first call')
assert(secondBill.cost_ticks === null && secondBill.latency_ms === null && secondBill.input_tokens === null && secondBill.text === null, 'a second call in the same answer does not repeat the turn cost')

const fileLiar = createAgentState('grok-test', 'req-file')
fileLiar.step = 1
const fileLie = await runAgentTools(
  fileLiar,
  [{ callId: '1', name: 'read_file', arguments: '{"path":"a.md"}' }],
  () => ({ ok: true, output: '{"path":"a.md","content":"нет такого","truncated":false}' }),
  3,
  null,
)
assert(fileLie.stop === 'tool_mismatch' && fileLie.records[0]?.ok === true, 'a false file read stops the step')

const fileHonest = createAgentState('grok-test', 'req-file-ok')
fileHonest.step = 1
const fileOk = await runAgentTools(
  fileHonest,
  [{ callId: '1', name: 'read_file', arguments: '{"path":"a.md"}' }],
  (name, args) => runTool(name, args),
  3,
  null,
)
assert(fileOk.stop === null && fileOk.executed[0]?.output.includes('Калькулятор'), 'a true file read continues')

const searchLiar = createAgentState('grok-test', 'req-search-lie')
searchLiar.step = 1
const searchLie = await runAgentTools(
  searchLiar,
  [{ callId: '1', name: 'search_notes', arguments: '{"query":"Калькулятор"}' }],
  () => ({ ok: true, output: '{"matches":[],"truncated":false}' }),
  3,
  null,
)
assert(searchLie.stop === 'tool_mismatch', 'a false search result stops the step')

assert(answerText([{ type: 'message', content: [{ type: 'output_text', text: '  итог  ' }] }]) === 'итог', 'a response message keeps its text')
assert(answerText([{ role: 'assistant', content: 'Привет' }]) === 'Привет', 'a plain assistant message keeps its text')
assert(
  answerText([{ role: 'assistant', content: [{ type: 'text', text: 'да' }, { type: 'thinking', thinking: 'скрыто' }] }]) === 'да',
  'thinking is not the answer text',
)
assert(finishStop('truncated', 'max_output_tokens') === 'max_output_tokens', 'a cut answer keeps its stop reason')
assert(finishStop('truncated', '') === 'truncated', 'a cut answer without a reason still has a stop')
assert(finishStop('finish', null) === null, 'a finished answer is not a stop')

const apiError = apiErrorRecord(createAgentState('grok-test', 'req-api'), 12, null, 'Сервис недоступен')
assert(apiError.stop === 'api_error' && apiError.text === 'Сервис недоступен' && apiError.latency_ms === 12, 'an API error keeps its message and stop')
const refused = blockedStepRecord(createAgentState('grok-test', 'req-stop'), 'max_cost')
assert(refused.stop === 'max_cost' && refused.step === 1 && refused.cost_ticks === null && refused.text === null, 'a budget stop is its own step record')
const unpriced = createAgentState('grok-test', 'req-tokens')
unpriced.usage = { inputTokens: 1, outputTokens: 1, reasoningTokens: null, cachedTokens: null, totalTokens: MAX_COST_TOKENS, costTicks: null }
assert(agentBlock(unpriced) === 'max_cost', 'a provider without a price still stops on tokens')
unpriced.usage = { ...unpriced.usage, totalTokens: MAX_COST_TOKENS - 1 }
assert(agentBlock(unpriced) === null, 'token spend under the cap still continues')

const budget = createAgentState('grok-test', 'req-budget')
assert(agentBlock(budget) === null, 'a new request is under budget')
budget.usage = { inputTokens: 1, outputTokens: 1, reasoningTokens: null, cachedTokens: null, totalTokens: 2, costTicks: MAX_COST_TICKS }
assert(agentBlock(budget) === 'max_cost', 'the next model call stops at the budget')
budget.usage = { ...budget.usage, costTicks: MAX_COST_TICKS - 1 }
assert(agentBlock(budget) === null, 'spend under the budget still continues')
budget.usage = { ...budget.usage, costTicks: null }
budget.toolRounds = MAX_TOOL_ROUNDS
assert(agentBlock(budget) === 'max_tool_rounds', 'the round limit is read from the agent')

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
