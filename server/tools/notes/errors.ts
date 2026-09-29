export function readError(error: unknown) {
  const code = errorCode(error)
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'Файл не найден'
  if (code === 'EISDIR') return 'Это папка'
  return 'Не удалось прочитать файл'
}

export function errorCode(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error) return String(error.code)
  return ''
}
