// Клиент MCP для цикла чата. Схема инструментов берётся из tools/list, вызов уходит в tools/call.
// Прямой режим не поднимает процесс: те же функции зовутся в этом процессе. Это запасной путь отладки.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { ToolResult, ToolSpec } from '../tools/types.ts'
import { MCP_PROTOCOL } from './protocol.ts'
import { mcpTools, runMcpTool } from './tools.ts'

const HANDSHAKE_MS = 15_000
const CALL_MS = 120_000

export type McpHandle = {
  /** true — функции вызваны здесь, процесс сервера не запускался. */
  direct: boolean
  /** Схемы для модели. В режиме сервера это разбор ответа tools/list, не локальная копия. */
  tools: ToolSpec[]
  names: ReadonlySet<string>
  call: (name: string, args: unknown, signal?: AbortSignal) => Promise<ToolResult>
  close: () => void
}

let opening: Promise<McpHandle> | null = null

/** Один сервер на процесс чата. Повторный вызов ждёт уже начатое подключение. */
export function sharedMcp() {
  if (!opening) {
    opening = openMcp({ direct: process.env.MCP_DIRECT === '1' }).catch((error: unknown) => {
      opening = null
      throw error
    })
  }
  return opening
}

/** Гасит дочерний процесс, если он был. Вызов до первого подключения ничего не делает. */
export function closeSharedMcp() {
  const current = opening
  opening = null
  if (!current) return
  void current.then((handle) => handle.close()).catch(() => undefined)
}

/**
 * direct=true обходит сервер. Без аргумента смотрит MCP_DIRECT, но sharedMcp передаёт флаг сам.
 * Явный direct нужен проверке: она гоняет оба пути в одном процессе.
 */
export async function openMcp(options?: { direct?: boolean }): Promise<McpHandle> {
  const direct = options?.direct ?? process.env.MCP_DIRECT === '1'
  if (direct) return directHandle()
  return spawnHandle()
}

function directHandle(): McpHandle {
  const tools = mcpTools.map(chatSpec)
  return {
    direct: true,
    tools,
    names: new Set(tools.map((tool) => tool.name)),
    call: (name, args, signal) => {
      if (signal?.aborted) return Promise.reject(new Error('Запрос отменён'))
      return runMcpTool(name, args, signal)
    },
    close: () => undefined,
  }
}

function spawnHandle(): Promise<McpHandle> {
  const script = fileURLToPath(new URL('./stdio.ts', import.meta.url))
  const execArgv = process.execArgv.filter((arg) => !arg.includes('inspect'))
  const child = spawn(process.execPath, [...execArgv, script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    cwd: process.cwd(),
    env: process.env,
  }) as ChildProcessWithoutNullStreams

  let closed = false
  let stderr = ''
  let nextId = 0
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-2_000)
  })

  const failAll = (message: string) => {
    for (const [id, waiter] of pending) {
      clearTimeout(waiter.timer)
      pending.delete(id)
      waiter.reject(new Error(message))
    }
  }

  child.on('error', (error) => {
    if (closed) return
    closed = true
    failAll(error.message)
  })

  const lines = createInterface({ input: child.stdout })
  child.on('exit', (code) => {
    if (closed) return
    closed = true
    failAll(stderr.trim() || `MCP сервер завершился с кодом ${code ?? 0}`)
    lines.close()
  })
  lines.on('line', (line) => {
    let message: unknown
    try {
      message = JSON.parse(line) as unknown
    } catch {
      failAll('MCP прислал не JSON')
      return
    }
    const record = asRecord(message)
    const id = record?.id
    if (typeof id !== 'number') return
    const waiter = pending.get(id)
    if (!waiter) return
    clearTimeout(waiter.timer)
    pending.delete(id)
    const error = asRecord(record?.error)
    if (error) {
      waiter.reject(new Error(typeof error.message === 'string' ? error.message : 'Ошибка MCP'))
      return
    }
    waiter.resolve(record?.result)
  })

  const request = (method: string, params: unknown, timeoutMs: number) =>
    new Promise<unknown>((resolve, reject) => {
      if (closed) {
        reject(new Error('MCP закрыт'))
        return
      }
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('MCP не ответил'))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })

  const close = () => {
    if (closed) return
    closed = true
    failAll('MCP закрыт')
    lines.close()
    if (child.exitCode === null) child.kill()
  }

  return handshake()

  async function handshake(): Promise<McpHandle> {
    try {
      await request(
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL,
          capabilities: {},
          clientInfo: { name: 'grok-chat', version: '0.0.0' },
        },
        HANDSHAKE_MS,
      )
      // Уведомление без id. Сервер на него не отвечает, поэтому write, а не request.
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
      const listed = toolsFromList(await request('tools/list', {}, HANDSHAKE_MS))
      return {
        direct: false,
        tools: listed,
        names: new Set(listed.map((tool) => tool.name)),
        call: (name, args, signal) => callTool(name, args, signal),
        close,
      }
    } catch (error) {
      close()
      throw error
    }
  }

  async function callTool(name: string, args: unknown, signal?: AbortSignal): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Запрос отменён')
    const result = await request('tools/call', { name, arguments: args ?? {} }, CALL_MS)
    return outputOf(result)
  }
}

function toolsFromList(result: unknown): ToolSpec[] {
  const record = asRecord(result)
  const tools = record?.tools
  if (!Array.isArray(tools) || tools.length === 0) throw new Error('MCP не отдал список инструментов')
  return tools.map((item) => {
    const tool = asRecord(item)
    const name = tool?.name
    const description = tool?.description
    const inputSchema = asRecord(tool?.inputSchema)
    const properties = asRecord(inputSchema?.properties)
    if (typeof name !== 'string' || !name) throw new Error('MCP отдал инструмент без имени')
    if (typeof description !== 'string') throw new Error('MCP отдал инструмент без описания')
    if (!inputSchema || inputSchema.type !== 'object' || !properties) throw new Error('MCP отдал инструмент без схемы')
    const required = Array.isArray(inputSchema.required) ? inputSchema.required.filter((key) => typeof key === 'string') : []
    const mapped: ToolSpec['parameters']['properties'] = {}
    for (const [key, value] of Object.entries(properties)) {
      const prop = asRecord(value)
      mapped[key] = {
        type: typeof prop?.type === 'string' ? prop.type : 'string',
        description: typeof prop?.description === 'string' ? prop.description : '',
      }
    }
    return { type: 'function', name, description, parameters: { type: 'object', required, properties: mapped } }
  })
}

function outputOf(result: unknown): ToolResult {
  const record = asRecord(result)
  if (!record) return { ok: false, output: 'Пустой ответ MCP' }
  const content = Array.isArray(record.content) ? record.content : []
  const text = content
    .map((part) => {
      const item = asRecord(part)
      return typeof item?.text === 'string' ? item.text : ''
    })
    .join('')
  if (record.isError === true) return { ok: false, output: text || 'Ошибка инструмента' }
  return { ok: true, output: text }
}

function chatSpec(tool: (typeof mcpTools)[number]): ToolSpec {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return null
}
