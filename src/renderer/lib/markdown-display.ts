/**
 * Models occasionally prefix prose with ideographic spaces. Unlike normal
 * whitespace, browsers render those spaces and make otherwise identical
 * paragraphs look arbitrarily indented. Preserve fenced code verbatim.
 */
function unwrapPipelineMarkdownArtifacts(content: string): string {
  if (!content.includes('## 代码生成管线：')) return content

  // Older pipeline responses wrapped generated .md files in a Markdown code
  // fence. Those files are documents, not source code, so render them normally.
  return content.replace(
    /^(#### [^\n]+\.md)\n\n```markdown\n([\s\S]*?)\n```(?=\n\n(?:#### |### )|$)/gm,
    '$1\n\n$2',
  )
}

export function normalizeChatMarkdown(content: string): string {
  const normalizedContent = unwrapPipelineMarkdownArtifacts(content)
  let activeFence: string | undefined

  return normalizedContent.split(/\r?\n/).map((line) => {
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
