/** Replace unpaired UTF-16 surrogate code units before text enters storage or a request. */
export function sanitizeUnicode(value: string): string {
  let result = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] + value[index + 1]
        index += 1
      } else {
        result += '\ufffd'
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += '\ufffd'
    } else {
      result += value[index]
    }
  }
  return result
}

/** Truncate by UTF-16 units without splitting a supplementary code point. */
export function truncateUnicode(value: string, maxUnits: number): string {
  const normalized = sanitizeUnicode(value)
  if (maxUnits <= 0) return ''
  if (normalized.length <= maxUnits) return normalized
  let end = maxUnits
  if (end > 0) {
    const last = normalized.charCodeAt(end - 1)
    if (last >= 0xd800 && last <= 0xdbff) end -= 1
  }
  return normalized.slice(0, end)
}

/** Keep the tail of a string without starting inside a supplementary code point. */
export function truncateUnicodeEnd(value: string, maxUnits: number): string {
  const normalized = sanitizeUnicode(value)
  if (maxUnits <= 0) return ''
  if (normalized.length <= maxUnits) return normalized
  let start = normalized.length - maxUnits
  const first = normalized.charCodeAt(start)
  if (first >= 0xdc00 && first <= 0xdfff) start += 1
  return normalized.slice(start)
}
