import { describe, expect, it, vi } from 'vitest'
import { AgentRunner } from '../../src/main/agent-engine/agent-runner'
import { ContextManager } from '../../src/main/agent-engine/context'
import { ToolRegistry } from '../../src/main/tools'
import type { AgentConfig } from '../../src/shared/types/agent'
import type { ChatChunk } from '../../src/shared/types/provider'

vi.mock('../../src/main/services/usage-pricing-service', () => ({
  resolveConnectionPricingMode: () => ({}),
  resolveRateCardUsageCost: () => ({}),
}))

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
  it('continues a provider-truncated response without imposing a max token request', async () => {
    let request = 0
    const requestedMaxTokens: Array<number | undefined> = []
    const provider = {
      id: 'test-provider',
      name: 'Test provider',
      type: 'custom' as const,
      supportsReasoning: () => false,
      chat: (params: { maxTokens?: number }) => {
        request += 1
        requestedMaxTokens.push(params.maxTokens)
        return request === 1
          ? chunks({ content: 'The first part', finishReason: 'length' })
          : chunks({ content: ' completes here.', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: [], maxIterations: 2 },
      provider: provider as never,
      toolRegistry: new ToolRegistry(),
      contextManager: new ContextManager(),
      workspacePath: 'D:\\workspace',
      fileService: {} as never,
      terminalService: {} as never,
    })

    const events = []
    for await (const event of runner.run({
      messages: [],
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: 'Continue the answer.', timestamp: Date.now() },
    })) events.push(event)

    expect(request).toBe(2)
    expect(requestedMaxTokens).toEqual([undefined, undefined])
    expect(events.find((event) => event.type === 'done')).toMatchObject({
      content: 'The first part completes here.',
      finishReason: 'stop',
    })
  })

  it('counts repeated streaming usage snapshots as one model call', async () => {
    const repeatedUsage = { promptTokens: 10_893, completionTokens: 248, cachedTokens: 3_703 }
    const provider = {
      id: 'test-provider',
      name: 'Test provider',
      type: 'custom' as const,
      supportsReasoning: () => false,
      chat: () => chunks(...Array.from({ length: 250 }, (_, index) => ({
        content: index === 0 ? 'Completed.' : '',
        usage: repeatedUsage,
        ...(index === 249 ? { finishReason: 'stop' as const } : {}),
      }))),
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: [] },
      provider: provider as never,
      toolRegistry: new ToolRegistry(),
      contextManager: new ContextManager(),
      workspacePath: 'D:\\workspace',
      fileService: {} as never,
      terminalService: {} as never,
    })

    const events = []
    for await (const event of runner.run({
      messages: [],
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: 'Say completed.', timestamp: Date.now() },
    })) events.push(event)

    expect(events.find((event) => event.type === 'done')).toMatchObject({
      content: 'Completed.',
      usage: {
        promptTokens: 10_893,
        completionTokens: 248,
        cachedTokens: 3_703,
        modelCalls: 1,
      },
    })
  })

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

  it('keeps the configured tool schemas available after a simple web lookup', async () => {
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: 'web_search', description: 'Search the web.', parameters: {} },
      execute: async () => 'One current weather result.',
    })
    const requestedTools: Array<string[] | undefined> = []
    let request = 0
    const provider = {
      id: 'test-provider',
      name: 'Test provider',
      type: 'custom' as const,
      supportsReasoning: () => false,
      chat: (params: { tools?: Array<{ name: string }> }) => {
        request += 1
        requestedTools.push(params.tools?.map((tool) => tool.name))
        return request === 1
          ? chunks({ content: '', toolCalls: [{ index: 0, id: 'weather', name: 'web_search', arguments: '{"query":"weather"}' }], finishReason: 'tool_calls' })
          : chunks({ content: 'It is cloudy.', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: ['web_search'], maxIterations: 2 },
      provider: provider as never,
      toolRegistry: registry,
      contextManager: new ContextManager(),
      workspacePath: 'D:\\workspace',
      fileService: {} as never,
      terminalService: {} as never,
    })

    for await (const _event of runner.run({
      messages: [],
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: '目前北京天气', timestamp: Date.now() },
    })) {
      // Exhaust the event stream.
    }

    expect(requestedTools).toEqual([['web_search'], ['web_search']])
  })

  it('streams final prose and clears provisional tool rationale', async () => {
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
      chat: () => {
        request += 1
        return request === 1
          ? chunks({ content: 'I will inspect the workspace first.', toolCalls: [{ index: 0, id: 'inspect-1', name: 'inspect', arguments: '{}' }], finishReason: 'tool_calls' })
          : chunks({ content: 'The inspection is complete.', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: ['inspect'], maxIterations: 2 },
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
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: 'Inspect the workspace.', timestamp: Date.now() },
    })) events.push(event)

    expect(events.filter((event) => event.type === 'text').map((event) => event.content)).toEqual([
      'I will inspect the workspace first.',
      'The inspection is complete.',
    ])
    expect(events.some((event) => event.type === 'text_reset')).toBe(true)

    const provisionalTextIndex = events.findIndex(
      (event) => event.type === 'text' && event.content === 'I will inspect the workspace first.'
    )
    const resetIndex = events.findIndex((event) => event.type === 'text_reset')
    const finalTextIndex = events.findIndex(
      (event) => event.type === 'text' && event.content === 'The inspection is complete.'
    )
    expect(provisionalTextIndex).toBeLessThan(resetIndex)
    expect(resetIndex).toBeLessThan(finalTextIndex)
    expect(events.find((event) => event.type === 'done')?.content).toBe('The inspection is complete.')
  })

  it('retries one malformed text tool envelope with the same tool definitions', async () => {
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: 'inspect', description: 'Inspect a fact.', parameters: {} },
      execute: async () => 'inspection complete',
    })
    const requestedTools: Array<string[] | undefined> = []
    let request = 0
    const provider = {
      id: 'test-provider',
      name: 'Test provider',
      type: 'custom' as const,
      supportsReasoning: () => false,
      chat: (params: { tools?: Array<{ name: string }> }) => {
        request += 1
        requestedTools.push(params.tools?.map((tool) => tool.name))
        if (request === 1) {
          return chunks({
            content: '<｜DSML｜tool_calls><｜DSML｜invoke name="inspect">',
            toolCallParseFailure: 'Malformed DSML.',
            finishReason: 'stop',
          })
        }
        if (request === 2) {
          return chunks({
            content: '',
            toolCalls: [{ index: 0, id: 'inspect-1', name: 'inspect', arguments: '{}' }],
            finishReason: 'tool_calls',
          })
        }
        return chunks({ content: 'The inspection is complete.', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: ['inspect'], maxIterations: 3 },
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
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: 'Inspect the workspace.', timestamp: Date.now() },
    })) events.push(event)

    expect(requestedTools).toEqual([['inspect'], ['inspect'], ['inspect']])
    expect(events.some((event) => event.type === 'text_reset' && event.discardProvisionalText)).toBe(true)
    expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(1)
    expect(events.find((event) => event.type === 'done')?.content).toBe('The inspection is complete.')
  })

  it('keeps configured tools available for a follow-up regardless of wording', async () => {
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: 'execute_command', description: 'Execute a command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      execute: async () => 'command complete',
    })
    const requestedTools: Array<string[] | undefined> = []
    const provider = {
      id: 'test-provider',
      name: 'Test provider',
      type: 'custom' as const,
      supportsReasoning: () => false,
      chat: (params: { tools?: Array<{ name: string }> }) => {
        requestedTools.push(params.tools?.map((tool) => tool.name))
        return chunks({ content: 'I will continue from the failed command.', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: ['execute_command'], maxIterations: 2 },
      provider: provider as never,
      toolRegistry: registry,
      contextManager: new ContextManager(),
      workspacePath: 'D:\\workspace',
      fileService: {} as never,
      terminalService: {} as never,
    })

    for await (const _event of runner.run({
      messages: [{
        id: 'prior', conversationId: 'conversation', role: 'assistant', content: 'Error: command failed', timestamp: Date.now(),
        toolCalls: [{ id: 'command-1', name: 'execute_command', arguments: { command: 'bad' }, result: 'Error', isError: true }],
      }],
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: 'go ahead', timestamp: Date.now() },
    })) {
      // Exhaust the stream.
    }

    expect(requestedTools[0]).toContain('execute_command')
  })

  it('falls back to normal output when slow reasoning is unavailable', async () => {
    const provider = {
      id: 'test-provider',
      name: 'Test provider',
      type: 'custom' as const,
      supportsReasoning: () => false,
      chat: () => chunks({ content: 'Normal response.', finishReason: 'stop' }),
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, showThinking: true, tools: [] },
      provider: provider as never,
      toolRegistry: new ToolRegistry(),
      contextManager: new ContextManager(),
      workspacePath: 'D:\\workspace',
      fileService: {} as never,
      terminalService: {} as never,
    })

    const events = []
    for await (const event of runner.run({
      messages: [],
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: 'Answer normally.', timestamp: Date.now() },
    })) events.push(event)

    expect(events.some((event) => event.type === 'thinking' && event.content?.includes('不支持慢思考'))).toBe(true)
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(events.find((event) => event.type === 'done')?.content).toBe('Normal response.')
  })
})
