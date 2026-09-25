const USD_TICKS = 10_000_000_000

export function formatTokens(value: number) {
  return new Intl.NumberFormat('ru-RU').format(value)
}

export function formatUsdFromTicks(ticks: number) {
  const usd = ticks / USD_TICKS
  const digits = Math.abs(usd) > 0 && Math.abs(usd) < 0.01 ? 6 : 4
  const text = usd.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '')
  return `$${text}`
}

export function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}
