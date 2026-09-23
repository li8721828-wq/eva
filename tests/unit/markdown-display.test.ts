import { describe, expect, it } from 'vitest'
import { normalizeChatMarkdown, normalizeStreamingMarkdown } from '../../src/renderer/lib/markdown-display'

describe('normalizeChatMarkdown', () => {
  it('removes leading ideographic spaces from prose', () => {
    expect(normalizeChatMarkdown('\u3000\u3000A paragraph\n\u3000- A list item')).toBe('A paragraph\n- A list item')
  })

  it('preserves ideographic spaces inside fenced code blocks', () => {
    const markdown = 'Before\n```text\n\u3000preserved\n```\n\u3000After'

    expect(normalizeChatMarkdown(markdown)).toBe('Before\n```text\n\u3000preserved\n```\nAfter')
  })

  it('keeps incomplete streaming list markers readable', () => {
    expect(normalizeStreamingMarkdown('前面的结论 **1. 出网目标未限制**\n**2. 一个坏 seed')).toBe('前面的结论\n\n**1. 出网目标未限制**\n\n2. 一个坏 seed')
  })

  it('does not alter strong markers inside fenced code while streaming', () => {
    const markdown = '说明\n```text\n**raw**\n```\n**结论**'
    expect(normalizeStreamingMarkdown(markdown)).toBe(markdown)
  })

  it('keeps inline dashes and enumerators inside their paragraph', () => {
    const markdown = '对比方案 A - B 的差异\nPython 3. 11 的变更\n见 issue # 12 的说明'
    expect(normalizeStreamingMarkdown(markdown)).toBe(markdown)
  })

  it('counts strong markers that live inside inline code as literal text', () => {
    const markdown = '使用 `**kwargs` 传参，路径是 `src/**/*.ts`'
    expect(normalizeStreamingMarkdown(markdown)).toBe(markdown)
  })

  it('still repairs the unfinished strong marker of a streaming reply', () => {
    expect(normalizeStreamingMarkdown('结论：**这一条还没写完')).toBe('结论：这一条还没写完')
  })
})
