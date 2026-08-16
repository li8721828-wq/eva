import { describe, expect, it } from 'vitest'
import { AgentRunner } from '../../src/main/agent-engine/agent-runner'
import { ContextManager } from '../../src/main/agent-engine/context'
import { ToolRegistry } from '../../src/main/tools'
import type { AgentConfig } from '../../src/shared/types/agent'
import type { ChatChunk } from '../../src/shared/types/provider'

const agent: AgentConfig = {
  id: 'adaptive-budget-agent',
  name: 'Adaptive budget agent',
  description: 'Test agent',
  role: 'coder',
  systemPrompt: 'Use the available tool when required.',
  model: 'test-model',
  providerId: 'test-provider',
  tools: ['inspect'],
  maxIterations: 3,
  temperature: 0,
  isBuiltIn: false,
  createdAt: 0,
  updatedAt: 0,
}

function chunks(...items: ChatChunk[]): AsyncIterable<ChatChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* items
    },
  }
}

describe('AgentRunner adaptive tool budget', () => {
  it('extends a Goal budget only after the model explicitly requests more evidence', async () => {
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: 'inspect', description: 'Inspect a fact.', parameters: {} },
      execute: async () => 'inspection complete',
    })
    let request = 0
    const provider = {
      id: 'test-provider',
      name: 'Test provider',
      type: 'custom' as const,
      supportsReasoning: () => false,
      chat: (params: { tools?: unknown[] }) => {
        request += 1
        if (params.tools?.length) {
          return chunks({
            content: '',
            toolCalls: [{ index: 0, id: `inspect-${request}`, name: 'inspect', arguments: '{}' }],
            finishReason: 'tool_calls',
          })
        }
        return request === 2
          ? chunks({ content: 'CONTINUE: The second inspection is needed to verify the result.', finishReason: 'stop' })
          : chunks({ content: 'FINAL: The required evidence has been verified.', finishReason: 'stop' })
      },
    }
    const unusedFileService = {} as never
    const unusedTerminalService = {} as never
    const runner = new AgentRunner({
      agentConfig: agent,
      provider: provider as never,
      toolRegistry: registry,
      contextManager: new ContextManager(),
      workspacePath: 'D:\\workspace',
      fileService: unusedFileService,
      terminalService: unusedTerminalService,
      adaptiveToolBudget: { initialIterations: 1, extensionIterations: 1, maxIterations: 3 },
    })

    const events = []
    for await (const event of runner.run({
      messages: [],
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: 'Verify the result.', timestamp: Date.now() },
    })) events.push(event)

    expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(2)
    expect(events.find((event) => event.type === 'done')?.content).toBe('The required evidence has been verified.')
  })

  it('runs a model-requested batch of independent reads concurrently', async () => {
    const registry = new ToolRegistry()
    let activeReads = 0
    let peakReads = 0
    registry.register({
      definition: { name: 'read_file', description: 'Read a file.', parameters: {} },
      execute: async () => {
        activeReads += 1
        peakReads = Math.max(peakReads, activeReads)
        await new Promise((resolve) => setTimeout(resolve, 20))
        activeReads -= 1
        return 'file content'
      },
    })
    let request = 0
    const provider = {
      id: 'test-provider',
      name: 'Test provider',
      type: 'custom' as const,
      supportsReasoning: () => false,
      chat: () => {
        request += 1
        return request === 1
          ? chunks({
              content: '',
              toolCalls: [
                { index: 0, id: 'read-a', name: 'read_file', arguments: '{"path":"a.ts"}' },
                { index: 1, id: 'read-b', name: 'read_file', arguments: '{"path":"b.ts"}' },
              ],
              finishReason: 'tool_calls',
            })
          : chunks({ content: 'Both files were read.', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: ['read_file'], maxIterations: 2 },
      provider: provider as never,
      toolRegistry: registry,
      contextManager: new ContextManager(),
      workspacePath: 'D:\\workspace',
      fileService: {} as never,
      terminalService: {} as never,
    })

    const events = []
    for await (const event of runner.run({
      messages: [],
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: 'Read two files.', timestamp: Date.now() },
    })) events.push(event)

    expect(peakReads).toBe(2)
    expect(events.filter((event) => event.type === 'tool_result')).toHaveLength(2)
    expect(events.find((event) => event.type === 'done')?.content).toBe('Both files were read.')
  })
})
