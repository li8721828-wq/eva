import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { groupToolActivity } from '../../src/renderer/lib/execution-activity'
import { NativeAgentView } from '../../src/renderer/components/chat/NativeAgentView'
import { MessageBubble } from '../../src/renderer/components/chat/MessageBubble'
import type { NativeAgentTranscript } from '../../src/shared/types/native-agent'
import type { ChatMessage } from '../../src/shared/types/conversation'

it('groups only adjacent tools, keeps stable batch identities and leaves input untouched', () => {
  const items = [{ id: 'intro', kind: 'message' }, { id: 'a', kind: 'tool' }, { id: 'b', kind: 'tool' }, { id: 'middle', kind: 'message' }, { id: 'c', kind: 'tool' }]
  const before = JSON.stringify(items)
  const groups = groupToolActivity(items)
  expect(groups.map(group => [group.kind, group.id])).toEqual([['item', 'intro'], ['tools', 'a'], ['item', 'middle'], ['tools', 'c']])
  expect(groups[1].kind === 'tools' && groups[1].items).toEqual(items.slice(1, 3))
  expect(groupToolActivity([...items, { id: 'd', kind: 'tool' }]).map(group => group.id)).toEqual(groups.map(group => group.id))
  expect(JSON.stringify(items)).toBe(before)
})

describe.each(['pi', 'deepseek-harness'] as const)('%s chronological activity', engine => {
  it('places public narration outside separate tool lists and keeps full feedback', () => {
    const payloads = [
      { type: 'text_delta', messageId: 'intro', content: 'First public explanation' },
      { type: 'tool_start', toolCallId: 'one', name: 'read', data: { arguments: { path: 'first.txt' }, implementation: 'native' } },
      { type: 'tool_end', toolCallId: 'one', content: 'Complete first output', data: {} },
      { type: 'text_delta', messageId: 'middle', content: 'Second public explanation' },
      { type: 'tool_start', toolCallId: 'two', name: 'pwsh', data: { arguments: { command: 'original --command' }, implementation: 'native' } },
      { type: 'tool_end', toolCallId: 'two', content: 'Complete second output', data: {} },
      { type: 'text_delta', messageId: 'final', content: 'Final answer' },
    ]
    const transcript: NativeAgentTranscript = { engine, events: payloads.map((event, i) => ({ engine, runId: 'r', sequence: i, timestamp: i, ...event })) }
    const before = JSON.stringify(transcript)
    const html = renderToStaticMarkup(React.createElement(NativeAgentView, {
      transcript, finalContent: 'Final answer', streaming: false, collapsible: true,
      renderMarkdown: content => React.createElement('p', null, content),
    }))
    expect(html.match(/data-execution-details=/g)).toHaveLength(2)
    expect(html.indexOf('First public explanation')).toBeLessThan(html.indexOf('data-execution-details'))
    expect(html).toMatch(/<\/details><div[^>]*data-native-message="r:message:middle"/)
    expect(html.indexOf('Second public explanation')).toBeLessThan(html.lastIndexOf('data-execution-details'))
    expect(html).toContain('Complete first output')
    expect(html).toContain('Complete second output')
    expect(html).toContain('original --command')
    expect(html).not.toContain('Final answer')
    expect(JSON.stringify(transcript)).toBe(before)
  })
})

it('interleaves Eva public reports and tools by timestamp without exposing private reasoning', () => {
  const message: ChatMessage = {
    id: 'eva', conversationId: 'c', role: 'assistant', content: 'Final answer', timestamp: 9,
    reasoningContent: 'Private provider reasoning',
    progressUpdates: [
      { id: 'intro', kind: 'finding', content: 'First public explanation', timestamp: 1 },
      { id: 'middle', kind: 'finding', content: 'Second public explanation', timestamp: 4 },
    ],
    executionTimeline: [
      { id: 'one', kind: 'tool', timestamp: 2, toolCall: { id: 'one', name: 'read_file', arguments: { path: 'first.txt' }, result: 'first output' } },
      { id: 'two', kind: 'tool', timestamp: 5, toolCall: { id: 'two', name: 'execute_command', arguments: { command: 'original command' }, result: '' } },
      { id: 'private', kind: 'reasoning', timestamp: 3, content: 'Private provider reasoning' },
    ],
  }
  const before = JSON.stringify(message)
  const html = renderToStaticMarkup(React.createElement(MessageBubble, { message, showActions: false }))
  expect(html.match(/data-execution-details=/g)).toHaveLength(2)
  expect(html.indexOf('First public explanation')).toBeLessThan(html.indexOf('data-execution-details'))
  expect(html.indexOf('Second public explanation')).toBeGreaterThan(html.indexOf('data-execution-details'))
  expect(html.indexOf('Second public explanation')).toBeLessThan(html.lastIndexOf('data-execution-details'))
  expect(html).not.toContain('Private provider reasoning')
  expect(html).not.toContain('animate-spin')
  expect(JSON.stringify(message)).toBe(before)
})
