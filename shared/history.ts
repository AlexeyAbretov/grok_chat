export type ModelTurn = {
  role: 'user' | 'assistant'
  content: string
}

type HistoryMessage = {
  role: 'user' | 'assistant'
  content: string
  tools?: readonly { name: string; args?: string; ok: boolean; output: string }[]
}

/** Prompt turns for one chat. An assistant placeholder with no text and no tools is skipped. */
export function modelHistory(messages: readonly HistoryMessage[]): ModelTurn[] {
  const turns: ModelTurn[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({ role: 'user', content: message.content })
      continue
    }
    if (message.content.trim()) {
      turns.push({ role: 'assistant', content: message.content })
      continue
    }
    const tools = message.tools ?? []
    if (tools.length === 0) continue
    turns.push({
      role: 'assistant',
      content: tools
        .map((tool) => {
          const args = tool.args ? ` ${tool.args}` : ''
          return tool.ok ? `${tool.name}${args}: ${tool.output}` : `${tool.name}${args}: ошибка: ${tool.output}`
        })
        .join('\n'),
    })
  }
  return turns
}
