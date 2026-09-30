import { randomUUID } from 'node:crypto'
import { parseJsonText } from '../shared/json-schema.ts'
import type { Usage } from '../shared/protocol.ts'
import { extractOutput } from '../shared/sse.ts'
import { runTool } from './tools/index.ts'
import type { ExecutedTool, FunctionCall } from './turn.ts'

const TICKS_PER_USD = 10_000_000_000
const CALC_OPS = ['add', 'sub', 'mul', 'div'] as const

export const MAX_TOOL_ROUNDS = 5
/** $0.25 for one user message. The loop checks this before the next model call. */
export const MAX_COST_TICKS = TICKS_PER_USD / 4
/** Used when the provider does not report a price. Same stop as the dollar cap. */
export const MAX_COST_TOKENS = 200_000

export type AgentCall = {
  name: string
  arguments: string
}

export type AgentState = {
  requestId: string
  model: string
  step: number
  toolRounds: number
  calls: AgentCall[]
  usage: Usage | null
}

export type StepRecord = {
  request_id: string
  step: number
  model: string
  tool: string | null
  arguments: string | null
  output: string | null
  ok: boolean | null
  latency_ms: number | null
  input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  cost_ticks: number | null
  text: string | null
  stop: string | null
}

export type AgentToolStop = null | 'tool' | 'truncated' | 'duplicate_tool' | 'tool_mismatch'

/** Локальный инструмент возвращает результат сразу. Вызов MCP ждёт ответ процесса, поэтому функция может быть асинхронной. */
export type ToolRunner = (name: string, args: unknown) => { ok: boolean; output: string } | Promise<{ ok: boolean; output: string }>

export function createAgentState(model: string, requestId: string = randomUUID()): AgentState {
  return {
    requestId,
    model,
    step: 0,
    toolRounds: 0,
    calls: [],
    usage: null,
  }
}

export function modelStepRecord(
  agent: AgentState,
  latencyMs: number | null,
  turnUsage: Usage | null,
  text: string | null = null,
  stop: string | null = null,
): StepRecord {
  return stepRecord(agent, null, null, null, null, latencyMs, turnUsage, stop, text)
}

export function apiErrorRecord(agent: AgentState, latencyMs: number | null, turnUsage: Usage | null, message: string): StepRecord {
  return modelStepRecord(agent, latencyMs, turnUsage, message, 'api_error')
}

export function blockedStepRecord(agent: AgentState, stop: string): StepRecord {
  return stepRecord({ ...agent, step: agent.step + 1 }, null, null, null, null, null, null, stop, null)
}

export function finishStop(action: 'finish' | 'truncated' | 'tools', noticeReason: string | null): string | null {
  if (action !== 'truncated') return null
  return noticeReason || 'truncated'
}

export function answerText(output: readonly unknown[]): string | null {
  const fromMessage = extractOutput({ output: [...output] }).text
  let text = fromMessage
  for (const item of output) {
    const record = asRecord(item)
    if (!record || record.role !== 'assistant' || record.type === 'message') continue
    text += textOf(record.content)
  }
  const trimmed = text.trim()
  return trimmed || null
}

export function agentBlock(agent: AgentState): 'max_cost' | 'max_tool_rounds' | null {
  if (agent.toolRounds >= MAX_TOOL_ROUNDS) return 'max_tool_rounds'
  const cost = agent.usage?.costTicks
  if (cost != null && cost >= MAX_COST_TICKS) return 'max_cost'
  if (cost == null && (agent.usage?.totalTokens ?? 0) >= MAX_COST_TOKENS) return 'max_cost'
  return null
}

