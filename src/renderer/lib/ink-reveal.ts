import type { Element, Root, RootContent, Text } from 'hast'
import { CHAT_TEXT_FADE_MS } from './stream-presentation'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const skippedTags = new Set(['pre', 'code', 'svg', 'math', 'script', 'style', 'textarea', 'button'])
let pluginSequence = 0

/** One block's ink timeline. Later packets preserve unfinished fades rather
 * than turning every previous glyph into a zero-duration animation. */
export function createInkRevealPlugin() {
  let previousText = ''
  let first = true
  let lastCount = 0
  const active = new Map<string, number>()
  const rehypePlugin = () => (tree: Root) => {
    const texts: Text[] = []
    const collect = (node: Root | RootContent) => {
      if (node.type === 'element' && skippedTags.has(node.tagName)) return
      if (node.type === 'text') texts.push(node)
      else if ('children' in node) node.children.forEach(collect)
    }
    collect(tree)
    const currentText = texts.map(node => node.value).join('')
    let stable = 0
    while (stable < previousText.length && stable < currentText.length && previousText[stable] === currentText[stable]) stable++
    // A remounted, already-populated stream is hydrated content.
    if (first && currentText.length > 256) stable = currentText.length
    const now = Date.now()
    const seen = new Set<string>()
    let offset = 0
    const transform = (node: Root | Element) => {
      if (node.type === 'element' && skippedTags.has(node.tagName)) return
      const children: RootContent[] = []
      for (const child of node.children) {
        if (child.type === 'text') {
          for (const { segment } of segmenter.segment(child.value)) {
            const key = `${offset}:${segment}`
            offset += segment.length
            if (/^\s+$/u.test(segment)) { children.push({ type: 'text', value: segment }); continue }
            seen.add(key)
            if (offset > stable && !active.has(key)) active.set(key, now)
            const started = active.get(key)
            const elapsed = started === undefined ? CHAT_TEXT_FADE_MS : Math.max(0, now - started)
            const animating = elapsed < CHAT_TEXT_FADE_MS
            if (!animating) active.delete(key)
            children.push({ type: 'element', tagName: 'span', properties: {
              'data-sd-animate': true,
              style: `--sd-animation:eva-ink-reveal;--sd-duration:${animating ? CHAT_TEXT_FADE_MS : 0}ms;--sd-delay:${animating ? -elapsed : 0}ms;--sd-easing:ease-out`,
            }, children: [{ type: 'text', value: segment }] })
          }
        } else {
          if (child.type === 'element') transform(child)
          children.push(child)
        }
      }
      node.children = children as typeof node.children
    }
    transform(tree)
    for (const key of active.keys()) if (!seen.has(key)) active.delete(key)
    previousText = currentText
    lastCount = currentText.length
    first = false
  }
  // Streamdown caches processors by plugin function name; block timelines
  // must not share the closure of another block's cached processor.
  Object.defineProperty(rehypePlugin, 'name', { value: `evaInkReveal${++pluginSequence}` })
  return {
    name: 'animate' as const, type: 'animate' as const, rehypePlugin,
    getLastRenderCharCount: () => lastCount,
    setPrevContentLength: (_length: number) => {},
  }
}
