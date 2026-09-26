import { randomUUID } from 'node:crypto'
import { parseJsonText } from '../shared/json-schema.ts'
import type { Usage } from '../shared/protocol.ts'
import type { ExecutedTool, FunctionCall } from './turn.ts'

const TICKS_PER_USD = 10_000_000_000
const CALC_OPS = ['add', 'sub', 'mul', 'div'] as const

export const MAX_TOOL_ROUNDS = 5
/** $0.25 for one user message. The loop checks this before the next model call. */
export const MAX_COST_TICKS = TICKS_PER_USD / 4

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
  latency_ms: number
  input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  cost_ticks: number | null
  stop: string | null
}

export type AgentToolStop = null | 'tool' | 'truncated' | 'duplicate_tool' | 'tool_mismatch'

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

export function modelStepRecord(agent: AgentState, latencyMs: number, turnUsage: Usage | null): StepRecord {
  return stepRecord(agent, null, null, null, null, latencyMs, turnUsage, null)
}

export function agentBlock(agent: AgentState): 'max_cost' | 'max_tool_rounds' | null {
  if (agent.toolRounds >= MAX_TOOL_ROUNDS) return 'max_tool_rounds'
  if (agent.usage?.costTicks != null && agent.usage.costTicks >= MAX_COST_TICKS) return 'max_cost'
  return null
}

export function runAgentTools(
  agent: AgentState,
  calls: readonly FunctionCall[],
  run: (name: string, args: unknown) => { ok: boolean; output: string },
  latencyMs: number,
  turnUsage: Usage | null,
): { stop: AgentToolStop; executed: ExecutedTool[]; records: StepRecord[] } {
  const executed: ExecutedTool[] = []
  const records: StepRecord[] = []
  for (const call of calls) {
    const parsed = parseJsonText(call.arguments)
    if (!parsed.ok) return { stop: 'truncated', executed, records }
    if (repeatedCall(agent, call.name, call.arguments)) {
      records.push(stepRecord(agent, call.name, call.arguments, null, null, latencyMs, turnUsage, 'duplicate_tool'))
      return { stop: 'duplicate_tool', executed, records }
    }
    const result = run(call.name, parsed.value)
    rememberCall(agent, call.name, call.arguments)
    executed.push({
      callId: call.callId,
      name: call.name,
      arguments: call.arguments,
      ok: result.ok,
      output: result.output,
    })
    const mismatch = result.ok && call.name === 'calculator' && !calculatorAgrees(parsed.value, result.output)
    records.push(stepRecord(agent, call.name, call.arguments, result.output, result.ok, latencyMs, turnUsage, mismatch ? 'tool_mismatch' : null))
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
  latencyMs: number,
  turnUsage: Usage | null,
  stop: string | null,
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
    stop,
  }
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
