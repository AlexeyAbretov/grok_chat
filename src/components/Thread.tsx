import { useEffect, useRef, useState } from 'react'
import { formatTokens, formatUsdFromTicks } from '../format.ts'
import type { Chat, ChatMessage } from '../types.ts'

type ThreadProps = {
  chat: Chat
  streamingMessageId: string | null
}

export function Thread({ chat, streamingMessageId }: ThreadProps) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const last = chat.messages[chat.messages.length - 1]
  const toolTail = last?.tools.map((tool) => `${tool.name}:${tool.output.length}`).join(',') ?? ''
  const tail = `${chat.messages.length}:${last?.content.length ?? 0}:${last?.reasoning.length ?? 0}:${toolTail}`

  useEffect(() => {
    stickRef.current = true
  }, [chat.id])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  }, [tail])

  return (
    <div
      className="thread"
      ref={scrollerRef}
      onScroll={() => {
        const el = scrollerRef.current
        if (!el) return
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      }}
    >
      {chat.messages.length === 0 ? (
        <div className="empty">
          <h2>Начните разговор</h2>
          <p>История этого чата хранится на этом компьютере. Можно держать несколько диалогов рядом.</p>
          <p>В ответах есть калькулятор, чтение папки notes и поиск по a.md, b.md и c.md.</p>
        </div>
      ) : (
        chat.messages.map((message) => (
          <MessageView key={message.id} message={message} streaming={message.id === streamingMessageId} />
        ))
      )}
    </div>
  )
}

function MessageView({ message, streaming }: { message: ChatMessage; streaming: boolean }) {
  if (message.role === 'user') {
    return (
      <article className="message user">
        <div className="bubble">{message.content}</div>
      </article>
    )
  }

  const showReasoning = message.reasoning.length > 0
  const waiting = streaming && !message.reasoning && !message.content && !message.error && message.tools.length === 0
  const continuing = streaming && !message.content && !message.error && message.tools.length > 0

  return (
    <article className="message assistant">
      {waiting && <p className="thinking">Размышляет…</p>}
      {showReasoning && <Reasoning text={message.reasoning} streaming={streaming} />}
      {message.tools.length > 0 && (
        <ul className="tools">
          {message.tools.map((tool, index) => (
            <li key={`${tool.name}-${index}`} className={tool.ok ? 'tool' : 'tool failed'}>
              <b>{tool.name}</b>
              {tool.args && <code>{tool.args}</code>}
              <code>{tool.output}</code>
            </li>
          ))}
        </ul>
      )}
      {continuing && <p className="thinking">Размышляет…</p>}
      {message.content && <div className="answer">{message.content}</div>}
      {message.stopped && <p className="stopped">Остановлено</p>}
      {message.notice && <p className="notice">{message.notice}</p>}
      {message.error && <p className="error">{message.error}</p>}
      {message.usage && <UsageRow usage={message.usage} />}
    </article>
  )
}

function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const ref = useRef<HTMLPreElement>(null)
  const [open, setOpen] = useState(true)

  useEffect(() => {
    if (!streaming || !ref.current) return
    ref.current.scrollTop = ref.current.scrollHeight
  }, [text, streaming])

  return (
    <details
      className="reasoning"
      open={streaming || open}
      onToggle={(event) => {
        if (!streaming) setOpen(event.currentTarget.open)
      }}
    >
      <summary>Размышления</summary>
      <pre ref={ref}>{text}</pre>
    </details>
  )
}

function UsageRow({ usage }: { usage: NonNullable<ChatMessage['usage']> }) {
  const reasoning = usage.reasoningTokens === null ? '—' : formatTokens(usage.reasoningTokens)
  const cached = usage.cachedTokens === null ? '—' : formatTokens(usage.cachedTokens)
  const cost = usage.costTicks === null ? '—' : formatUsdFromTicks(usage.costTicks)
  return (
    <p className="usage">
      <span title="Токены запроса">вход {formatTokens(usage.inputTokens)}</span>
      <span title="Токены входа, взятые из кэша промпта">кэш {cached}</span>
      <span title="Токены рассуждений. Они могут входить в «ответ» или считаться отдельно.">рассуждения {reasoning}</span>
      <span title="Токены ответа">ответ {formatTokens(usage.outputTokens)}</span>
      <span title="Сумма токенов из ответа API">всего {formatTokens(usage.totalTokens)}</span>
      <span title="Стоимость этого запроса по данным API">стоимость {cost}</span>
    </p>
  )
}
