import { afterEach, expect, it, vi } from 'vitest'
import type { Element, Root } from 'hast'
import { createInkRevealPlugin } from '../../src/renderer/lib/ink-reveal'
import { CHAT_TEXT_FADE_MS } from '../../src/renderer/lib/stream-presentation'

afterEach(() => vi.useRealTimers())
const tree = (value: string): Root => ({ type: 'root', children: [{ type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value }] }] })
const spans = (root: Root) => (root.children[0] as Element).children.filter((node): node is Element => node.type === 'element')
const style = (node: Element) => node.properties.style as string

it('preserves each unfinished fade across packets and never restarts settled ink', () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  const plugin = createInkRevealPlugin()
  const transform = plugin.rehypePlugin()
  const first = tree('甲')
  transform(first)
  expect(style(spans(first)[0])).toContain(`--sd-duration:${CHAT_TEXT_FADE_MS}ms;--sd-delay:0ms`)
  vi.advanceTimersByTime(100)
  const second = tree('甲乙')
  transform(second)
  expect(style(spans(second)[0])).toContain(`--sd-duration:${CHAT_TEXT_FADE_MS}ms;--sd-delay:-100ms`)
  expect(style(spans(second)[1])).toContain('--sd-delay:0ms')
  vi.advanceTimersByTime(CHAT_TEXT_FADE_MS)
  const third = tree('甲乙丙')
  transform(third)
  expect(spans(third).slice(0, 2).every(node => style(node).includes('--sd-duration:0ms'))).toBe(true)
  expect(style(spans(third)[2])).toContain(`--sd-duration:${CHAT_TEXT_FADE_MS}ms`)
})

it('preserves graphemes and whitespace and leaves code literal', () => {
  const root = tree('你 👩‍💻\n好')
  const code: Element = { type: 'element', tagName: 'code', properties: {}, children: [{ type: 'text', value: '<literal>\nline' }] }
  root.children.push(code)
  createInkRevealPlugin().rehypePlugin()(root)
  expect(spans(root).map(node => (node.children[0] as { value: string }).value)).toEqual(['你', '👩‍💻', '好'])
  expect((root.children[0] as Element).children.filter(node => node.type === 'text')).toEqual([{ type: 'text', value: ' ' }, { type: 'text', value: '\n' }])
  expect(code.children).toEqual([{ type: 'text', value: '<literal>\nline' }])
})

it('keeps block timelines and cached processors independent', () => {
  const first = createInkRevealPlugin(), second = createInkRevealPlugin()
  expect(first.rehypePlugin.name).not.toBe(second.rehypePlugin.name)
  first.rehypePlugin()(tree('a'.repeat(300)))
  const next = tree('new paragraph')
  second.rehypePlugin()(next)
  expect(spans(next).every(node => style(node).includes(`--sd-duration:${CHAT_TEXT_FADE_MS}ms`))).toBe(true)
})

it('does not replay already populated content on hydration', () => {
  const root = tree('旧'.repeat(300))
  createInkRevealPlugin().rehypePlugin()(root)
  expect(spans(root).every(node => style(node).includes('--sd-duration:0ms'))).toBe(true)
})
