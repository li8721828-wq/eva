import React from 'react'
import { createRoot } from 'react-dom/client'
import { MessageBubble } from '@/components/chat/MessageBubble'
import { useAppStore } from '@/stores/use-app-store'
import { useAgentStore } from '@/stores/use-agent-store'
import type { AgentConfig, AgentMarkdownRenderer } from '../../src/shared/types/agent'
import type { NativeAgentEvent } from '../../src/shared/types/native-agent'
import type { ChatMessage } from '../../src/shared/types/conversation'
import '../../src/renderer/index.css'

// Public-event fixtures only; no production preload, credentials or actual task execution.
const testWindow = window as any
testWindow.uiErrors = []
window.addEventListener('error', (event) =>
  testWindow.uiErrors.push(event.message),
)
const root = createRoot(document.getElementById('root')!)
const renderMessage = (message: ChatMessage, streaming: boolean, showActions = false) => {
  testWindow.nativeMessage = message
  root.render(
    <div className="eva-app-shell min-h-screen p-4 text-zinc-900">
      <MessageBubble
        key={message.id}
        message={message}
        isStreaming={streaming}
        showActions={showActions}
      />
    </div>,
  )
}
useAppStore.setState({ language: 'zh' })
testWindow.setNativeScenario = (
  engine: NativeAgentEvent['engine'],
  theme: string,
  streaming = false,
) => {
  document.documentElement.dataset.theme = theme
  const body = '原生 Agent 最终结果：已完成验证。'
  const raw: Array<Partial<NativeAgentEvent> & { type: string }> = [
    { type: 'session', data: { resumed: true } },
    { type: 'message_start', messageId: 'one' },
    {
      type: 'text_delta',
      messageId: 'one',
      content:
        '先读取项目文件，再执行修改和验证。原生公开说明直接显示在对话中。',
    },
    ...(engine === 'deepseek-harness'
      ? [
          {
            type: 'goal',
            data: {
              phase: streaming ? 'active' : 'complete',
              objective: '验证原生连续执行目标',
            },
          },
          {
            type: 'todo',
            data: {
              todos: [
                {
                  content: '检查文件并运行验证',
                  status: streaming ? 'in_progress' : 'completed',
                },
              ],
            },
          },
        ]
      : []),
    {
      type: 'tool_start',
      toolCallId: 'read',
      name: 'read',
      data: {
        arguments:
          engine === 'pi'
            ? { path: 'src/native-agent.ts' }
            : { file_path: 'src/native-agent.ts' },
        implementation: 'native',
      },
    },
    {
      type: streaming ? 'tool_update' : 'tool_end',
      toolCallId: 'read',
      name: 'read',
      content: Array.from(
        { length: 80 },
        (_, i) => `SDK output line ${i + 1}: 原生工具输出`,
      ).join('\n'),
      data: { isError: false },
    },
    ...(streaming ? Array.from({ length: 30 }, (_, i) => [
      { type: 'tool_start', toolCallId: `parallel-${i}`, name: 'read', data: { arguments: { path: `src/file-${i}.ts` }, implementation: 'native' } },
      { type: 'tool_end', toolCallId: `parallel-${i}`, content: `Original result ${i}`, data: { isError: false } },
    ]).flat() : []),
    ...(!streaming
      ? [
          { type: 'message_start', messageId: 'final' },
          { type: 'text_delta', messageId: 'final', content: body },
        ]
      : []),
  ]
  const message: ChatMessage = {
    id: `fixture-native-${engine}-${theme}-${streaming}`,
    conversationId: 'fixture',
    role: 'assistant',
    content: streaming ? '' : body,
    nativeAgent: {
      engine,
      events: raw.map((event, i) => ({
        engine,
        runId: 'fixture',
        sequence: i + 1,
        timestamp: i,
        ...event,
      })),
    },
    timestamp: 0,
  }
  renderMessage(message, streaming)
}
testWindow.appendNativeUpdate = () => {
  const message = testWindow.nativeMessage as ChatMessage
  const native = message.nativeAgent!
  const sequence = native.events[native.events.length - 1].sequence + 1
  const event: NativeAgentEvent = {
    engine: native.engine,
    runId: 'fixture',
    sequence,
    timestamp: sequence,
    type: 'tool_start',
    toolCallId: `next-${sequence}`,
    name: 'read',
    data: { arguments: {}, implementation: 'native' },
  }
  renderMessage(
    {
      ...message,
      nativeAgent: { ...native, events: [...native.events, event] },
    },
    true,
  )
}

