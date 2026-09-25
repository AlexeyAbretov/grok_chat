import type { Effort } from '../../shared/protocol.ts'
import { consumeTurn } from '../turn.ts'
import {
  TOOL_INSTRUCTIONS,
  type LlmProvider,
  type ProviderCatalogItem,
  type ProviderTurnRequest,
  type StreamTurnResult,
  type ToolExchange,
} from './types.ts'

export type ResponsesProviderConfig = ProviderCatalogItem & {
  endpoint: string
  vendor: string
  identity: string
  /** Merged into the Responses API body. Use this for vendor-only fields. */
  extraBody?: Record<string, unknown>
  /** Return null to omit reasoning. Default follows `reasoning`. */
  mapEffort?: (effort: Effort, model: string) => string | null
}

export function createResponsesProvider(config: ResponsesProviderConfig): LlmProvider {
  return {
    id: config.id,
    label: config.label,
    envVar: config.envVar,
    reasoning: config.reasoning,
    models: config.models,
    systemPrompt: `${config.identity} ${TOOL_INSTRUCTIONS}`,
    streamTurn: (request) => streamResponsesTurn(config, request),
    toolOutputs,
  }
}

function toolOutputs(results: readonly ToolExchange[]) {
  return results.map((result) => ({
    type: 'function_call_output',
    call_id: result.callId,
    output: result.ok ? result.output : JSON.stringify({ error: result.output }),
  }))
}

async function streamResponsesTurn(config: ResponsesProviderConfig, request: ProviderTurnRequest): Promise<StreamTurnResult> {
  const effort = config.mapEffort
    ? config.mapEffort(request.reasoningEffort, request.model)
    : config.reasoning
      ? request.reasoningEffort
      : null
  const upstream = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${request.apiKey}`,
    },
    body: JSON.stringify({
      model: request.model,
      input: [...request.messages, ...request.transcript],
      tools: request.tools,
      max_output_tokens: request.maxTokens,
      ...(effort ? { reasoning: { effort } } : {}),
      stream: true,
      store: false,
      ...config.extraBody,
    }),
    signal: request.signal,
  })

  if (!upstream.ok || !upstream.body) {
    const text = upstream.ok ? '' : await upstream.text()
    return emptyTurn(readableUpstreamError(config.vendor, upstream.status, text), upstream.ok ? 502 : upstream.status || 502)
  }

  request.beginStream()
  const turn = await consumeTurn(upstream.body, request.emit, request.signal)
  return { ...turn, httpStatus: 200 }
}

function emptyTurn(failed: string, httpStatus: number): StreamTurnResult {
  return { calls: [], output: [], usage: null, incompleteReason: null, failed, httpStatus }
}

function readableUpstreamError(vendor: string, status: number, text: string) {
  const trimmed = text.trim()
  if (/not available in your region/i.test(trimmed)) return `Сервис ${vendor} недоступен из этого региона.`
  try {
    const parsed: unknown = JSON.parse(trimmed)
    const record = asRecord(parsed)
    const error = record?.error
    if (typeof error === 'string' && error.trim()) return error.trim()
    const nested = asRecord(error)
    if (typeof nested?.message === 'string' && nested.message.trim()) return nested.message.trim()
    if (typeof record?.message === 'string' && record.message.trim()) return record.message.trim()
  } catch {
    // HTML and plain-text errors fall through.
  }
  const plain = trimmed
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.slice(0, 300) || `${vendor} вернул ${status}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return null
}
