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
})
