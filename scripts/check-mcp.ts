// Проверка MCP без сети: схема приезжает по протоколу, поиск и чтение файла работают,
// прямой вызов функции даёт тот же текст, путь вне corpus/docs не читается.
// Запуск падает на первом несовпавшем assert. В конце печатает mcp ok.

import { openMcp } from '../server/mcp/client.ts'
import { replyToMcpLine, type McpSession } from '../server/mcp/protocol.ts'
import { locateCorpusFile, runMcpTool } from '../server/mcp/tools.ts'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

// Ключи эмбеддингов выключаем до поиска: проверка должна идти по словам и не звать API.
// Пустая строка, а не delete: дочерний процесс с --env-file не должен подставить ключ заново.
process.env.EMBED_API_KEY = ''
process.env.OPENAI_API_KEY = ''
process.env.RERANK_API_KEY = ''
process.env.COHERE_API_KEY = ''

for (const path of ['../../.env', '..\\..\\.env', 'corpus/docs/../../.env', 'corpus/docs/../secret.md', 'C:/Windows/notepad.exe']) {
  const denied = await runMcpTool('read_corpus', { path })
  assert(!denied.ok && denied.output === 'Путь вне папки corpus/docs', `path is rejected before read: ${path}`)
  assert(!locateCorpusFile(path).ok, `locateCorpusFile rejects ${path}`)
}

const missing = await runMcpTool('read_corpus', { path: 'corpus/docs/missing.md' })
assert(!missing.ok && missing.output === 'Файл не найден', 'a missing corpus file is a tool error')

const directRead = await runMcpTool('read_corpus', { path: 'corpus/docs/moscow.md' })
assert(directRead.ok && directRead.output.includes('столица') && directRead.output.includes('"path":"corpus/docs/moscow.md"'), 'direct read returns the corpus file')

const directSearch = await runMcpTool('search_corpus', { query: 'Москве-реке' })
assert(directSearch.ok && directSearch.output.includes('corpus/docs/moscow.md'), 'direct search finds the Moscow note')
assert((await runMcpTool('search_corpus', { query: '   ' })).output === 'Пустой запрос', 'a blank corpus search does not run')
assert(!(await runMcpTool('send_mail', {})).ok, 'an unknown MCP tool is rejected')

const cold: McpSession = { initialized: false }
const tooEarly = await replyToMcpLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), cold)
const earlyError = tooEarly ? (JSON.parse(tooEarly) as { error?: { message?: string } }) : null
assert(earlyError?.error?.message === 'Сначала нужен initialize', 'tools/list before initialize is refused')
assert(!cold.initialized, 'a refused list does not mark the session ready')

const session: McpSession = { initialized: false }
const initLine = await replyToMcpLine(
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'check', version: '0' } },
  }),
  session,
)
const init = initLine ? (JSON.parse(initLine) as { result?: { serverInfo?: { name?: string }; protocolVersion?: string } }) : null
assert(session.initialized && init?.result?.serverInfo?.name === 'grok-corpus' && init.result.protocolVersion === '2024-11-05', 'initialize names the server and the protocol')

const notice = await replyToMcpLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), session)
assert(notice === null, 'the initialized notification has no response')

const listLine = await replyToMcpLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), session)
const listed = listLine ? (JSON.parse(listLine) as { result?: { tools?: { name?: string; inputSchema?: { required?: string[]; properties?: Record<string, unknown> } }[] } }) : null
const tools = listed?.result?.tools ?? []
const searchSchema = tools.find((tool) => tool.name === 'search_corpus')
const readSchema = tools.find((tool) => tool.name === 'read_corpus')
assert(searchSchema?.inputSchema?.required?.[0] === 'query' && searchSchema.inputSchema.properties?.query, 'search_corpus arrives with a query schema')
assert(readSchema?.inputSchema?.required?.[0] === 'path' && readSchema.inputSchema.properties?.path, 'read_corpus arrives with a path schema')

const callLine = await replyToMcpLine(
  JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_corpus', arguments: { query: 'Москве-реке' } } }),
  session,
)
const call = callLine ? (JSON.parse(callLine) as { result?: { isError?: boolean; content?: { text?: string }[] } }) : null
assert(call?.result?.isError === false && call.result.content?.[0]?.text?.includes('corpus/docs/moscow.md'), 'tools/call search returns the passage')

const readLine = await replyToMcpLine(
  JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read_corpus', arguments: { path: 'corpus/docs/moscow.md' } } }),
  session,
)
const read = readLine ? (JSON.parse(readLine) as { result?: { isError?: boolean; content?: { text?: string }[] } }) : null
assert(read?.result?.isError === false && read.result.content?.[0]?.text === directRead.output, 'tools/call read matches the direct function')

const unknown = await replyToMcpLine(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'resources/list' }), session)
const unknownError = unknown ? (JSON.parse(unknown) as { error?: { code?: number } }) : null
assert(unknownError?.error?.code === -32601, 'an unknown method is a JSON-RPC error')

const server = await openMcp({ direct: false })
try {
  assert(!server.direct, 'the spawned client is not the direct bypass')
  const names = server.tools.map((tool) => tool.name).sort()
  assert(names.join() === 'read_corpus,search_corpus', 'the process lists both tools')
  const queryTool = server.tools.find((tool) => tool.name === 'search_corpus')
  assert(queryTool?.parameters.required[0] === 'query' && queryTool.parameters.properties.query?.type === 'string', 'the process schema includes query')
  const viaServer = await server.call('search_corpus', { query: 'Москве-реке' })
  assert(viaServer.ok && viaServer.output === directSearch.output, 'the process returns the same search as the direct call')
  const viaRead = await server.call('read_corpus', { path: 'corpus/docs/moscow.md' })
  assert(viaRead.ok && viaRead.output === directRead.output, 'the process returns the same file as the direct call')
  const jailed = await server.call('read_corpus', { path: 'corpus/docs/../../.env' })
  assert(!jailed.ok && jailed.output === 'Путь вне папки corpus/docs', 'the process rejects a path outside the corpus')
} finally {
  server.close()
}

const bypass = await openMcp({ direct: true })
try {
  assert(bypass.direct && bypass.tools.length === 2, 'the debug bypass still exposes both schemas')
  const same = await bypass.call('read_corpus', { path: 'moscow.md' })
  assert(same.ok && same.output === directRead.output, 'the debug bypass reads the file without a server')
} finally {
  bypass.close()
}

console.log('mcp ok')
