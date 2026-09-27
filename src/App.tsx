import { useEffect, useRef, useState } from 'react'
import { bootstrapChats, createRemoteChat, deleteRemoteChat, fetchProviders, focusChat, isAbortError, resetChatsBootstrap, settleChatWrites, streamChat } from './api.ts'
import { Composer } from './components/Composer.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { Thread } from './components/Thread.tsx'
import { formatTokens, formatUsdFromTicks } from './format.ts'
import { applyDrafts, createChat, createMessage, titleFrom, writeDraft } from './storage.ts'
import { EFFORTS, MAX_TOKEN_OPTIONS, type Chat, type ChatMessage, type Effort, type ProviderInfo } from './types.ts'

export function App() {
  const [chats, setChats] = useState<Chat[]>([])
  const [activeId, setActiveId] = useState('')
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [streamingChatId, setStreamingChatId] = useState<string | null>(null)
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const skipFocus = useRef(true)

  const active = chats.find((chat) => chat.id === activeId) ?? chats[0]

  useEffect(() => {
    let cancelled = false
    bootstrapChats()
      .then((state) => {
        if (cancelled) return
        setChats(applyDrafts(state.chats))
        setActiveId(state.activeId)
        setStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [attempt])

  useEffect(() => {
    if (status !== 'ready' || !activeId) return
    if (skipFocus.current) {
      skipFocus.current = false
      return
    }
    void focusChat(activeId).catch((error: unknown) => {
      console.error(error)
    })
  }, [status, activeId])

  useEffect(() => {
    let cancelled = false
    fetchProviders()
      .then((value) => {
        if (!cancelled) setProviders(value)
      })
      .catch(() => {
        if (!cancelled) setProviders([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (status !== 'ready' || providers.length === 0) return
    const known = new Set(providers.flatMap((item) => item.models))
    const fallback = providers[0]?.models[0]
    if (!fallback) return
    setChats((prev) => {
      if (prev.every((chat) => known.has(chat.model))) return prev
      return prev.map((chat) => (known.has(chat.model) ? chat : { ...chat, model: fallback }))
    })
  }, [providers, status])

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  function defaultModel() {
    return providers[0]?.models[0] ?? active?.model ?? ''
  }

  function createNewChat() {
    const chat = createChat(defaultModel())
    setChats((prev) => [chat, ...prev])
    setActiveId(chat.id)
    void createRemoteChat(chat).catch((error: unknown) => {
      console.error(error)
    })
  }

  function removeChat(id: string) {
    const target = chats.find((chat) => chat.id === id)
    if (!target) return
    if (!window.confirm(`Удалить «${target.title}»?`)) return
    if (streamingChatId === id) abortRef.current?.abort()
    const remaining = chats.filter((chat) => chat.id !== id)
    writeDraft(id, '')
    if (remaining.length === 0) {
      const fresh = createChat(defaultModel())
      setChats([fresh])
      setActiveId(fresh.id)
      void createRemoteChat(fresh).catch((error: unknown) => {
        console.error(error)
      })
    } else {
      setChats(remaining)
      if (activeId === id) setActiveId(remaining[0].id)
    }
    void deleteRemoteChat(id).catch((error: unknown) => {
      console.error(error)
    })
  }

  function patchActive(patch: Partial<Pick<Chat, 'model' | 'maxTokens' | 'reasoningEffort' | 'draft'>>) {
    if (!active) return
    if (typeof patch.draft === 'string') writeDraft(active.id, patch.draft)
    setChats((prev) => prev.map((chat) => (chat.id === active.id ? { ...chat, ...patch } : chat)))
  }

  function patchMessage(chatId: string, messageId: string, patch: (message: ChatMessage) => ChatMessage) {
    setChats((prev) =>
      prev.map((chat) => {
        if (chat.id !== chatId) return chat
        return {
          ...chat,
          messages: chat.messages.map((message) => (message.id === messageId ? patch(message) : message)),
        }
      }),
    )
  }

  async function send() {
    if (!active) return
    const text = active.draft.trim()
    if (!text || streamingChatId) return

    const chatId = active.id
    const model = active.model
    const maxTokens = active.maxTokens
    const reasoningEffort = active.reasoningEffort
    const userMessage = createMessage('user', text)
    const assistantMessage = createMessage('assistant', '')
    writeDraft(chatId, '')

    setChats((prev) =>
      prev.map((chat) => {
        if (chat.id !== chatId) return chat
        return {
          ...chat,
          title: chat.title === 'Новый чат' ? titleFrom(text) : chat.title,
          draft: '',
          updatedAt: Date.now(),
          messages: [...chat.messages, userMessage, assistantMessage],
        }
      }),
    )

    const controller = new AbortController()
    abortRef.current = controller
    setStreamingChatId(chatId)
    setStreamingMessageId(assistantMessage.id)

    try {
      await settleChatWrites()
      if (controller.signal.aborted) {
        patchMessage(chatId, assistantMessage.id, (message) => ({ ...message, stopped: true }))
        return
      }
      await streamChat({
        chatId,
        model,
        maxTokens,
        reasoningEffort,
        content: text,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        signal: controller.signal,
        onText: (delta) => patchMessage(chatId, assistantMessage.id, (message) => ({ ...message, content: message.content + delta })),
        onReasoning: (delta) =>
          patchMessage(chatId, assistantMessage.id, (message) => ({ ...message, reasoning: message.reasoning + delta })),
        onUsage: (usage) => patchMessage(chatId, assistantMessage.id, (message) => ({ ...message, usage })),
        onNotice: (notice) => patchMessage(chatId, assistantMessage.id, (message) => ({ ...message, notice })),
        onTool: (tool) => patchMessage(chatId, assistantMessage.id, (message) => ({ ...message, tools: [...message.tools, tool] })),
      })
    } catch (error) {
      if (isAbortError(error)) {
        patchMessage(chatId, assistantMessage.id, (message) => ({ ...message, stopped: true }))
        return
      }
      const message = error instanceof Error ? error.message : 'Не удалось получить ответ'
      patchMessage(chatId, assistantMessage.id, (current) => ({ ...current, error: message }))
    } finally {
      setStreamingChatId((current) => (current === chatId ? null : current))
      setStreamingMessageId((current) => (current === assistantMessage.id ? null : current))
    }
  }

  if (status !== 'ready' || !active) {
    return (
      <div className="boot">
        <div>
          {status === 'error' ? (
            <>
              <p>Не удалось загрузить чаты</p>
              <button
                type="button"
                onClick={() => {
                  resetChatsBootstrap()
                  setStatus('loading')
                  setAttempt((value) => value + 1)
                }}
              >
                Повторить
              </button>
            </>
          ) : (
            <p>Загрузка чатов…</p>
          )}
        </div>
      </div>
    )
  }

  const provider = findProvider(providers, active.model)
  const spent = active.messages.reduce((sum, message) => sum + (message.usage?.totalTokens ?? 0), 0)
  const spentTicks = active.messages.reduce((sum, message) => sum + (message.usage?.costTicks ?? 0), 0)
  const hasCost = active.messages.some((message) => message.usage?.costTicks != null)
  const streamingHere = streamingChatId === active.id

  return (
    <div className="app">
      <Sidebar
        chats={chats}
        activeId={active.id}
        streamingChatId={streamingChatId}
        onSelect={setActiveId}
        onCreate={createNewChat}
        onDelete={removeChat}
      />
      <main className="main">
        <header className="toolbar">
          <label>
            Модель
            <select
              value={active.model}
              onChange={(event) => patchActive({ model: event.target.value })}
            >
              {providers.every((item) => !item.models.includes(active.model)) && (
                <option value={active.model}>{active.model || '…'}</option>
              )}
              {providers.map((item) => (
                <optgroup key={item.id} label={item.label}>
                  {item.models.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label>
            Макс. токены
            <select
              value={active.maxTokens}
              title="Лимит генерации. У моделей с рассуждениями часть лимита уходит на размышления."
              onChange={(event) => patchActive({ maxTokens: Number(event.target.value) })}
            >
              {MAX_TOKEN_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {formatTokens(option)}
                </option>
              ))}
            </select>
          </label>
          {(provider?.reasoning ?? true) && (
            <label>
              Рассуждения
              <select
                value={active.reasoningEffort}
                onChange={(event) => patchActive({ reasoningEffort: event.target.value as Effort })}
              >
                {EFFORTS.map((effort) => (
                  <option key={effort.id} value={effort.id}>
                    {effort.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(spent > 0 || hasCost) && (
            <p className="spent">
              в этом чате {formatTokens(spent)}
              {hasCost && ` · ${formatUsdFromTicks(spentTicks)}`}
            </p>
          )}
        </header>
        <Thread chat={active} streamingMessageId={streamingHere ? streamingMessageId : null} />
        <Composer
          draft={active.draft}
          streamingHere={streamingHere}
          streamingElsewhere={streamingChatId !== null && !streamingHere}
          onDraft={(draft) => patchActive({ draft })}
          onSend={() => void send()}
          onStop={() => abortRef.current?.abort()}
        />
      </main>
    </div>
  )
}

function findProvider(list: readonly ProviderInfo[], model: string) {
  return list.find((item) => item.models.includes(model)) ?? null
}
