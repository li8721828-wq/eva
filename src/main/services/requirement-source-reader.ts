// Import/storage bounds are independent of the per-request model context.
export const MAX_REQUIREMENT_SOURCE_CHARS = 2_000_000

export function assertRequirementSourceSize(text: string): void {
  if (text.length > MAX_REQUIREMENT_SOURCE_CHARS) {
    throw new Error(`需求正文共 ${text.length.toLocaleString('en-US')} 字符，超过单次导入的 2,000,000 字符上限。请按业务范围拆分；此限制用于本地导入，并非模型上下文上限。`)
  }
}

/** Lossless paragraph/heading-aware slices; offsets refer to the archived text. */
export function splitRequirementSource(text: string, limit: number): Array<{ text: string; start: number; end: number }> {
  if (limit < 2) throw new Error('Invalid source chunk budget')
  const chunks: Array<{ text: string; start: number; end: number }> = []
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + limit)
    if (end < text.length) {
      const paragraph = text.lastIndexOf('\n\n', end - 2)
      const line = text.lastIndexOf('\n', end - 1)
      if (paragraph > start + limit / 2) end = paragraph + 2
      else if (line > start + limit / 2) end = line + 1
      // A hard split must not divide an astral Unicode character.
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1
    }
    chunks.push({ text: text.slice(start, end), start, end })
    start = end
  }
  return chunks
}

/** Every source slice is read before any reduction; no prefix-only fallback. */
export async function readRequirementSource(
  source: string,
  budget: number,
  read: (text: string, label: string, targetChars: number) => Promise<string>,
  checkCancelled: () => void,
): Promise<string> {
  checkCancelled()
  assertRequirementSourceSize(source)
  if (source.length <= budget) return source
  const chunkBudget = Math.min(24_000, budget)
  const target = Math.min(3_000, Math.floor(chunkBudget / 4))
  const consume = async (text: string, label: string): Promise<string> => {
    checkCancelled()
    const result = await read(text, label, target)
    checkCancelled()
    if (!result.trim() || result.length > target) {
      throw new Error(`长需求分段整理未完成（${label}）：结果为空或超过 ${target} 字符，未使用不完整材料继续分析。可重试并复用已完成的读取记录。`)
    }
    return result
  }
  const chunks = splitRequirementSource(source, chunkBudget)
  const notes: string[] = []
  for (const [index, chunk] of chunks.entries()) {
    const label = `原文 ${index + 1}/${chunks.length}，字符 ${chunk.start + 1}–${chunk.end}`
    notes.push(`## ${label}\n${await consume(chunk.text, label)}`)
  }
  let merged = notes.join('\n\n')
  for (let level = 1; merged.length > budget; level += 1) {
    const groups = splitRequirementSource(merged, chunkBudget)
    const reduced: string[] = []
    for (const [index, group] of groups.entries()) {
      const label = `汇总 ${level}.${index + 1}/${groups.length}`
      reduced.push(await consume(group.text, label))
    }
    const next = reduced.join('\n\n')
    if (next.length >= merged.length) throw new Error('长需求汇总未能收敛，已保留原文与分段记录，未跳过剩余内容。')
    merged = next
  }
  return `以下为完整原文逐段读取后的工作摘要，不替代原始材料；事实和引文以存档原文为准，不得将摘要称为逐字全文。\n\n${merged}`
}
