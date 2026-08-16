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
