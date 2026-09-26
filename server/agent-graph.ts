import type { Usage } from '../shared/protocol.ts'
import {
  agentBlock,
  answerText,
  apiErrorRecord,
  blockedStepRecord,
  createAgentState,
  finishStop,
  modelStepRecord,
  runAgentTools,
  type AgentCall,
  type StepRecord,
} from './agent.ts'
import { END, compileGraph, memoryCheckpointer, type CompiledGraph } from './graph.ts'
import type { StreamTurnResult, ToolExchange } from './providers/types.ts'
import { addUsage, planToolRound, type ExecutedTool, type FunctionCall } from './turn.ts'

type PendingTurn = {
  calls: FunctionCall[]
  output: unknown[]
  usage: Usage | null
  latencyMs: number
  text: string | null
}

export type RunToolTrace = {
  name: string
  arguments: string
  ok: boolean
  output: string
}

/** One user request. The checkpointer stores this between nodes. */
export type AgentRun = {
  requestId: string
  model: string
  step: number
  toolRounds: number
  calls: AgentCall[]
  usage: Usage | null
  transcript: unknown[]
  offerTools: boolean
  noticeReason: string | null
  failed: string | null
  failureStatus: number
  streaming: boolean
  aborted: boolean
  done: boolean
  answer: string | null
  pending: PendingTurn | null
  trace: RunToolTrace[]
  records: StepRecord[]
}

export type ModelResult = {
  turn: StreamTurnResult
  latencyMs: number
  streaming: boolean
}

export type AgentDeps = {
  signal?: AbortSignal
  callModel: (state: AgentRun) => Promise<ModelResult>
  runTool: (name: string, args: unknown) => { ok: boolean; output: string }
  toolOutputs: (results: readonly ToolExchange[]) => unknown[]
  onRound?: (step: number) => void
  onTurn?: (
    round: number,
    output: unknown[],
    failed: string | null,
    incompleteReason: string | null,
    usage: Usage | null,
    latencyMs: number,
  ) => void
  onTool?: (item: ExecutedTool) => Promise<void> | void
  onStep?: (record: StepRecord) => void
  onHttpError?: (status: number, message: string) => void
  observe?: (state: AgentRun) => void
}

export function createAgentRun(model: string, requestId?: string): AgentRun {
  const agent = createAgentState(model, requestId)
  return {
    requestId: agent.requestId,
    model: agent.model,
    step: agent.step,
    toolRounds: agent.toolRounds,
    calls: agent.calls,
    usage: agent.usage,
    transcript: [],
    offerTools: true,
    noticeReason: null,
    failed: null,
    failureStatus: 502,
    streaming: false,
    aborted: false,
    done: false,
    answer: null,
    pending: null,
    trace: [],
    records: [],
  }
}

function routeAfterStop(state: AgentRun) {
  return state.done ? END : 'model'
}

function routeAfterModel(state: AgentRun) {
  return state.done ? END : 'tools'
}

function routeAfterTools(state: AgentRun) {
  return state.done ? END : 'stop'
}

/** The old loop: stop, then the model, then tools, until a step sets `done`. */
export async function runHandwrittenAgent(start: AgentRun, deps: AgentDeps): Promise<AgentRun> {
  let state = cloneRun(start)
  while (!state.done) {
    state = applyStop(state, deps)
    if (state.done) break
    state = await applyModel(state, deps)
    if (state.done) break
    state = await applyTools(state, deps)
  }
  return state
}

export function compileAgentGraph(checkpointer = memoryCheckpointer<AgentRun>()): CompiledGraph<AgentRun, AgentDeps> {
  return compileGraph({
    entry: 'stop',
    nodes: {
      stop: applyStop,
      model: applyModel,
      tools: applyTools,
    },
    edges: {
      stop: routeAfterStop,
      model: routeAfterModel,
      tools: routeAfterTools,
    },
    checkpointer,
  })
}

