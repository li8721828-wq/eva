const MAX_QQ_TEXT_LENGTH = 1500
const ANSI_ESCAPE = /\u001B(?:[@-_][0-?]*[ -/]*[@-~]|\[[0-?]*[ -/]*[@-~])/g

interface MarkdownNode {
  type: string
  value?: string
  url?: string
  alt?: string
  lang?: string
  ordered?: boolean
  start?: number
  checked?: boolean | null
  children?: MarkdownNode[]
}

function renderChildren(node: MarkdownNode): string {
  return (node.children || []).map(renderMarkdownNode).join('')
}

function renderMarkdownNode(node: MarkdownNode): string {
  switch (node.type) {
    case 'root':
      return renderChildren(node)
    case 'text':
    case 'inlineCode':
      return node.value || ''
    case 'paragraph':
      return `${renderChildren(node).trim()}\n\n`
    case 'heading':
      return `${renderChildren(node).trim()}\n\n`
    case 'strong':
    case 'emphasis':
    case 'delete':
      return renderChildren(node)
    case 'break':
      return '\n'
    case 'code':
      return `${node.lang ? `[${node.lang}]\n` : ''}${node.value || ''}\n\n`
    case 'blockquote': {
      const quote = renderChildren(node).trim().split('\n').map((line) => `> ${line}`).join('\n')
      return `${quote}\n\n`
    }
    case 'list': {
      return (node.children || []).map((item, index) => {
        const marker = node.ordered ? `${(node.start || 1) + index}.` : '•'
        return `${marker} ${renderMarkdownNode(item).trim()}`
      }).join('\n') + '\n\n'
    }
    case 'listItem': {
      const taskMarker = node.checked === true ? '[x] ' : node.checked === false ? '[ ] ' : ''
      return `${taskMarker}${renderChildren(node).trim()}`
    }
    case 'link': {
      const label = renderChildren(node).trim() || node.url || ''
      return node.url && label !== node.url ? `${label} (${node.url})` : label
    }
    case 'image':
      return `[Image${node.alt ? `: ${node.alt}` : ''}${node.url ? ` (${node.url})` : ''}]`
    case 'thematicBreak':
      return '---\n\n'
    case 'table':
      return (node.children || []).map((row) => renderMarkdownNode(row)).join('') + '\n'
    case 'tableRow':
      return `${(node.children || []).map((cell) => renderMarkdownNode(cell).trim()).join(' | ')}\n`
    case 'tableCell':
      return renderChildren(node)
    case 'html':
      return (node.value || '').replace(/<[^>]*>/g, '')
    default:
      return renderChildren(node) || node.value || ''
  }
}

async function markdownToPlainText(content: string): Promise<string> {
  try {
    const [{ remark }, { default: remarkGfm }] = await Promise.all([
      import('remark'),
      import('remark-gfm'),
    ])
    const tree = remark().use(remarkGfm).parse(content) as unknown as MarkdownNode
    return renderMarkdownNode(tree)
  } catch {
    return content
  }
}

/** QQ C2C accepts plain text, so render Markdown syntax as readable text first. */
export async function formatQqPlainText(content: string): Promise<string> {
  const normalized = Array.from(
    (await markdownToPlainText(content))
      .replace(/\r\n?/g, '\n')
      .replace(ANSI_ESCAPE, '')
      .replace(/\u0000/g, '')
      .replace(/\uFFFD/g, '')
      .replace(/(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/g, '')
  ).join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

  return normalized || 'Eva completed the request without a text response.'
}

/** Split on Unicode code-point boundaries so emoji and CJK characters stay intact. */
export async function splitQqPlainText(content: string, maximumLength = MAX_QQ_TEXT_LENGTH): Promise<string[]> {
  const chunks: string[] = []
  let chunk = ''

  for (const character of Array.from(await formatQqPlainText(content))) {
    if (chunk.length > 0 && chunk.length + character.length > maximumLength) {
      chunks.push(chunk)
      chunk = ''
    }
    chunk += character
  }

  if (chunk) chunks.push(chunk)
  return chunks
}
