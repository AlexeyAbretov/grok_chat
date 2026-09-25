import { useEffect, useRef, useState } from 'react'
import { fetchProviders, isAbortError, streamChat, type ChatTurn } from './api.ts'
import { Composer } from './components/Composer.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { Thread } from './components/Thread.tsx'
import { formatTokens, formatUsdFromTicks } from './format.ts'
import { createChat, createMessage, loadState, saveState, titleFrom } from './storage.ts'
import { EFFORTS, MAX_TOKEN_OPTIONS, type Chat, type ChatMessage, type Effort, type ProviderInfo } from './types.ts'

export function App() {
  const [initial] = useState(loadState)
  const [chats, setChats] = useState<Chat[]>(initial.chats)
  const [activeId, setActiveId] = useState(initial.activeId)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [streamingChatId, setStreamingChatId] = useState<string | null>(null)
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const active = chats.find((chat) => chat.id === activeId) ?? chats[0]

  useEffect(() => {
    saveState({ chats, activeId: active.id })
  }, [chats, active])

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
    if (providers.length === 0) return
    const known = new Set(providers.flatMap((item) => item.models))
    const fallback = providers[0]?.models[0]
    if (!fallback) return
    setChats((prev) => {
      if (prev.every((chat) => known.has(chat.model))) return prev
      return prev.map((chat) => (known.has(chat.model) ? chat : { ...chat, model: fallback }))
    })
  }, [providers])

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  function defaultModel() {
    return providers[0]?.models[0] ?? active.model
  }

  function createNewChat() {
    const chat = createChat(defaultModel())
    setChats((prev) => [chat, ...prev])
    setActiveId(chat.id)
  }

  function removeChat(id: string) {
    const target = chats.find((chat) => chat.id === id)
    if (!target) return
    if (!window.confirm(`Удалить «${target.title}»?`)) return
    if (streamingChatId === id) abortRef.current?.abort()
    const remaining = chats.filter((chat) => chat.id !== id)
    if (remaining.length === 0) {
      const fresh = createChat(defaultModel())
      setChats([fresh])
      setActiveId(fresh.id)
      return
    }
    setChats(remaining)
    if (activeId === id) setActiveId(remaining[0].id)
  }

  function patchActive(patch: Partial<Pick<Chat, 'model' | 'maxTokens' | 'reasoningEffort' | 'draft'>>) {
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
    const text = active.draft.trim()
    if (!text || streamingChatId) return

    const chatId = active.id
    const userMessage = createMessage('user', text)
    const assistantMessage = createMessage('assistant', '')
    const history: ChatTurn[] = [
      ...active.messages
        .filter((message) => message.role === 'user' || message.content.trim())
        .map((message) => ({ role: message.role, content: message.content })),
      { role: 'user', content: text },
    ]

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
      await streamChat({
        chatId,
        model: active.model,
        maxTokens: active.maxTokens,
        reasoningEffort: active.reasoningEffort,
        messages: history,
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
