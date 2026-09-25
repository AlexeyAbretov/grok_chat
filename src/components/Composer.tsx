import type { KeyboardEvent } from 'react'

type ComposerProps = {
  draft: string
  streamingHere: boolean
  streamingElsewhere: boolean
  onDraft: (value: string) => void
  onSend: () => void
  onStop: () => void
}

export function Composer({ draft, streamingHere, streamingElsewhere, onDraft, onSend, onStop }: ComposerProps) {
  const busy = streamingHere || streamingElsewhere

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      if (!busy) onSend()
    }
  }

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault()
        if (!busy) onSend()
      }}
    >
      <textarea
        rows={3}
        placeholder="Напишите сообщение"
        value={draft}
        onChange={(event) => onDraft(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="composer-bar">
        <p>
          {streamingHere
            ? 'Идёт ответ'
            : streamingElsewhere
              ? 'Ответ генерируется в другом чате'
              : 'Enter — отправить, Shift+Enter — новая строка'}
        </p>
        {busy ? (
          <button type="button" className="stop" onClick={onStop}>
            Стоп
          </button>
        ) : (
          <button type="submit" disabled={draft.trim() === ''}>
            Отправить
          </button>
        )}
      </div>
    </form>
  )
}
