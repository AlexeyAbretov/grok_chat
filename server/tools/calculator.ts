import { objectArgs, required, unexpected } from './args.ts'
import { fail, ok } from './result.ts'
import type { ToolHandler, ToolSpec } from './types.ts'

const OPS = ['add', 'sub', 'mul', 'div'] as const

export const calculator: ToolHandler = {
  name: 'calculator',
  spec,
  run,
}

function spec(): ToolSpec {
  return {
    type: 'function',
    name: 'calculator',
    description: 'Складывает, вычитает, умножает или делит два числа. Произвольные выражения не считает.',
    parameters: {
      type: 'object',
      required: ['op', 'a', 'b'],
      properties: {
        op: { type: 'string', enum: [...OPS], description: 'Операция: add, sub, mul или div' },
        a: { type: 'number', description: 'Первое число' },
        b: { type: 'number', description: 'Второе число' },
      },
    },
  }
}

function run(args: unknown) {
  const record = objectArgs(args)
  if (!record.ok) return record
  const extra = unexpected(record.value, ['op', 'a', 'b'])
  if (extra) return fail(extra)
  const missing = required(record.value, ['op', 'a', 'b'])
  if (missing) return fail(missing)

  const { op, a, b } = record.value
  if (typeof op !== 'string' || !OPS.some((item) => item === op)) return fail('Недопустимое значение «op»')
  if (typeof a !== 'number' || !Number.isFinite(a)) return fail('Неверный тип «a»')
  if (typeof b !== 'number' || !Number.isFinite(b)) return fail('Неверный тип «b»')
  if (op === 'div' && b === 0) return fail('Деление на ноль')

  const result = op === 'add' ? a + b : op === 'sub' ? a - b : op === 'mul' ? a * b : a / b
  if (!Number.isFinite(result)) return fail('Результат не конечное число')
  return ok({ result })
}
