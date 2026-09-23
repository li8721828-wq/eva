/**
 * Models occasionally prefix prose with ideographic spaces. Unlike normal
 * whitespace, browsers render those spaces and make otherwise identical
 * paragraphs look arbitrarily indented. Preserve fenced code verbatim.
 */
export function normalizeChatMarkdown(content: string): string {
  let activeFence: string | undefined

  return content.split(/\r?\n/).map((line) => {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/)

    if (activeFence) {
      if (fence?.[1][0] === activeFence[0] && fence[1].length >= activeFence.length) {
        activeFence = undefined
      }
      return line
    }

    if (fence) {
      activeFence = fence[1]
      return line
    }

    return line.replace(/^\u3000+/, '')
  }).join('\n')
}

/**
 * Indexes of `**` pairs that are real strong markers, i.e. not part of an
 * inline code span. Models write glob paths and Python kwargs inside inline
 * code, and counting those as Markdown would strip them from the text the user
 * is reading.
 */
function strongMarkerIndexes(line: string): number[] {
  const indexes: number[] = []
  let insideInlineCode = false
  let index = 0

  while (index < line.length) {
    const character = line[index]
    if (character === '\\') {
      index += 2
      continue
    }
    if (character === '`') {
      insideInlineCode = !insideInlineCode
      index += 1
      continue
    }
    if (!insideInlineCode && character === '*' && line[index + 1] === '*') {
      indexes.push(index)
      index += 2
      continue
    }
    index += 1
  }

  return indexes
}

/** Keep partially generated replies readable before Markdown syntax closes. */
export function normalizeStreamingMarkdown(content: string): string {
  const normalized = normalizeChatMarkdown(content)
  const lines: string[] = []
  let activeFence: string | undefined

  for (const line of normalized.split('\n')) {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (activeFence) {
      lines.push(line)
      if (fence?.[1][0] === activeFence[0] && fence[1].length >= activeFence.length) activeFence = undefined
      continue
    }
    if (fence) {
      activeFence = fence[1]
      lines.push(line)
      continue
    }
    // Only a bolded enumerator is safe to treat as a list the model started
    // mid-line. Splitting on bare `- `, `1. ` or `# ` rewrote ordinary prose
    // ("对比方案 A - B 的差异", "Python 3. 11", "见 issue # 12") into broken
    // paragraphs and headings while the reply was still streaming.
    const formatted = line.replace(/\s+(?=\*\*\d+[.)]\s+)/g, '\n\n')
    if (/^\s*\*\*\d+[.)]\s+/.test(formatted) && lines.at(-1)?.trim()) lines.push('')
    lines.push(formatted)
  }

  let strongMarkers = 0
  let fence: string | undefined
  for (const line of lines) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fence) {
      if (fenceMatch?.[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = undefined
      continue
    }
    if (fenceMatch) {
      fence = fenceMatch[1]
      continue
    }
    strongMarkers += strongMarkerIndexes(line).length
  }

  if (strongMarkers % 2 === 1) {
    fence = undefined
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]
      const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)
      if (fenceMatch) {
        if (!fence) fence = fenceMatch[1]
        else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = undefined
        continue
      }
      if (fence) continue
      const markerIndex = strongMarkerIndexes(line).at(-1)
      if (markerIndex !== undefined) {
        lines[index] = `${line.slice(0, markerIndex)}${line.slice(markerIndex + 2)}`
        break
      }
    }
  }

  return lines.join('\n')
}
