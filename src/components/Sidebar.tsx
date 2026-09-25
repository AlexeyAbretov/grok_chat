import { formatTime } from '../format.ts'
import type { Chat } from '../types.ts'

type SidebarProps = {
  chats: Chat[]
  activeId: string
  streamingChatId: string | null
  apiKey: string
  hasServerKey: boolean
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
  onApiKey: (value: string) => void
}

export function Sidebar({
  chats,
  activeId,
  streamingChatId,
  apiKey,
  hasServerKey,
  onSelect,
  onCreate,
  onDelete,
  onApiKey,
}: SidebarProps) {
  const ordered = [...chats].sort((a, b) => b.updatedAt - a.updatedAt)
  const keyState = apiKey.trim() ? 'browser' : hasServerKey ? 'env' : 'missing'

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="mark" aria-hidden="true" />
        <div>
          <h1>Grok</h1>
          <p>Локальные чаты</p>
        </div>
      </div>
      <button type="button" className="new-chat" onClick={onCreate}>
        Новый чат
      </button>
      <ul className="chat-list">
        {ordered.map((chat) => {
          const preview = [...chat.messages].reverse().find((message) => message.content.trim())?.content ?? 'Пустой чат'
          return (
            <li key={chat.id}>
              <button
                type="button"
                className={chat.id === activeId ? 'chat-item active' : 'chat-item'}
                aria-current={chat.id === activeId ? 'true' : undefined}
                onClick={() => onSelect(chat.id)}
              >
                <span className="chat-title">
                  {chat.id === streamingChatId && <span className="dot" aria-hidden="true" />}
                  {chat.title}
                </span>
                <span className="chat-preview">{preview.replace(/\s+/g, ' ')}</span>
                <span className="chat-time">{formatTime(chat.updatedAt)}</span>
              </button>
              <button
                type="button"
                className="delete-chat"
                aria-label={`Удалить «${chat.title}»`}
                onClick={() => onDelete(chat.id)}
              >
                ×
              </button>
            </li>
          )
        })}
      </ul>
      <div className="key-box">
        <label htmlFor="api-key">API-ключ xAI</label>
        <input
          id="api-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="xai-…"
          value={apiKey}
          onChange={(event) => onApiKey(event.target.value)}
        />
        <p className={keyState === 'missing' ? 'key-hint warn' : 'key-hint'}>
          {keyState === 'browser' && 'Берётся ключ из этого поля. Он перекрывает .env.'}
          {keyState === 'env' && 'Поле пустое, Node-сервер берёт XAI_API_KEY из .env.'}
          {keyState === 'missing' && 'Вставьте ключ или задайте XAI_API_KEY в .env и перезапустите сервер.'}
        </p>
        <a href="https://console.x.ai" target="_blank" rel="noreferrer">
          Получить ключ
        </a>
      </div>
    </aside>
  )
}
