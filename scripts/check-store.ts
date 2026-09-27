import { rmSync } from 'node:fs'
import { beginTurn, chatDbPath, closeChatDb, readChat, readChats, updateMessage, writeChats } from '../server/store.ts'
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

const one = readChat(state.chats[0].id)
if (!one || one.messages.length !== 2 || one.messages[1]?.content !== 'ответ' || one.messages[1].tools[0]?.name !== 'calc') {
  throw new Error('readChat')
}
if (readChat('55555555-5555-4555-8555-555555555555')) throw new Error('missing chat')

const started = beginTurn({
  chatId: state.chats[0].id,
  content: 'ещё вопрос',
  userMessageId: '55555555-5555-4555-8555-555555555555',
  assistantMessageId: '66666666-6666-4666-8666-666666666666',
  model: 'grok',
  maxTokens: 1024,
  reasoningEffort: 'medium',
})
if (!started.ok) throw new Error('beginTurn')
const turned = readChat(state.chats[0].id)
if (!turned || turned.draft !== '' || turned.messages.length !== 4 || turned.messages[2]?.content !== 'ещё вопрос' || turned.messages[3]?.content !== '') {
  throw new Error('turn stored')
}
const assistant = turned.messages[3]
if (!assistant || !updateMessage(turned.id, { ...assistant, content: 'ответ 2', stopped: true })) throw new Error('updateMessage')
const savedTurn = readChat(turned.id)
if (savedTurn?.messages[3]?.content !== 'ответ 2' || savedTurn.messages[3]?.stopped !== true) throw new Error('assistant saved')
const again = beginTurn({
  chatId: turned.id,
  content: 'ещё',
  userMessageId: '55555555-5555-4555-8555-555555555555',
  assistantMessageId: '77777777-7777-4777-8777-777777777777',
  model: 'grok',
  maxTokens: 1024,
  reasoningEffort: 'low',
})
if (again.ok || again.reason !== 'duplicate') throw new Error('duplicate message')

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
  const replacedState = await (await fetch('http://127.0.0.1:8791/api/chats')).json()
  const before = replacedState as { chats?: { id?: string }[] }
  if (!Array.isArray(before.chats) || before.chats.length !== 1) throw new Error('http read')

  const created = await fetch('http://127.0.0.1:8791/api/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state.chats[0]),
  })
  if (!created.ok) throw new Error(`post ${created.status}`)
  const patched = await fetch(`http://127.0.0.1:8791/api/chats/${state.chats[0].id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft: 'ещё' }),
  })
  if (patched.status !== 405) throw new Error(`patch ${patched.status}`)
  const focused = await fetch('http://127.0.0.1:8791/api/active', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activeId: state.chats[0].id }),
  })
  if (!focused.ok) throw new Error(`active ${focused.status}`)
  const body: unknown = await (await fetch('http://127.0.0.1:8791/api/chats')).json()
  const loadedHttp = body as { activeId?: string; chats?: { id?: string; draft?: string }[] }
  if (loadedHttp.activeId !== state.chats[0].id || loadedHttp.chats?.[0]?.id !== state.chats[0].id || loadedHttp.chats[0]?.draft !== 'черновик') {
    throw new Error('http chat')
  }

  const rejected = await fetch('http://127.0.0.1:8791/api/chats', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  })
  if (rejected.status !== 405) throw new Error(`put ${rejected.status}`)
  console.log(`ok ${chatDbPath()}`)
} finally {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()))
  })
}