export async function runAgentTools(
  agent: AgentState,
  calls: readonly FunctionCall[],
  run: ToolRunner,
  latencyMs: number,
  turnUsage: Usage | null,
  text: string | null = null,
): Promise<{ stop: AgentToolStop; executed: ExecutedTool[]; records: StepRecord[] }> {
  const executed: ExecutedTool[] = []
  const records: StepRecord[] = []
  let charged = false
  const charge = () => {
    if (charged) return { latency: null, usage: null, text: null }
    charged = true
    return { latency: latencyMs, usage: turnUsage, text }
  }
  for (const call of calls) {
    const parsed = parseJsonText(call.arguments)
    if (!parsed.ok) {
      const billed = charge()
      records.push(stepRecord(agent, call.name, call.arguments, null, null, billed.latency, billed.usage, 'truncated', billed.text))
      return { stop: 'truncated', executed, records }
    }
    if (repeatedCall(agent, call.name, call.arguments)) {
      const billed = charge()
      records.push(stepRecord(agent, call.name, call.arguments, null, null, billed.latency, billed.usage, 'duplicate_tool', billed.text))
      return { stop: 'duplicate_tool', executed, records }
    }
    const result = await run(call.name, parsed.value)
    rememberCall(agent, call.name, call.arguments)
    executed.push({
      callId: call.callId,
      name: call.name,
      arguments: call.arguments,
      ok: result.ok,
      output: result.output,
    })
    const mismatch = result.ok && !toolAgrees(call.name, parsed.value, result.output)
    const billed = charge()
    records.push(
      stepRecord(
        agent,
        call.name,
        call.arguments,
        result.output,
        result.ok,
        billed.latency,
        billed.usage,
        mismatch ? 'tool_mismatch' : null,
        billed.text,
      ),
    )
    if (!result.ok) return { stop: 'tool', executed, records }
    if (mismatch) return { stop: 'tool_mismatch', executed, records }
  }
  return { stop: null, executed, records }
}

function repeatedCall(agent: AgentState, name: string, argsText: string) {
  const canonical = canonicalArguments(argsText)
  if (canonical === null) return false
  return agent.calls.some((call) => call.name === name && call.arguments === canonical)
}

function rememberCall(agent: AgentState, name: string, argsText: string) {
  const canonical = canonicalArguments(argsText)
  if (canonical === null) return
  agent.calls.push({ name, arguments: canonical })
}

function stepRecord(
  agent: AgentState,
  name: string | null,
  argsText: string | null,
  output: string | null,
  ok: boolean | null,
  latencyMs: number | null,
  turnUsage: Usage | null,
  stop: string | null,
  text: string | null,
): StepRecord {
  return {
    request_id: agent.requestId,
    step: agent.step,
    model: agent.model,
    tool: name,
    arguments: argsText,
    output,
    ok,
    latency_ms: latencyMs,
    input_tokens: turnUsage?.inputTokens ?? null,
    output_tokens: turnUsage?.outputTokens ?? null,
    total_tokens: turnUsage?.totalTokens ?? null,
    cost_ticks: turnUsage?.costTicks ?? null,
    text,
    stop,
  }
}

function toolAgrees(name: string, args: unknown, output: string) {
  if (name === 'calculator') return calculatorAgrees(args, output)
  if (name !== 'read_file' && name !== 'search_notes') return true
  const expected = runTool(name, args)
  if (!expected.ok) return false
  return canonicalArguments(expected.output) === canonicalArguments(output)
}

function textOf(content: unknown) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content) {
    const record = asRecord(part)
    if (!record) continue
    const type = typeof record.type === 'string' ? record.type : ''
    if (type === 'thinking' || type === 'tool_use') continue
    if (typeof record.text === 'string') text += record.text
  }
  return text
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return null
}

function canonicalArguments(text: string) {
  const parsed = parseJsonText(text)
  if (!parsed.ok) return null
  return stableStringify(parsed.value)
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function calculatorAgrees(args: unknown, output: string) {
  const expected = expectedCalculator(args)
  const actual = reportedResult(output)
  if (expected === null || actual === null) return false
  return Object.is(expected, actual)
}

function expectedCalculator(args: unknown) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  const record = args as Record<string, unknown>
  const { op, a, b } = record
  if (typeof op !== 'string' || !CALC_OPS.some((item) => item === op)) return null
  if (typeof a !== 'number' || !Number.isFinite(a)) return null
  if (typeof b !== 'number' || !Number.isFinite(b)) return null
  if (op === 'div' && b === 0) return null
  const result = op === 'add' ? a + b : op === 'sub' ? a - b : op === 'mul' ? a * b : a / b
  if (!Number.isFinite(result)) return null
  return result
}

function reportedResult(output: string) {
  const parsed = parseJsonText(output)
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return null
  const result = (parsed.value as Record<string, unknown>).result
  if (typeof result !== 'number' || !Number.isFinite(result)) return null
  return result
}
