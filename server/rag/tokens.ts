/**
 * Слова для проверки вопросов и для синонима «место».
 * Сам BM25 режет строку пакет, здесь только наши правила: --no-verify целиком, sku-4419 целиком.
 */
const TOKEN = /--[a-z0-9][a-z0-9_-]*|[a-zа-яё0-9]+(?:[_-][a-zа-яё0-9]+)*/gi

export function tokens(text: string) {
  return text.toLowerCase().match(TOKEN) ?? []
}
