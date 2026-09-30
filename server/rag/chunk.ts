// WINDOW и OVERLAP — размер окна нарезки. Chunk и Document — форматы файла и куска.
import { OVERLAP, WINDOW, type Chunk, type Document } from './types.ts'

/**
 * Читает один markdown-файл корпуса и превращает его в Document.
 * Шапка между --- хранит тип, дату, раздел и заголовок. По ним потом фильтруют поиск.
 * source — путь файла, raw — сырой текст с диска.
 */
export function parseDocument(source: string, raw: string): Document {
  // BOM — невидимый символ в начале файла из Windows. \r\n приводим к \n, чтобы шапка искалась одинаково.
  const text = raw.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n')
  // Документ корпуса обязан начинаться со строки ---. Иначе это не наш формат.
  if (!text.startsWith('---\n')) throw new Error(`Нет шапки: ${source}`)
  // Ищем закрывающую ---. Старт с 4-го символа, чтобы не попасть в открывающую шапку.
  const end = text.indexOf('\n---\n', 4)
  // Нет закрывающей --- — шапка битая, фильтровать по ней нельзя.
  if (end < 0) throw new Error(`Нет конца шапки: ${source}`)
  // Поля шапки складываем в словарь: "date" -> "2026-03-10".
  const fields = new Map<string, string>()
  // slice(4, end) — текст строго между открывающей и закрывающей ---.
  for (const line of text.slice(4, end).split('\n')) {
    // Пробелы по краям строки не часть ключа и не часть значения.
    const trimmed = line.trim()
    // Пустую строку внутри шапки пропускаем.
    if (!trimmed) continue
    // Поле отделяется первым двоеточием: "title: Гайка".
    const colon = trimmed.indexOf(':')
    // Двоеточие в начале или его нет — строка не пара «ключ: значение».
    if (colon <= 0) throw new Error(`Неверная шапка: ${source}`)
    // Слева ключ, справа значение. Пробелы вокруг двоеточия снимаем.
    fields.set(trimmed.slice(0, colon).trim(), trimmed.slice(colon + 1).trim())
  }
  // Пустая строка вместо отсутствующего поля, чтобы проверка ниже была одна.
  const type = fields.get('type') ?? ''
  const date = fields.get('date') ?? ''
  const section = fields.get('section') ?? ''
  const title = fields.get('title') ?? ''
  // Дата обязана быть ГГГГ-ММ-ДД: такие строки сравниваются по алфавиту как календарь.
  if (!type || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !section || !title) throw new Error(`Неполная шапка: ${source}`)
  // end + 5 пропускает перевод строки и закрывающие ---. trim снимает пустые строки вокруг тела.
  return { source, type, date, section, title, body: text.slice(end + 5).trim() }
}

/**
 * Режет документ на чанки для поиска.
 * Сначала по заголовкам (# ...), потом по абзацам, длинный абзац — окном с перекрытием.
 * У каждого куска один parentId на всю секцию: в промпт секция попадёт один раз.
 * options нужны тестам: они подставляют маленькое окно, чтобы стык было видно.
 */
export function chunkDocument(doc: Document, options?: { window?: number; overlap?: number }): Chunk[] {
  // Если тест не передал размер, берём обычные 480 и 80.
  const window = options?.window ?? WINDOW
  const overlap = options?.overlap ?? OVERLAP
  // Сюда сложим все куски этого файла в порядке чтения.
  const chunks: Chunk[] = []
  // sectionIndex — номер секции с нуля. Он входит в parentId.
  sectionBlocks(doc.body, doc.title).forEach((block, sectionIndex) => {
    // Один родитель на секцию: все окна этой секции потом схлопнутся в один фрагмент промпта.
    const parentId = `${doc.source}#${sectionIndex}`
    // В промпт пойдёт заголовок и тело секции, а не отдельное окно.
    const parentText = `# ${block.title}\n\n${block.body}`
    // Номер куска внутри секции. У первого окна 0, у следующего 1.
    let partIndex = 0
    // Абзац — кусок между пустыми строками. Короткий абзац не режется дальше.
    for (const paragraph of paragraphs(block.body)) {
      // Длинный абзац даёт несколько окон, короткое — одно.
      for (const piece of windows(paragraph, window, overlap)) {
        chunks.push({
          // id уникален: файл, секция и номер окна.
          id: `${parentId}.${partIndex}`,
          // Файл нужен, чтобы потом сказать «нашли corpus/docs/....md».
          source: doc.source,
          // Заголовок секции, чтобы поиск и промпт видели тему куска.
          title: block.title,
          parentId,
          // Заголовок добавляем в текст поиска: вопрос про тему секции находит и окно.
          text: `${block.title}\n${piece}`,
          parentText,
          // Поля шапки копируем на каждый чанк, фильтр работает без исходного файла.
          type: doc.type,
          date: doc.date,
          section: doc.section,
        })
        // Следующее окно той же секции получит следующий номер.
        partIndex += 1
      }
    }
  })
  return chunks
}

/**
 * Делит тело файла на секции по markdown-заголовкам # ... ######.
 * fallbackTitle — заголовок из шапки: он нужен тексту до первого #.
 */
function sectionBlocks(body: string, fallbackTitle: string) {
  // Каждая секция: свой заголовок и строки до следующего заголовка.
  const blocks: { title: string; body: string }[] = []
  // Пока своего # не было, секция называется как документ в шапке.
  let title = fallbackTitle
  // Строки текущей секции копим здесь и сбрасываем на каждом новом заголовке.
  let lines: string[] = []
  // Закрывает текущую секцию, если в ней есть непустой текст.
  const push = () => {
    const text = lines.join('\n').trim()
    // Буфер чистим до проверки: следующий заголовок начинает копить заново.
    lines = []
    // Пустую секцию (заголовок без текста) в поиск не кладём.
    if (text) blocks.push({ title, body: text })
  }
  for (const line of body.split('\n')) {
    // #{1,6} — от одного до шести решёток, дальше пробел и непустой заголовок.
    const heading = /^#{1,6}\s+(\S.*)$/.exec(line.trim())
    if (heading?.[1]) {
      // Текст до этого заголовка — предыдущая секция.
      push()
      // heading[1] — текст заголовка без решёток.
      title = heading[1].trim()
      // Сама строка заголовка в тело секции не входит: заголовок хранится отдельно.
      continue
    }
    lines.push(line)
  }
  // Последняя секция не заканчивается новым заголовком, её закрываем вручную.
  push()
  return blocks
}

/** Делит секцию на абзацы по пустой строке. Пустые куски выбрасывает. */
function paragraphs(text: string) {
  return text
    // Одна или несколько пустых строк — граница абзаца.
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    // filter(Boolean) убирает пустые строки, которые остались от лишних переносов.
    .filter(Boolean)
}

/**
 * Режет один абзац на окна фиксированной длины с шагом window - overlap.
 * Абзац короче окна возвращается как есть: дробить его не за чем.
 */
function windows(text: string, window: number, overlap: number) {
  if (text.length <= window) return [text]
  // Шаг меньше окна на величину перекрытия. Минимум 1, чтобы цикл не застрял при overlap >= window.
  const step = Math.max(1, window - overlap)
  const parts: string[] = []
  // start прыгает на step, поэтому соседние куски делят overlap символов.
  for (let start = 0; start < text.length; start += step) {
    // Последнее окно упирается в конец текста и может быть короче window.
    const end = Math.min(text.length, start + window)
    parts.push(text.slice(start, end))
    // Дошли до конца — выходим, иначе следующий start всё равно даст пустой хвост.
    if (end >= text.length) break
  }
  return parts
}
