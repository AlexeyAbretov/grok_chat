import { appendFileSync, mkdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { isChatId } from '../shared/json-schema.ts'
import type { Usage } from '../shared/protocol.ts'
import { extractOutput } from '../shared/sse.ts'
import type { StepRecord } from './agent.ts'

const CLIP = 400
const LOGS_DIR = resolve('logs')

export type LlmLog = {
  line: (text: string) => void
  items: (items: unknown[]) => void
  turn: (round: number, output: unknown[], failed: string | null, incompleteReason: string | null, usage: Usage | null, latencyMs: number) => void
  tool: (name: string, ok: boolean, output: string) => void
  step: (record: StepRecord) => void
}

export function llmLogPath(chatId: string) {
  return logFile(chatId, '.log')
}

export function llmTracePath(chatId: string) {
  return logFile(chatId, '.jsonl')
}

function logFile(chatId: string, ext: '.log' | '.jsonl') {
  if (!isChatId(chatId)) return null
  const file = join(LOGS_DIR, `${chatId}${ext}`)
  const rel = relative(LOGS_DIR, file)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return file
}

export function createLlmLog(chatId: string): LlmLog {
  const file = llmLogPath(chatId)
  if (!file) throw new Error('Недопустимый чат')
  mkdirSync(LOGS_DIR, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
  write(file, '')
  write(file, `──── ${stamp}  ${chatId}`)

  const line = (text: string) => write(file, `[llm] ${text}`)
  return {
    line,
    items(items) {
      for (const item of items) line(`  ${formatLlmItem(item)}`)
    },
    turn(round, output, failed, incompleteReason, usage, latencyMs) {
      if (failed) {
        line(`← раунд ${round} ошибка: ${failed}`)
        line(`  латентность ${latencyMs} мс`)
        return
      }
      if (output.length === 0) line(`← раунд ${round} пустой ответ`)
      for (const item of output) line(`← ${formatLlmItem(item)}`)
      if (incompleteReason !== null) line(`  обрезан: ${incompleteReason || 'без причины'}`)
      if (usage) {
        const cost = usage.costTicks === null ? '—' : String(usage.costTicks)
        line(`  токены: вход ${usage.inputTokens}, ответ ${usage.outputTokens}, всего ${usage.totalTokens}, стоимость ${cost}`)
      }
      line(`  латентность ${latencyMs} мс`)
    },
    tool(name, ok, output) {
      line(`→ tool ${name} ${ok ? clip(output) : `ошибка: ${clip(output)}`}`)
    },
    step(record) {
      const trace = llmTracePath(chatId)
      if (!trace) return
      try {
        appendFileSync(trace, `${JSON.stringify(record)}\n`, 'utf8')
      } catch (error) {
        const message = error instanceof Error ? error.message : 'не удалось записать след'
        console.error(`[llm] ${message}`)
      }
    },
  }
}

export function formatLlmItem(item: unknown) {
  const record = asRecord(item)
  if (!record) return 'неизвестный элемент'
  if (typeof record.role === 'string') {
    const content = typeof record.content === 'string' ? record.content : JSON.stringify(record.content ?? '')
    return `${record.role}: ${clip(content)}`
  }
  if (record.type === 'function_call') {
    const args = typeof record.arguments === 'string' ? record.arguments : JSON.stringify(record.arguments ?? {})
    return `function_call ${String(record.name)} ${clip(args)}`
  }
  if (record.type === 'function_call_output') {
    return `function_call_output ${String(record.call_id)} ${clip(String(record.output ?? ''))}`
  }
  const extracted = extractOutput({ output: [item] })
  if (record.type === 'reasoning') {
    const hidden = typeof record.encrypted_content === 'string' ? ' [encrypted_content скрыт]' : ''
    return `reasoning: ${clip(extracted.reasoning) || '—'}${hidden}`
  }
  if (record.type === 'message') return `message: ${clip(extracted.text)}`
  return String(record.type ?? 'item')
}

function write(file: string, line: string) {
  if (line) console.log(line)
  try {
    appendFileSync(file, `${line}\n`, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'не удалось записать журнал'
    console.error(`[llm] ${message}`)
  }
}

function clip(text: string) {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= CLIP) return flat
  return `${flat.slice(0, CLIP)}…`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return null
}
