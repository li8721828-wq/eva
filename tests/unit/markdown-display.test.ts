import { describe, expect, it } from 'vitest'
import { normalizeChatMarkdown } from '../../src/renderer/lib/markdown-display'

describe('normalizeChatMarkdown', () => {
  it('removes leading ideographic spaces from prose', () => {
    expect(normalizeChatMarkdown('\u3000\u3000A paragraph\n\u3000- A list item')).toBe('A paragraph\n- A list item')
  })

  it('preserves ideographic spaces inside fenced code blocks', () => {
    const markdown = 'Before\n```text\n\u3000preserved\n```\n\u3000After'

    expect(normalizeChatMarkdown(markdown)).toBe('Before\n```text\n\u3000preserved\n```\nAfter')
  })

  it('renders Markdown artifacts from older code-production messages as documents', () => {
    const pipelineMessage = '## 代码生成管线：已固定原始需求\n\n#### 00-source-conversation.md\n\n```markdown\n# 原始需求\n\n- 合同管理\n```\n\n### 过程文档内容\n\n#### 00-source-process.md\n\n```markdown\n# 过程文档\n```'

    expect(normalizeChatMarkdown(pipelineMessage)).toBe('## 代码生成管线：已固定原始需求\n\n#### 00-source-conversation.md\n\n# 原始需求\n\n- 合同管理\n\n### 过程文档内容\n\n#### 00-source-process.md\n\n# 过程文档')
  })
})
