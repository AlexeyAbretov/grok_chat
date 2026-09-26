import { rmSync } from 'node:fs'
import { chatDbPath, closeChatDb, readChats, writeChats } from '../server/store.ts'
import type { PersistedState } from '../shared/state.ts'

process.env.CHAT_DB = 'data/store-check.sqlite'
process.env.PORT = '8791'

process.on('exit', () => {
  closeChatDb()
  rmSync('data/store-check.sqlite', { force: true })
  rmSync('data/store-check.sqlite-wal', { force: true })
  rmSync('data/store-check.sqlite-shm', { force: true })
})

const state: PersistedState = {
  chats: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Проверка',
      model: 'grok',
      maxTokens: 4096,
      reasoningEffort: 'high',
      draft: 'черновик',
      createdAt: 10,
      updatedAt: 20,
      messages: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          role: 'user',
          content: 'привет',
          reasoning: '',
          tools: [],
          usage: null,
          error: null,
          notice: null,
          stopped: false,
        },
        {
          id: '33333333-3333-4333-8333-333333333333',
          role: 'assistant',
          content: 'ответ',
          reasoning: 'думал',
          tools: [{ name: 'calc', args: '{"a":1}', ok: true, output: '1' }],
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            reasoningTokens: 3,
            cachedTokens: null,
            totalTokens: 6,
            costTicks: 4,
          },
          error: null,
          notice: 'Достигнут лимит токенов',
          stopped: false,
        },
      ],
    },
    {
      id: '44444444-4444-4444-8444-444444444444',
      title: 'Второй',
      model: '',
      maxTokens: 256,
      reasoningEffort: 'low',
      draft: '',
      createdAt: 30,
      updatedAt: 40,
      messages: [],
    },
  ],
  activeId: '44444444-4444-4444-8444-444444444444',
}

writeChats(state)
const loaded = readChats()
if (JSON.stringify(canon(loaded)) !== JSON.stringify(canon(state))) {
  console.error(JSON.stringify(loaded, null, 2))
  throw new Error('roundtrip')
}

writeChats({ chats: [state.chats[1]], activeId: state.chats[1].id })
const replaced = readChats()
if (replaced.chats.length !== 1 || replaced.chats[0]?.id !== state.chats[1].id || replaced.chats[0].messages.length !== 0) {
  throw new Error('replace')
}

closeChatDb()

function canon(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canon)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canon(item)]),
  )
}

const { startServer } = await import('../server/index.ts')
const server = await startServer()
try {
  const saved = await fetch('http://127.0.0.1:8791/api/chats', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  })
  if (!saved.ok) throw new Error(`put ${saved.status}`)
  const body: unknown = await (await fetch('http://127.0.0.1:8791/api/chats')).json()
  if (JSON.stringify(canon(body)) !== JSON.stringify(canon(state))) throw new Error('http roundtrip')

  const rejected = await fetch('http://127.0.0.1:8791/api/chats', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chats: [], activeId: '' }),
  })
  if (rejected.status !== 400) throw new Error(`empty ${rejected.status}`)
  console.log(`ok ${chatDbPath()}`)
} finally {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()))
  })
}
