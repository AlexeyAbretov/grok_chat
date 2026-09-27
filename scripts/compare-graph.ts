import type { StateSnapshot } from '@langchain/langgraph'
import { MAX_COST_TICKS } from '../server/agent.ts'
import { agentGraph, agentSnapshots, bindAgentDeps, createAgentRun, runHandwrittenAgent, type AgentDeps, type AgentRun, type ModelResult } from '../server/agent-graph.ts'
import { runTool } from '../server/tools.ts'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

type TaskId = 'add' | 'note' | 'zero' | 'duplicate' | 'cut' | 'budget'

const tasks: { id: TaskId; title: string }[] = [
  { id: 'add', title: '2 + 3' },
  { id: 'note', title: 'заметка a.md' },
  { id: 'zero', title: '1 / 0' },
  { id: 'duplicate', title: 'повтор поиска' },
  { id: 'cut', title: 'обрыв ответа' },
  { id: 'budget', title: 'бюджет' },
]

function depsFor(task: TaskId): AgentDeps {
  return {
    callModel: (state) => Promise.resolve(scriptedTurn(task, state)),
    runTool: (name, args) => runTool(name, args),
    toolOutputs(results) {
      return results.map((result) => ({
        type: 'function_call_output',
        call_id: result.callId,
        output: result.ok ? result.output : JSON.stringify({ error: result.output }),
      }))
    },
  }
}

function scriptedTurn(task: TaskId, state: AgentRun): ModelResult {
  if (task === 'budget') throw new Error('модель не должна вызываться')
  if (task === 'cut') {
    return turn(state, {
      text: 'обрыв',
      incompleteReason: 'max_output_tokens',
      calls: [{ name: 'calculator', arguments: '{"op":"add","a":1,"b":1}' }],
    })
  }
  if (task === 'add') {
    if (!lastOutput(state.transcript)) {
      return turn(state, { text: 'считаю', calls: [{ name: 'calculator', arguments: '{"op":"add","a":2,"b":3}' }] })
    }
    return turn(state, { text: `готово: ${lastOutput(state.transcript)}` })
  }
  if (task === 'note') {
    if (!lastOutput(state.transcript)) return turn(state, { calls: [{ name: 'read_file', arguments: '{"path":"a.md"}' }] })
    return turn(state, { text: `готово: ${lastOutput(state.transcript)}` })
  }
  if (task === 'zero') {
    if (!lastOutput(state.transcript)) return turn(state, { calls: [{ name: 'calculator', arguments: '{"op":"div","a":1,"b":0}' }] })
    return turn(state, { text: `готово: ${lastOutput(state.transcript)}` })
  }
  if (task === 'duplicate' && state.toolRounds === 0) {
    return turn(state, { text: 'ищу', calls: [{ name: 'search_notes', arguments: '{"query":"Санкт-Петербург"}' }] })
  }
  if (task === 'duplicate') return turn(state, { text: 'повтор', calls: [{ name: 'search_notes', arguments: '{"query":"Санкт-Петербург"}' }] })
  throw new Error(`неизвестная задача ${task}`)
}

function turn(
  state: AgentRun,
  reply: { text?: string; calls?: { name: string; arguments: string }[]; incompleteReason?: string | null },
): ModelResult {
  const calls = (reply.calls ?? []).map((call, index) => ({
    callId: `call_${state.step}_${index + 1}`,
    name: call.name,
    arguments: call.arguments,
  }))
  const output: unknown[] = []
  if (reply.text) output.push({ type: 'message', content: [{ type: 'output_text', text: reply.text }] })
  for (const call of calls) output.push({ type: 'function_call', call_id: call.callId, name: call.name, arguments: call.arguments })
  return {
    latencyMs: 0,
    streaming: true,
    turn: {
      calls,
      output,
      usage: null,
      incompleteReason: reply.incompleteReason ?? null,
      failed: null,
      httpStatus: 200,
    },
  }
}

function lastOutput(transcript: readonly unknown[]) {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const item = transcript[i]
    if (!item || typeof item !== 'object') continue
    const record = item as { type?: unknown; output?: unknown }
    if (record.type === 'function_call_output') return String(record.output ?? '')
  }
  return null
}

function begin(id: string, prepare?: (state: AgentRun) => void) {
  const state = createAgentRun('grok-test', id)
  prepare?.(state)
  return state
}

function outcome(state: AgentRun) {
  return {
    step: state.step,
    toolRounds: state.toolRounds,
    calls: state.calls,
    offerTools: state.offerTools,
    noticeReason: state.noticeReason,
    failed: state.failed,
    answer: state.answer,
    trace: state.trace,
    transcript: state.transcript,
    records: state.records,
  }
}

function summarize(state: AgentRun) {
  const tools = state.trace.map((item) => `${item.name} ${item.arguments} → ${clip(item.output)}`).join('; ') || '—'
  return `tools: ${tools} | answer: ${clip(state.answer ?? '—')} | stop: ${state.noticeReason ?? '—'}`
}

function clip(text: string) {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= 90) return flat
  return `${flat.slice(0, 90)}…`
}

