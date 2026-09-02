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
          ? chunks({ content: 'The first part', finishReason: 'length', usage: { promptTokens: 200, completionTokens: 150, cachedTokens: 80 } })
          : chunks({ content: ' completes here.', finishReason: 'stop', usage: { promptTokens: 320, completionTokens: 60, cachedTokens: 120 } })
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
    expect(requestedMaxTokens).toEqual([2048, 2048])
    expect(events.find((event) => event.type === 'done')).toMatchObject({
      content: 'The first part completes here.',
      finishReason: 'stop',
      usage: {
        promptTokens: 520,
        completionTokens: 210,
        cachedTokens: 200,
        modelCalls: 2,
        modelCallUsage: [
          { promptTokens: 200, completionTokens: 150, cachedTokens: 80, cacheMissTokens: 120 },
          { promptTokens: 320, completionTokens: 60, cachedTokens: 120, cacheMissTokens: 200 },
        ],
      },
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
        modelCallUsage: [{
          promptTokens: 10_893,
          completionTokens: 248,
          cachedTokens: 3_703,
          cacheMissTokens: 7_190,
        }],
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

  it('keeps tools available while the model synthesizes a simple web lookup', async () => {
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

  it('converges a broad web overview after one successful search batch', async () => {
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: 'web_search', description: 'Search the web.', parameters: { type: 'object' } },
      execute: async (params) => `Result for ${params.query}`,
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
          ? chunks({
              content: '',
              finishReason: 'tool_calls',
              toolCalls: [
                { index: 0, id: 'market', name: 'web_search', arguments: JSON.stringify({ query: 'AI market size 2026' }) },
                { index: 1, id: 'funding', name: 'web_search', arguments: JSON.stringify({ query: 'AI funding trends 2026' }) },
              ],
            })
          : chunks({ content: 'AI market overview.', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: ['web_search'], maxIterations: 3 },
      provider: provider as never,
      toolRegistry: registry,
      contextManager: new ContextManager(),
      workspacePath: 'D:\\workspace',
      fileService: {} as never,
      terminalService: {} as never,
    })

    for await (const _event of runner.run({
      messages: [],
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: '可以帮我调研 AI 市场情况吗', timestamp: Date.now() },
    })) {
      // Exhaust the event stream.
    }

    expect(requestedTools).toEqual([['web_search'], ['web_search']])
  })

  it('requires reading a returned webpage before another web search', async () => {
    const registry = new ToolRegistry()
    let searchExecutions = 0
    let pageExecutions = 0
    registry.register({
      definition: { name: 'web_search', description: 'Search the web.', parameters: { type: 'object' } },
      execute: async () => {
        searchExecutions += 1
        return '1. Primary report\nhttps://example.com/report\nCurrent data'
      },
    })
    registry.register({
      definition: { name: 'read_web_page', description: 'Read a webpage.', parameters: { type: 'object' } },
      execute: async () => {
        pageExecutions += 1
        return 'Report body with the source evidence.'
      },
    })
    let request = 0
    const modelRequests: Array<{ messages?: Array<{ content: string }> }> = []
    const provider = {
      id: 'test-provider', name: 'Test provider', type: 'custom' as const, supportsReasoning: () => false,
      chat: (params: { messages?: Array<{ content: string }> }) => {
        request += 1
        modelRequests.push(params)
        if (request === 1 || request === 2) {
          return chunks({ content: '', finishReason: 'tool_calls', toolCalls: [{ index: 0, id: `search-${request}`, name: 'web_search', arguments: '{"query":"AI market"}' }] })
        }
        if (request === 3) {
          return chunks({ content: '', finishReason: 'tool_calls', toolCalls: [{ index: 0, id: 'page-1', name: 'read_web_page', arguments: '{"url":"https://example.com/report"}' }] })
        }
        return chunks({ content: 'The report was reviewed.', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: ['web_search', 'read_web_page'], maxIterations: 6 },
      provider: provider as never, toolRegistry: registry, contextManager: new ContextManager(), workspacePath: 'D:\\workspace',
      fileService: {} as never, terminalService: {} as never,
    })

    const events = []
    for await (const event of runner.run({
      messages: [], newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: '调研 AI 市场。', timestamp: Date.now() },
    })) events.push(event)

    expect(searchExecutions).toBe(1)
    expect(pageExecutions).toBe(1)
    expect(modelRequests[1].messages?.some((message) => message.content.includes('read_web_page'))).toBe(true)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      toolResult: expect.objectContaining({ name: 'web_search', isError: false, result: expect.stringContaining('read_web_page') }),
    }))
    expect(events.find((event) => event.type === 'done')?.content).toBe('The report was reviewed.')
  })

  it('stops an unchanged repeated tool batch and synthesizes from cached evidence', async () => {
    const registry = new ToolRegistry()
    let executions = 0
    registry.register({
      definition: { name: 'web_search', description: 'Search the web.', parameters: { type: 'object' } },
      execute: async () => {
        executions += 1
        return 'One result.'
      },
    })
    let request = 0
    const requestedTools: Array<string[] | undefined> = []
    const provider = {
      id: 'test-provider', name: 'Test provider', type: 'custom' as const, supportsReasoning: () => false,
      chat: (params: { tools?: Array<{ name: string }> }) => {
        request += 1
        requestedTools.push(params.tools?.map((tool) => tool.name))
        return request <= 2
          ? chunks({ content: '', finishReason: 'tool_calls', toolCalls: [{ index: 0, id: `search-${request}`, name: 'web_search', arguments: '{"query":"AI market"}' }] })
          : chunks({ content: 'The available evidence is limited to one result.', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: ['web_search'], maxIterations: 100 },
      provider: provider as never, toolRegistry: registry, contextManager: new ContextManager(), workspacePath: 'D:\\workspace',
      fileService: {} as never, terminalService: {} as never,
    })

    const events = []
    for await (const event of runner.run({
      messages: [], newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: '调研 AI 市场。', timestamp: Date.now() },
    })) events.push(event)

    expect(executions).toBe(1)
    expect(requestedTools).toEqual([['web_search'], ['web_search'], undefined])
    expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(2)
    expect(events.find((event) => event.type === 'done')?.content).toContain('available evidence')
  })

  it('streams final prose and retains ordinary pre-tool prose as process output', async () => {
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
    expect(events).toContainEqual(expect.objectContaining({ type: 'text_reset', discardProvisionalText: false }))

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

  it('retries one malformed text tool envelope with the same dispatcher', async () => {
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

  it('never streams mixed DSML markup as visible assistant text', async () => {
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: 'inspect', description: 'Inspect a fact.', parameters: {} },
      execute: async () => 'inspection complete',
    })
    const provider = {
      id: 'test-provider',
      name: 'Test provider',
      type: 'custom' as const,
      supportsReasoning: () => false,
      chat: () => chunks({
        content: '< | DSML | tool_calls>< | DSML | invoke name="inspect">< | DSML | invoke>< / | DSML | tool_calls>',
        toolCalls: [{ index: 0, id: 'inspect-1', name: 'inspect', arguments: '{}' }],
        finishReason: 'tool_calls',
      }),
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: ['inspect'], maxIterations: 1 },
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

    expect(events.filter((event) => event.type === 'text')).toHaveLength(0)
    expect(events.some((event) => event.type === 'tool_call')).toBe(true)
  })

  it('rejects DSML returned by the final tool-free synthesis call', async () => {
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: 'inspect', description: 'Inspect a fact.', parameters: {} },
      execute: async () => 'inspection complete',
    })
    const provider = {
      id: 'test-provider',
      name: 'Test provider',
      type: 'custom' as const,
      supportsReasoning: () => false,
      chat: (params: { tools?: Array<{ name: string }> }) => params.tools?.length
        ? chunks({ content: '', toolCalls: [{ index: 0, id: 'inspect-1', name: 'inspect', arguments: '{}' }], finishReason: 'tool_calls' })
        : chunks({ content: '< | DSML | tool_calls>< | DSML | invoke name="web_search">< / | DSML | invoke>< / | DSML | tool_calls>', finishReason: 'stop' }),
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: ['inspect'], maxIterations: 1 },
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

    expect(events.some((event) => event.type === 'error' && event.error?.includes('工具协议文本'))).toBe(true)
    expect(events.filter((event) => event.type === 'text')).toHaveLength(0)
  })

  it('keeps the failed tool available for a follow-up regardless of wording', async () => {
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

    expect(requestedTools[0]).toEqual(['execute_command'])
  })

  it('keeps all configured tools available for direct execution and synthesis', async () => {
    const registry = new ToolRegistry()
    const toolNames = ['read_file', 'write_file', 'edit_file', 'list_directory', 'search_files', 'execute_command', 'inspect_runtime', 'web_search', 'read_web_page']
    for (const name of toolNames) {
      registry.register({
        definition: { name, description: name === 'inspect_runtime' ? 'Inspect runtime diagnostics and health.' : `Tool ${name}.`, parameters: { type: 'object' } },
        execute: async () => `${name} complete`,
      })
    }
    const requestedTools: Array<string[] | undefined> = []
    let request = 0
    const provider = {
      id: 'test-provider', name: 'Test provider', type: 'custom' as const, supportsReasoning: () => false,
      chat: (params: { tools?: Array<{ name: string }> }) => {
        request += 1
        requestedTools.push(params.tools?.map((tool) => tool.name))
        return request === 1
          ? chunks({ content: '', finishReason: 'tool_calls', toolCalls: [{ index: 0, id: 'inspect', name: 'inspect_runtime', arguments: '{}' }] })
          : chunks({ content: 'Runtime inspection complete.', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: toolNames, maxIterations: 3 },
      provider: provider as never, toolRegistry: registry, contextManager: new ContextManager(), workspacePath: 'D:\\workspace',
      fileService: {} as never, terminalService: {} as never,
    })

    for await (const _event of runner.run({
      messages: [], newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: 'Inspect runtime diagnostics.', timestamp: Date.now() },
    })) {
      // Exhaust the event stream.
    }

    expect(requestedTools[0]).toEqual(toolNames)
    expect(requestedTools[1]).toEqual(toolNames)
  })

  it('prioritizes the structured spreadsheet tool for workbook attachments', async () => {
    const registry = new ToolRegistry()
    for (const name of ['execute_command', 'spreadsheet']) {
      registry.register({
        definition: { name, description: name === 'spreadsheet' ? 'Inspect and update workbooks.' : 'Run a shell command.', parameters: { type: 'object' } },
        execute: async () => `${name} complete`,
      })
    }
    const requestedTools: string[][] = []
    const systemPrompts: string[] = []
    const provider = {
      id: 'test-provider', name: 'Test provider', type: 'custom' as const,
      supportsReasoning: () => false,
      chat: (params: { tools?: Array<{ name: string }>; messages?: Array<{ role: string; content: string }> }) => {
        requestedTools.push((params.tools || []).map((tool) => tool.name))
        systemPrompts.push(params.messages?.[0]?.content || '')
        return chunks({ content: 'Workbook reviewed.', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: ['execute_command'], maxIterations: 1 }, provider: provider as never,
      toolRegistry: registry, contextManager: new ContextManager(), workspacePath: 'D:\\workspace', fileService: {} as never, terminalService: {} as never,
    })

    for await (const _event of runner.run({
      messages: [],
      newMessage: { id: 'xlsx-message', conversationId: 'conversation', role: 'user', content: '请分析这个文件', attachments: [{ path: 'D:\\workspace\\sales.xlsx', name: 'sales.xlsx', size: 12, kind: 'file' }], timestamp: Date.now() },
    })) { /* exhaust */ }

    expect(requestedTools[0]?.[0]).toBe('spreadsheet')
    expect(systemPrompts[0]).toContain('Use the structured `spreadsheet` tool first')
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

  it('retries once when a provider returns reasoning without a final answer', async () => {
    let request = 0
    const provider = {
      id: 'test-provider',
      name: 'Test provider',
      type: 'custom' as const,
      supportsReasoning: () => true,
      chat: () => {
        request += 1
        return request === 1
          ? chunks({ content: '', reasoningContent: 'internal plan', finishReason: 'stop' })
          : chunks({ content: 'Recovered final answer.', finishReason: 'stop' })
      },
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
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: 'Answer this.', timestamp: Date.now() },
    })) events.push(event)

    expect(request).toBe(2)
    expect(events.find((event) => event.type === 'done')?.content).toBe('Recovered final answer.')
    expect(events.some((event) => event.type === 'error')).toBe(false)
  })
})
