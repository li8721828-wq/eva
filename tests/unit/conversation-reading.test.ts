import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ExecutionDetails } from '../../src/renderer/components/chat/ExecutionDetails'
import { NativeAgentView } from '../../src/renderer/components/chat/NativeAgentView'
import { MarkdownMessageContent } from '../../src/renderer/components/chat/MessageBubble'
import { ToolCallView } from '../../src/renderer/components/chat/ToolCallView'
import type { NativeAgentTranscript } from '../../src/shared/types/native-agent'

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
  it('omits an empty archived process but keeps actual live state', () => {
    const native = transcript([
      { type: 'session', data: {} },
      { type: 'text_delta', messageId: 'empty', content: '' },
      { type: 'text_delta', messageId: 'final', content: 'Final answer' },
    ])
    expect(render(native)).toBe('')
    expect(render(native, true)).toContain('animate-spin')
  })
})

describe.each(['classic', 'enhanced'] as const)('%s reading surface', markdownRenderer => {
  it('renders source semantics using the standard without adding semantic labels', () => {
    const content = '# Original heading\n\nPlain text and **original emphasis**.\n\n---\n\n> Original quote\n\n```text\noriginal code\n```'
    const html = renderToStaticMarkup(React.createElement(MarkdownMessageContent, {
      content, preserveSource: true, readingStandard: true, markdownRenderer, outputFontSize: 'large',
    }))
    expect(html).toContain('data-reading-standard="true"')
    expect(html).toContain('--reading-size:16px')
    expect(html).toContain('<h1>Original heading</h1>')
    expect(html).toContain('<strong>original emphasis</strong>')
    expect(html).toContain('<hr/>')
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

it('renders the declared default prose size without shrinking it through the 14px UI root', () => {
  const html = renderToStaticMarkup(React.createElement(MarkdownMessageContent, { content: 'Readable prose', readingStandard: true }))
  expect(html).toContain('--reading-size:15px')
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