export const agentGraph = compileAgentGraph()

function applyStop(state: AgentRun, deps: AgentDeps): AgentRun {
  const next = cloneRun(state)
  if (deps.signal?.aborted) {
    next.aborted = true
    next.done = true
    return next
  }
  const blocked = agentBlock(next)
  if (!blocked) return next
  next.noticeReason = blocked
  next.done = true
  pushRecord(next, deps, blockedStepRecord(next, blocked))
  return next
}

async function applyModel(state: AgentRun, deps: AgentDeps): Promise<AgentRun> {
  const next = cloneRun(state)
  if (deps.signal?.aborted) {
    next.aborted = true
    next.done = true
    return next
  }
  next.step += 1
  next.pending = null
  deps.observe?.(next)
  if (next.step > 1) deps.onRound?.(next.step)

  const result = await deps.callModel(next)
  next.streaming = result.streaming || next.streaming
  if (deps.signal?.aborted) {
    next.aborted = true
    next.done = true
    return next
  }

  const turn = result.turn
  if (turn.failed && !next.streaming) {
    next.failed = turn.failed
    next.failureStatus = turn.httpStatus || 502
    next.done = true
    deps.onHttpError?.(next.failureStatus, next.failed)
    pushRecord(next, deps, apiErrorRecord(next, result.latencyMs, turn.usage, next.failed))
    return next
  }

  next.usage = addUsage(next.usage, turn.usage)
  deps.onTurn?.(next.step, turn.output, turn.failed, turn.incompleteReason, turn.usage, result.latencyMs)
  if (turn.failed) {
    next.failed = turn.failed
    next.done = true
    pushRecord(next, deps, apiErrorRecord(next, result.latencyMs, turn.usage, next.failed))
    return next
  }

  const plan = planToolRound(turn)
  const text = answerText(turn.output)
  if (text) next.answer = text
  if (!next.offerTools || plan.action !== 'tools') {
    const notice = plan.action === 'tools' ? null : plan.noticeReason
    pushRecord(next, deps, modelStepRecord(next, result.latencyMs, turn.usage, text, finishStop(plan.action, notice)))
    next.noticeReason = notice
    next.done = true
    return next
  }

  next.pending = {
    calls: turn.calls,
    output: turn.output,
    usage: turn.usage,
    latencyMs: result.latencyMs,
    text,
  }
  return next
}

async function applyTools(state: AgentRun, deps: AgentDeps): Promise<AgentRun> {
  const next = cloneRun(state)
  const pending = next.pending
  if (!pending) throw new Error('Нет вызова для инструментов')
  const tools = runAgentTools(next, pending.calls, deps.runTool, pending.latencyMs, pending.usage, pending.text)
  for (const item of tools.executed) {
    next.trace.push({ name: item.name, arguments: item.arguments, ok: item.ok, output: item.output })
  }
  deps.observe?.(next)
  for (const item of tools.executed) await deps.onTool?.(item)
  for (const record of tools.records) pushRecord(next, deps, record)
  next.pending = null
  if (tools.stop === 'truncated') {
    next.noticeReason = ''
    next.done = true
    return next
  }
  if (tools.stop === 'duplicate_tool' || tools.stop === 'tool_mismatch') {
    next.noticeReason = tools.stop
    next.done = true
    return next
  }
  next.transcript = [
    ...next.transcript,
    ...pending.output,
    ...deps.toolOutputs(tools.executed.map((item) => ({ callId: item.callId, ok: item.ok, output: item.output }))),
  ]
  if (tools.stop === 'tool') {
    next.offerTools = false
    return next
  }
  next.toolRounds += 1
  return next
}

function pushRecord(state: AgentRun, deps: AgentDeps, record: StepRecord) {
  state.records.push(record)
  deps.onStep?.(record)
}

function cloneRun(state: AgentRun): AgentRun {
  return structuredClone(state)
}
