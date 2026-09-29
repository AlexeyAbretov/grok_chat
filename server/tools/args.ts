import { fail } from './result.ts'

export function objectArgs(args: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; output: string } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('Неверные аргументы')
  return { ok: true, value: args as Record<string, unknown> }
}

export function unexpected(value: Record<string, unknown>, keys: readonly string[]) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) return `Лишнее поле «${key}»`
  }
  return ''
}

export function required(value: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return `Нет поля «${key}»`
  }
  return ''
}
