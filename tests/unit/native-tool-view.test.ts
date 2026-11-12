import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { getToolLabel, ToolCallView } from '../../src/renderer/components/chat/ToolCallView'
import { NativeAgentView } from '../../src/renderer/components/chat/NativeAgentView'
import type { ToolCall } from '../../src/shared/types/conversation'

function render(data: Record<string, unknown>) {
  const call: ToolCall = {
    id: 'native-view',
    name: 'read',
    arguments: { file_path: 'native.txt' },
    result: 'contents',
    protocol: {
      protocolVersion: '1',
      operationId: 'native-view',
      kind: 'observation',
      status: 'observed',
      data,
    },
  }
  return renderToStaticMarkup(
    React.createElement(ToolCallView, { toolCall: call }),
  )
}

it.each([
  ['pi', 'Pi 原生'],
  ['deepseek-harness', 'Harness 原生'],
])(
  'shows the actual %s implementation and native target path',
  (engine, label) => {
    const html = render({ executionEngine: engine, nativeTool: true })
    expect(html).toContain(label)
    expect(html).toContain('native.txt')
  },
)
it('keeps Eva extensions distinct inside a native backend', () => {
  const html = render({
    executionEngine: 'pi',
    nativeTool: false,
    toolImplementation: 'eva-extension',
  })
  expect(html).toContain('Eva 扩展')
  expect(html).not.toContain('Pi 原生')
})
it('does not claim native execution from the selected engine alone', () => {
  expect(render({ executionEngine: 'pi' })).not.toContain('Pi 原生')
})

it.each([
  ['pi', 'Pi Agent'],
  ['deepseek-harness', 'DeepSeek Harness'],
] as const)('names the engine recorded for a %s session', (engine, label) => {
  const html = renderToStaticMarkup(React.createElement(NativeAgentView, {
    transcript: { engine, events: [{ engine, runId: 'run', sequence: 1, timestamp: 1, type: 'session' }] },
    streaming: false,
    finalContent: '',
    renderMarkdown: (content) => content,
  }))
  expect(html).toContain(`已创建 ${label} 会话`)
})

it.each(['execute_command', 'pwsh', 'bash'])('shows the exact %s command without changing its tool name', name => {
  const call = { id: 'command', name, arguments: { command: 'git diff --stat' }, result: '' }
  expect(getToolLabel(call)).toEqual({ title: name, detail: 'git diff --stat' })
  const html = renderToStaticMarkup(React.createElement(ToolCallView, { toolCall: call, compact: true, active: false }))
  expect(html).toContain('git diff --stat')
  expect(html).not.toContain('animate-spin')
})
