import React from 'react'
import { renderToPipeableStream, renderToStaticMarkup } from 'react-dom/server'
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { ExecutionDetails } from '../../src/renderer/components/chat/ExecutionDetails'
import { NativeAgentView } from '../../src/renderer/components/chat/NativeAgentView'
import { MarkdownMessageContent, MessageBubble } from '../../src/renderer/components/chat/MessageBubble'
import { ToolCallView } from '../../src/renderer/components/chat/ToolCallView'
import type { NativeAgentTranscript } from '../../src/shared/types/native-agent'
import type { ChatMessage } from '../../src/shared/types/conversation'

it.each(['eva', 'pi', 'deepseek-harness'] as const)('%s replies omit usage/timing without changing the recorded message', engine => {
  const message: ChatMessage = {
    id: 'reply', conversationId: 'chat', role: 'assistant', content: 'Original answer', timestamp: 1,
    usage: { promptTokens: 321, completionTokens: 123, estimatedCostCny: 0.12 },
    timing: { totalMs: 1234, modelDurationMs: 1000, toolExecutionMs: 234, modelCalls: [], toolCalls: [] },
    nativeAgent: engine === 'eva' ? undefined : { engine, events: [] },
  }
  const before = JSON.stringify(message)
  const html = renderToStaticMarkup(React.createElement(MessageBubble, { message, canRegenerate: true }))
  expect(html).toContain('Original answer')
  expect(html).toContain('chat-reply-actions')
  expect(html).not.toContain('conversation-metrics')
  expect(html).not.toMatch(/用量与耗时|Usage and timing|使用量と時間|总耗时|tokens|0\.12/)
  expect(JSON.stringify(message)).toBe(before)
})

// The chat parser is lazy-loaded in production. Wait for Suspense to settle
// so these assertions inspect its actual HTML rather than the text fallback.
function renderReading(props: React.ComponentProps<typeof MarkdownMessageContent>): Promise<string> {
  return new Promise((resolve, reject) => {
    let html = ''
    const destination = new Writable({
      write(chunk, _encoding, callback) { html += chunk.toString(); callback() },
      final(callback) { resolve(html); callback() },
    })
    const stream = renderToPipeableStream(React.createElement(MarkdownMessageContent, props), {
      onAllReady() { stream.pipe(destination) },
      onError(error) { reject(error) },
    })
  })
}

it.each([
  { readingStandard: true, isStreaming: false },
  { readingStandard: true, isStreaming: true },
  { markdownRenderer: 'enhanced' as const },
  { markdownRenderer: 'classic' as const },
  { markdownRenderer: 'streamdown' as const },
])('keeps numeric tilde ranges literal while preserving explicit deletion ($readingStandard/$isStreaming/$markdownRenderer)', async options => {
  const content = '范围 1~6 项尚待确认；7~8 项可以并行处理。\n\n~~明确删除~~，`a~b`。'
  const html = await renderReading({ ...options, content })
  expect(html.replace(/<[^>]+>/g, '')).toContain('1~6 项尚待确认；7~8 项可以并行处理。')
  expect(html.match(/<del[ >]/g)).toHaveLength(1)
  expect(html.match(/<del>([\s\S]*?)<\/del>/)?.[1].replace(/<[^>]+>/g, '')).toBe('明确删除')
  expect(html).toContain('a~b')
})

it.each([false, true])('keeps a single range intact while streaming=%s', async isStreaming => {
  const content = '范围 1~6 项尚待确认。'
  const html = await renderReading({ content, readingStandard: true, isStreaming })
  expect(html.replace(/<[^>]+>/g, '')).toBe(content)
  expect(html).not.toContain('<del>')
})

it('starts collapsed without discarding any original execution content', () => {
  const html = renderToStaticMarkup(React.createElement(ExecutionDetails, {
    streaming: false, toolCount: 2, errorCount: 1, unconfirmedCount: 1,
    children: React.createElement('pre', null, 'raw command and output'),
  }))
  expect(html).not.toMatch(/<details[^>]*\sopen[=>\s]/)
  expect(html).toContain('raw command and output')
  expect(html).toContain('2 tool calls')
  expect(html).toContain('1 tool errors')
  expect(html).toContain('1 unconfirmed')
  expect(html).not.toContain('animate-spin')
  expect(html).not.toContain('任务完成')
})

