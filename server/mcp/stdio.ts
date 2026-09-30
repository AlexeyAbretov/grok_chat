// Отдельный процесс с инструментами корпуса. Чат его порождает и говорит с ним через stdin/stdout.
// В stdout пишутся только сообщения JSON-RPC, по одному на строку. Журнал сюда нельзя: клиент примет его за протокол.
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { replyToMcpLine, type McpSession } from './protocol.ts'

async function main() {
  const session: McpSession = { initialized: false }
  const input = createInterface({ input: process.stdin })
  for await (const line of input) {
    const reply = await replyToMcpLine(line, session)
    if (reply) process.stdout.write(`${reply}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'MCP сервер остановился'
    process.stderr.write(`${message}\n`)
    process.exit(1)
  })
}