testWindow.setAlternatingScenario = (engine: 'eva' | NativeAgentEvent['engine'], theme: string, live = false) => {
  document.documentElement.dataset.theme = theme
  useAgentStore.setState({ agents: [] })
  const narration = ['先查看项目结构，再确认需要调整的部分。', '结构已经看清。接下来检查入口和调用关系。', '检查结果已齐，正在整理结论。']
  const calls = [
    { id: 'one', name: 'read', arguments: { path: 'Cargo.toml', file_path: 'Cargo.toml' }, timestamp: 2 },
    { id: 'two', name: 'read', arguments: { path: 'src/lib.rs', file_path: 'src/lib.rs' }, timestamp: 3 },
    { id: 'three', name: 'pwsh', arguments: { command: 'cargo check' }, timestamp: 6 },
    { id: 'four', name: 'pwsh', arguments: { command: 'git diff --stat' }, timestamp: 7 },
  ]
  const message: ChatMessage = { id: `alternating-${engine}-${theme}-${live}`, conversationId: 'fixture', role: 'assistant', content: live ? '' : '检查完成。项目结构和调用关系已核对。', timestamp: 10 }
  if (engine === 'eva') {
    message.progressUpdates = narration.map((content, i) => ({ id: `public-${i}`, kind: 'finding', content, timestamp: [1, 5, 9][i] }))
    message.executionTimeline = calls.map(call => ({ id: call.id, kind: 'tool', timestamp: call.timestamp, toolCall: { id: call.id, name: call.name, arguments: call.arguments, result: live && call.id === 'four' ? undefined : `Full original output: ${call.id}` } }))
  } else {
    const payloads = narration.flatMap((content, i) => [
      { type: 'text_delta', messageId: `public-${i}`, content },
      ...calls.slice(i * 2, i * 2 + 2).flatMap(call => [
        { type: 'tool_start', toolCallId: call.id, name: call.name, data: { arguments: call.arguments, implementation: 'native' } },
        ...(live && call.id === 'four' ? [] : [{ type: 'tool_end', toolCallId: call.id, content: `Full original output: ${call.id}`, data: { isError: false } }]),
      ]),
    ])
    message.nativeAgent = { engine, events: payloads.map((payload, i) => ({ engine, runId: 'alternating', sequence: i, timestamp: i, ...payload })) }
  }
  testWindow.alternatingSnapshot = JSON.stringify(message)
  renderMessage(message, live)
}

const readingContent = `# 修改已经完成

**现在切换执行引擎后，答复采用同一套阅读层级。** 原始结果保持完整，执行记录可以按需展开。

## 调整了哪些部分

- 统一标题、正文和重点的视觉层级，阅读时更容易找到结论。
- 收起过程中的命令与工具反馈，完整记录仍然可以查看。

## 验证结果与下一步

| 检查 | 结果 |
| --- | --- |
| 排版一致性 | 已检查 |
| 原始内容 | 完整保留 |

> 这是一段引用说明，采用固定的缩进和边线，不添加额外装饰。

---

需要手动执行的命令仍留在答复中：

\`\`\`sh
npm run typecheck
\`\`\`

下一步请在项目中查看效果，必要时展开执行记录。
`

testWindow.setReadingScenario = (renderer: AgentMarkdownRenderer, theme: string, engine: 'eva' | NativeAgentEvent['engine'], streaming = false) => {
  testWindow.setNativeScenario(engine === 'eva' ? 'pi' : engine, theme)
  const agent: AgentConfig = {
    id: 'reading-agent', name: '编程助手', description: '', role: 'coder', systemPrompt: '',
    model: 'fixture', providerId: 'fixture', tools: [], maxIterations: 1, temperature: 0,
    isBuiltIn: false, createdAt: 0, updatedAt: 0, markdownRenderer: renderer,
    outputFormat: 'typora', outputStyle: 'editorial', outputColor: 'violet', outputTextEffect: 'floating',
    outputFont: 'system', outputFontSize: 'medium',
  }
  useAgentStore.setState({ agents: [agent] })
  const message: ChatMessage = {
    ...testWindow.nativeMessage, id: `reading-${engine}`, agentId: agent.id, agentName: agent.name,
    content: readingContent, timestamp: 0,
    timing: { modelDurationMs: 1200, toolExecutionMs: 300, totalMs: 1500, modelCalls: [], toolCalls: [] },
  }
  if (engine === 'eva') {
    delete message.nativeAgent
    message.executionTimeline = [{ id: 'tool', kind: 'tool', timestamp: 0, toolCall: {
      id: 'tool', name: 'execute_command', arguments: { command: 'original command --verbose' }, result: 'Original execution output',
    } }]
  } else {
    message.nativeAgent = { ...message.nativeAgent!, events: message.nativeAgent!.events.map(event => event.messageId === 'final' ? { ...event, content: event.type === 'text_delta' ? readingContent : event.content } : event) }
  }
  testWindow.originalReadingContent = readingContent
  testWindow.readingSnapshot = JSON.stringify(message)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { testWindow.copiedText = text } } })
  renderMessage(message, streaming, true)
}

testWindow.setReadingPreference = () => useAgentStore.setState(state => ({ agents: state.agents.map(agent => ({ ...agent, outputFont: 'serif', outputFontSize: '2xlarge' })) }))
testWindow.setNativeScenario('deepseek-harness', 'light')
setTimeout(() => {
  testWindow.uiReady = true
}, 100)