describe.each(['pi', 'deepseek-harness'] as const)('%s execution disclosure', engine => {
  const transcript = (payloads: Array<Record<string, unknown>>): NativeAgentTranscript => ({
    engine,
    events: payloads.map((payload, i) => ({ engine, runId: 'r', sequence: i, timestamp: i, ...payload })) as NativeAgentTranscript['events'],
  })
  const render = (native: NativeAgentTranscript, streaming = false) => renderToStaticMarkup(React.createElement(NativeAgentView, {
    transcript: native, finalContent: 'Final answer', streaming, collapsible: true,
    renderMarkdown: content => React.createElement('p', null, content),
  }))
  it('retains the original tool arguments, output and narration', () => {
    const native = transcript([
      { type: 'text_delta', messageId: 'n', content: 'Original narration' },
      { type: 'tool_start', toolCallId: 't', name: 'custom', data: { arguments: { literal: 'keep me' }, implementation: 'native' } },
      { type: 'tool_end', toolCallId: 't', content: 'Full original output', data: { isError: false } },
      { type: 'text_delta', messageId: 'final', content: 'Final answer' },
    ])
    const before = JSON.stringify(native)
    const html = render(native)
    expect(html).toContain('data-execution-details')
    expect(html).toContain('Original narration')
    expect(html).toContain('keep me')
    expect(html).toContain('Full original output')
    expect(html).not.toContain('Final answer')
    expect(JSON.stringify(native)).toBe(before)
  })
  it('omits empty process surfaces so the reply owns its single loading indicator', () => {
    const native = transcript([
      { type: 'session', data: {} },
      { type: 'text_delta', messageId: 'empty', content: '' },
      { type: 'text_delta', messageId: 'final', content: 'Final answer' },
    ])
    expect(render(native)).toBe('')
    expect(render(native, true)).toBe('')
  })
})

describe.each(['classic', 'enhanced'] as const)('%s reading surface', markdownRenderer => {
  it('renders source semantics using the standard without adding semantic labels', async () => {
    const content = '# Original heading\n\nPlain text and **original emphasis**.\n\n---\n\n> Original quote\n\n```text\noriginal code\n```'
    const html = await renderReading({
      content, preserveSource: true, readingStandard: true, markdownRenderer, outputFontSize: 'large',
    })
    expect(html).toContain('data-reading-standard="true"')
    expect(html).toContain('--reading-size:16px')
    expect(html).toMatch(/<h1[^>]*>Original heading<\/h1>/)
    expect(html).toContain('<strong>original emphasis</strong>')
    expect(html).toMatch(/<hr[^>]*\/>/)
    expect(html).toContain('Original quote')
    expect(html).toContain('original code')
    expect(html).not.toContain('重点结论')
  })
})

it('leaves non-chat Markdown presentation outside the reading standard', () => {
  const html = renderToStaticMarkup(React.createElement(MarkdownMessageContent, { content: '**Editor**' }))
  expect(html).not.toContain('data-reading-standard')
  expect(html).not.toContain('conversation-reading')
})

it('renders the declared default prose size without shrinking it through the 14px UI root', async () => {
  const html = await renderReading({ content: 'Readable prose', readingStandard: true })
  expect(html).toContain('--reading-size:15px')
})

it('renders unlabelled fenced text as block code without inline chips or an inner highlight', async () => {
  const html = await renderReading({
    content: '```\nsrc/example.ts\nsecond line\n```', readingStandard: true, preserveSource: true,
  })
  expect(html).toContain('markdown-code-block')
  expect(html).toContain('src/example.ts')
  expect(html).toContain('second line')
  expect(html).toContain('src/example.ts\nsecond line')
  expect(html).not.toContain('markdown-inline-code')
  expect(html).not.toContain('markdown-file-chip')
})

it('highlights labelled code while treating markup inside the code as literal source', async () => {
  const html = await renderReading({ content: '```js\nconst value = "<img src=x onerror=alert(1)>"\n```', readingStandard: true })
  expect(html).toContain('hljs-keyword')
  expect(html).toContain('&lt;img')
  expect(html).not.toContain('<img')
})

it('does not animate a stopped tool or treat an empty successful result as pending', () => {
  const toolCall = { id: 't', name: 'read_file', arguments: {} }
  const stopped = renderToStaticMarkup(React.createElement(ToolCallView, { toolCall, active: false }))
  expect(stopped).toContain('结果未确认')
  expect(stopped).not.toContain('animate-spin')
  const empty = renderToStaticMarkup(React.createElement(ToolCallView, { toolCall: { ...toolCall, result: '' } }))
  expect(empty).not.toContain('animate-spin')
  expect(empty).not.toContain('结果未确认')
})
