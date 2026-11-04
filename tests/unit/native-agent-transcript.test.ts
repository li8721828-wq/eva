import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NativeAgentView } from '../../src/renderer/components/chat/NativeAgentView'
import {
  appendNativeEvent,
  projectNativeTranscript,
} from '../../src/shared/native-agent-transcript'
import type {
  NativeAgentEvent,
  NativeAgentTranscript,
} from '../../src/shared/types/native-agent'

function events(
  engine: NativeAgentEvent['engine'],
  payloads: Array<Partial<NativeAgentEvent> & { type: string }>,
): NativeAgentTranscript {
  return {
    engine,
    events: payloads.map((payload, i) => ({
      engine,
      runId: 'r',
      sequence: i + 1,
      timestamp: i,
      ...payload,
    })),
  }
}
const render = (
  transcript: NativeAgentTranscript,
  finalContent = '',
  streaming = false,
) =>
  renderToStaticMarkup(
    React.createElement(NativeAgentView, {
      transcript,
      finalContent,
      streaming,
      renderMarkdown: (content) => React.createElement('p', null, content),
    }),
  )
describe.each(['pi', 'deepseek-harness'] as const)(
  '%s native presentation',
  (engine) => {
    it('keeps full narration, real tool output and message order', () => {
      const narration = 'Narration '.repeat(50)
      const transcript = events(engine, [
        { type: 'message_start', messageId: 'm' },
        { type: 'text_delta', messageId: 'm', content: narration },
        {
          type: 'tool_start',
          toolCallId: 't',
          name: 'read',
          data: {
            arguments:
              engine === 'pi'
                ? { path: 'native.txt' }
                : { file_path: 'native.txt' },
            implementation: 'native',
          },
        },
        {
          type: 'tool_end',
          toolCallId: 't',
          name: 'read',
          content: 'SDK formatted output',
          data: { isError: false },
        },
        { type: 'message_start', messageId: 'final' },
        { type: 'text_delta', messageId: 'final', content: 'Final answer' },
      ])
      const html = render(transcript, 'Final answer')
      expect(html).toContain(narration)
      expect(html).toContain('SDK formatted output')
      expect(html).toContain('native.txt')
      expect(html.indexOf(narration)).toBeLessThan(
        html.indexOf('data-native-tool="read"'),
      )
      expect(html).not.toContain('Final answer') // rendered separately in the answer surface
      expect(html).not.toContain('FINAL/CONTINUE')
    })
    it('keeps extensions and interrupted native operations truthful', () => {
      const html = render(
        events(engine, [
          {
            type: 'tool_start',
            toolCallId: 't',
            name: 'mcp__demo',
            data: { implementation: 'eva-extension', arguments: {} },
          },
        ]),
      )
      expect(html).toContain('Eva 扩展')
      expect(html).toContain('执行已中断，结果未确认')
      expect(html).not.toContain('animate-spin')
    })
  },
)
it('projects SDK goal and todo state without inferring completion from narration', () => {
  const transcript = events('deepseek-harness', [
    { type: 'goal', data: { phase: 'active', objective: 'Ship the change' } },
    {
      type: 'todo',
      data: { todos: [{ content: 'Verify tests', status: 'pending' }] },
    },
    { type: 'message_start', messageId: 'm' },
    { type: 'text_delta', messageId: 'm', content: 'Done.' },
  ])
  const html = render(transcript)
  expect(html).toContain('active')
  expect(html).toContain('pending')
  expect(html).toContain('Verify tests')
})
it('retains separate reused-ID attempts and message/tool namespaces', () => {
  const items = projectNativeTranscript(
    events('pi', [
      { type: 'message_start', messageId: 'same' },
      { type: 'text_delta', messageId: 'same', content: 'narration' },
      { type: 'tool_start', toolCallId: 'same', name: 'write', data: {} },
      {
        type: 'tool_end',
        toolCallId: 'same',
        content: 'first outcome',
        data: { isError: false },
      },
      { type: 'tool_start', toolCallId: 'same', name: 'write', data: {} },
      {
        type: 'tool_end',
        toolCallId: 'same',
        content: 'replay refused',
        data: { isError: true },
      },
    ]),
  )
  expect(items.map((item) => item.content)).toEqual([
    'narration',
    'first outcome',
    'replay refused',
  ])
  expect(items.map((item) => item.status)).toEqual([
    undefined,
    'completed',
    'failed',
  ])
})
it('coalesces adjacent deltas losslessly and ignores stale stream deliveries', () => {
  let publicEvents: NativeAgentEvent[] = []
  for (let i = 1; i <= 1000; i++)
    publicEvents = appendNativeEvent(publicEvents, {
      engine: 'pi',
      runId: 'r',
      sequence: i,
      timestamp: i,
      type: 'text_delta',
      messageId: 'm',
      content: '字',
    })
  expect(publicEvents).toHaveLength(1)
  expect(publicEvents[0].content).toBe('字'.repeat(1000))
  expect(appendNativeEvent(publicEvents, publicEvents[0])).toBe(publicEvents)
})
it('renders the Harness tool-owned presentation instead of inventing a generic label', () => {
  const html = render(
    events('deepseek-harness', [
      {
        type: 'tool_start',
        toolCallId: 'read',
        name: 'read',
        data: {
          arguments: { file_path: 'a.txt' },
          implementation: 'native',
          callView: { card: 'generic', title: 'Native read title' },
        },
      },
      {
        type: 'tool_end',
        toolCallId: 'read',
        content: 'raw native model feedback',
        data: {
          isError: false,
          resultView: {
            card: 'read',
            title: 'SDK read window',
            path: 'a.txt',
            offset: 41,
            lines: [{ number: 41, text: 'native line' }],
            totalLines: 100,
          },
        },
      },
    ]),
  )
  expect(html).toContain('SDK read window')
  expect(html).toContain('data-native-presentation="read"')
  expect(html).toContain('41  native line')
  expect(html).toContain('raw native model feedback')
})