function pathOf(history: readonly StateSnapshot[]) {
  const names: string[] = []
  for (const snap of [...history].reverse()) {
    const next = snap.next[0]
    if (!next || next === '__start__') continue
    names.push(next)
  }
  if (!history[0] || history[0].next.length === 0) names.push('end')
  return names.join(' → ')
}

function same(left: AgentRun, right: AgentRun, label: string) {
  const a = JSON.stringify(outcome(left))
  const b = JSON.stringify(outcome(right))
  assert(a === b, `${label}: цикл и граф разошлись\n  цикл ${a}\n  граф  ${b}`)
}

async function runGraph(start: AgentRun, deps: AgentDeps, threadId: string, interruptBefore?: Array<'stop' | 'model' | 'tools'>) {
  bindAgentDeps(threadId, deps)
  const result = await agentGraph.invoke(
    { run: structuredClone(start) },
    { configurable: { thread_id: threadId }, durability: 'sync', interruptBefore },
  )
  const snapshot = await agentGraph.getState({ configurable: { thread_id: threadId } })
  return { state: result.run, interrupted: snapshot.next[0] ?? null }
}

console.log('цикл и LangGraph, одни и те же ответы модели')
for (const task of tasks) {
  const start = begin(`req-${task.id}`, (state) => {
    if (task.id !== 'budget') return
    state.usage = { inputTokens: 1, outputTokens: 1, reasoningTokens: null, cachedTokens: null, totalTokens: 2, costTicks: MAX_COST_TICKS }
  })
  const deps = depsFor(task.id)
  const loop = await runHandwrittenAgent(structuredClone(start), deps)
  const ran = await runGraph(start, deps, `graph-${task.id}`)
  same(loop, ran.state, task.title)
  console.log(`  ${task.title}`)
  console.log(`    цикл  ${summarize(loop)}`)
  console.log(`    граф  ${summarize(ran.state)}`)
  console.log(`    путь  ${pathOf(await agentSnapshots(`graph-${task.id}`))}`)
}

const add = begin('req-resume-add')
const addDeps = depsFor('add')
const addLoop = await runHandwrittenAgent(structuredClone(add), addDeps)
const paused = await runGraph(add, addDeps, 'resume-add', ['tools'])
assert(paused.interrupted === 'tools', 'граф останавливается перед инструментами')
assert(paused.state.trace.length === 0, 'до возобновления инструмент не исполняется')
paused.state.calls.push({ name: 'calculator', arguments: '{"a":2,"b":3,"op":"add"}' })
paused.state.answer = 'испорчено'
bindAgentDeps('resume-add', addDeps)
const resumedResult = await agentGraph.invoke(null, { configurable: { thread_id: 'resume-add' }, durability: 'sync' })
const resumed = resumedResult.run
same(addLoop, resumed, 'возобновление 2 + 3')
const straight = await agentSnapshots('graph-add')
const continued = await agentSnapshots('resume-add')
assert(pathOf(straight) === pathOf(continued), `возобновление проходит те же узлы\n  прямо ${pathOf(straight)}\n  пауза ${pathOf(continued)}`)
console.log('  возобновление 2 + 3')
console.log(`    цикл  ${summarize(addLoop)}`)
console.log(`    граф  ${summarize(resumed)}`)
console.log(`    путь  ${pathOf(continued)}`)

const addRun = outcome(addLoop)
assert(addRun.trace.length === 1 && addRun.trace[0]?.name === 'calculator' && addRun.trace[0].output === '{"result":5}', '2 + 3 вызывает calculator')
assert(addRun.answer === 'готово: {"result":5}', '2 + 3 отвечает результатом инструмента')
assert(addRun.noticeReason === null, '2 + 3 заканчивается без стопа')

const note = outcome(await runHandwrittenAgent(begin('req-note-expect'), depsFor('note')))
assert(note.trace[0]?.name === 'read_file' && note.answer?.includes('Калькулятор'), 'заметка читается и попадает в ответ')

const zero = outcome(await runHandwrittenAgent(begin('req-zero-expect'), depsFor('zero')))
assert(zero.trace[0]?.ok === false && zero.trace[0].output === 'Деление на ноль', 'деление на ноль — ошибка инструмента')
assert(zero.offerTools === false && zero.answer?.includes('Деление на ноль'), 'после ошибки инструмент больше не предлагается')

const duplicate = outcome(await runHandwrittenAgent(begin('req-duplicate-expect'), depsFor('duplicate')))
assert(duplicate.trace.length === 1 && duplicate.noticeReason === 'duplicate_tool', 'повторный поиск не исполняется')

const cut = outcome(await runHandwrittenAgent(begin('req-cut-expect'), depsFor('cut')))
assert(cut.trace.length === 0 && cut.noticeReason === 'max_output_tokens' && cut.answer === 'обрыв', 'обрыв не запускает инструмент')

const budget = outcome(
  await runHandwrittenAgent(
    begin('req-budget-expect', (state) => {
      state.usage = { inputTokens: 1, outputTokens: 1, reasoningTokens: null, cachedTokens: null, totalTokens: 2, costTicks: MAX_COST_TICKS }
    }),
    depsFor('budget'),
  ),
)
assert(budget.trace.length === 0 && budget.step === 0 && budget.noticeReason === 'max_cost', 'бюджет останавливает запрос до модели')

console.log('совпадают')
