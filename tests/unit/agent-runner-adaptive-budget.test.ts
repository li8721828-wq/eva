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

/** Stands in for the supplier HTTP round-trip; stays pending until a test settles it. */
const pricingProbe = vi.hoisted(() => ({ settled: false }))

vi.mock('../../src/main/services/supplier-pricing-service', () => ({
  ensureProviderPricing: () => new Promise<void>(() => {
    pricingProbe.settled = false
  }),
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
  it('issues the first model request while the supplier pricing refresh is still in flight', async () => {
    let pricingSettledAtModelCall: boolean | null = null
    const chat = vi.fn(() => {
      pricingSettledAtModelCall = pricingProbe.settled
      return chunks({ content: 'Answer.', finishReason: 'stop' })
    })
    const provider = {
      id: 'test-provider', name: 'Test provider', type: 'custom' as const, supportsReasoning: () => false, chat,
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: [] }, provider: provider as never,
      toolRegistry: new ToolRegistry(), contextManager: new ContextManager(), workspacePath: 'D:\\workspace',
      fileService: {} as never, terminalService: {} as never,
    })

    const events = []
    for await (const event of runner.run({
      messages: [], newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: '你好！', timestamp: Date.now() },
    })) events.push(event)

    expect(chat).toHaveBeenCalledTimes(1)
    expect(pricingSettledAtModelCall).toBe(false)
    expect(events.find((event) => event.type === 'done')?.content).toBe('Answer.')
  })

  it.each([false, true])('handles a fragmented gateway rejection without confusing quoted explanations (quoted=%s)', async (quoted) => {
    const notice = '[req_570e3146] [deepseek-v4.1-flash]\n**Bad request from AI provider**\nYour request was rejected by the AI provider.\nDo not resend the same request.\nRecommended tools: These responses are optimized for opencode, Claude Code, and Codex.'
    const answer = quoted ? `The error you asked about means the gateway rejected the request. Example:\n${notice}` : notice
    const chat = vi.fn(() => chunks(...Array.from(answer, (content) => ({ content })), { content: '', finishReason: 'stop' }))
    const provider = { id: 'test-provider', name: 'Test provider', type: 'custom' as const, supportsReasoning: () => false, chat }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: [] }, provider: provider as never,
      toolRegistry: new ToolRegistry(), contextManager: new ContextManager(), workspacePath: 'D:\\workspace',
      fileService: {} as never, terminalService: {} as never,
    })
    const events = []
    for await (const event of runner.run({
      messages: [], newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: quoted ? 'Explain this error' : 'Hello', timestamp: 0 },
    })) events.push(event)
    expect(chat).toHaveBeenCalledTimes(1)
    if (quoted) {
      expect(events.some((event) => event.type === 'error')).toBe(false)
      expect(events).toContainEqual(expect.objectContaining({ type: 'done', content: answer }))
    } else {
      expect(events).toContainEqual(expect.objectContaining({ type: 'text_reset', discardProvisionalText: true, reason: 'provider-error' }))
      expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining('invalid_request') }))
      expect(events.some((event) => event.type === 'done')).toBe(false)
    }
  })

  it('rejects a gateway notice after a successful tool call without retrying', async () => {
    const registry = new ToolRegistry()
    const execute = vi.fn(async () => 'README contents')
    registry.register({ definition: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } }, execute })
    const chat = vi.fn()
      .mockImplementationOnce(() => chunks({ content: '', finishReason: 'tool_calls', toolCalls: [{ index: 0, id: 'read-1', name: 'read_file', arguments: '{}' }] }))
      .mockImplementation(() => chunks({ content: '[req_failed] [test-model]\n**Bad request from AI provider**\nDo not resend the same request. Recommended tools: These responses are optimized for opencode.', finishReason: 'stop' }))
    const provider = { id: 'test-provider', name: 'Test provider', type: 'custom' as const, supportsReasoning: () => false, chat }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: ['read_file'] }, provider: provider as never,
      toolRegistry: registry, contextManager: new ContextManager(), workspacePath: 'D:/workspace',
      fileService: {} as never, terminalService: {} as never,
    })
    const events = []
    for await (const event of runner.run({
      messages: [], newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: 'Read the README file and summarize it', timestamp: 0 },
    })) events.push(event)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(chat).toHaveBeenCalledTimes(2)
    expect(chat.mock.calls[1][0].tools).toBeUndefined()
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining('invalid_request') }))
    expect(events.some((event) => event.type === 'done')).toBe(false)
  })

  it('sends a standalone greeting through the provider', async () => {
    let providerCalls = 0
    let requestMessages: Array<{ role: string; content: string }> = []
    const provider = {
      id: 'test-provider', name: 'Test provider', type: 'custom' as const, supportsReasoning: () => false,
      chat: (params: { messages: Array<{ role: string; content: string }> }) => {
        providerCalls += 1
        requestMessages = params.messages
        return chunks({ content: '你好！有什么我可以帮你处理的吗？', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: [] }, provider: provider as never,
      toolRegistry: new ToolRegistry(), contextManager: new ContextManager(), workspacePath: 'D:\\workspace',
      fileService: {} as never, terminalService: {} as never,
    })

    const events = []
    for await (const event of runner.run({
      messages: [{ id: 'old', conversationId: 'conversation', role: 'assistant', content: 'A long unrelated answer.', timestamp: 0 }],
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: '你好！', timestamp: Date.now() },
    })) events.push(event)

    expect(providerCalls).toBe(1)
    expect(requestMessages.at(-1)?.content).toContain('你好！')
    expect(requestMessages.find((message) => message.role === 'system')?.content).toContain('Current Turn Priority')
    expect(requestMessages.find((message) => message.role === 'system')?.content).toContain('one or two short sentences')
    expect(requestMessages.find((message) => message.role === 'system')?.content).toContain('Do not recap earlier answers')
    expect(events).toContainEqual(expect.objectContaining({ type: 'done', content: '你好！有什么我可以帮你处理的吗？' }))
  })

  it('rejects a gateway client notice instead of exposing it as an answer', async () => {
    const provider = {
      id: 'test-provider', name: 'Test provider', type: 'custom' as const, supportsReasoning: () => false,
      chat: () => chunks({
        content: '0 cached tokens.\\n\\nDo not resend the same request - it will keep failing and keep consuming your quota. Recommended tools: These responses are optimized for opencode, Claude Code, and Codex. If you are using a non-standard client and keep hitting errors, switch to one of the supported tools above.',
        finishReason: 'stop',
      }),
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: [] }, provider: provider as never,
      toolRegistry: new ToolRegistry(), contextManager: new ContextManager(), workspacePath: 'D:\\workspace',
      fileService: {} as never, terminalService: {} as never,
    })

    const events = []
    for await (const event of runner.run({
      messages: [],
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: '请检查当前服务状态', timestamp: Date.now() },
    })) events.push(event)

    expect(events).toContainEqual(expect.objectContaining({ type: 'text_reset', discardProvisionalText: true, reason: 'provider-error' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining('未将其作为回答展示') }))
    expect(events.some((event) => event.type === 'done')).toBe(false)
  })

  it('loads the whole configured catalog on the first request instead of gating tools by keywords', async () => {
    // "进行改造吧" carries no tool keyword; the model must still receive every
    // tool its agent config authorizes, including the write tools.
    const registry = new ToolRegistry()
    const executed: string[] = []
    for (const name of ['read_file', 'write_file']) {
      registry.register({
        definition: { name, description: `Tool ${name}.`, parameters: { type: 'object' } },
        execute: async () => { executed.push(name); return `${name} complete` },
      })
    }
    let request = 0
    const toolSets: Array<string[] | undefined> = []
    const provider = {
      id: 'test-provider', name: 'Test provider', type: 'custom' as const, supportsReasoning: () => false,
      chat: (params: { tools?: Array<{ name: string }>; messages: Array<{ role: string; content: string }> }) => {
        request += 1
        if (request === 1) expect(params.messages[0].content).not.toContain('request_additional_tools')
        toolSets.push(params.tools?.map((tool) => tool.name))
        if (request === 1) return chunks({ content: '', finishReason: 'tool_calls', toolCalls: [{ index: 0, id: 'read', name: 'read_file', arguments: '{"path":"README.md"}' }] })
        return chunks({ content: 'README inspected.', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: ['read_file', 'write_file'], maxIterations: 3 }, provider: provider as never,
      toolRegistry: registry, contextManager: new ContextManager(), workspacePath: 'D:\\workspace',
      fileService: {} as never, terminalService: {} as never,
    })

    const events = []
    for await (const event of runner.run({
      messages: [], newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: '进行改造吧', timestamp: Date.now() },
    })) events.push(event)

    // The full authorized catalog is present on the first request; the lone read
    // then goes through the tool-free synthesis checkpoint, so the second
    // request intentionally carries no tools.
    expect(toolSets[0]).toEqual(['read_file', 'write_file'])
    expect(toolSets[1]).toBeUndefined()
    expect(executed).toEqual(['read_file'])
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_result', toolResult: expect.objectContaining({ name: 'read_file', isError: false }) }))
    expect(events.find((event) => event.type === 'done')?.content).toBe('README inspected.')
  })

  it('refuses a tool the agent config does not authorize', async () => {
    const registry = new ToolRegistry()
    for (const name of ['read_file', 'execute_command']) {
      registry.register({
        definition: { name, description: `Tool ${name}.`, parameters: { type: 'object' } },
        execute: async () => `${name} complete`,
      })
    }
    let request = 0
    const provider = {
      id: 'test-provider', name: 'Test provider', type: 'custom' as const, supportsReasoning: () => false,
      chat: () => {
        request += 1
        return request === 1
          ? chunks({ content: '', finishReason: 'tool_calls', toolCalls: [{ index: 0, id: 'run', name: 'execute_command', arguments: '{"command":"rm -rf /"}' }] })
          : chunks({ content: '我只有只读权限。', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: ['read_file'], maxIterations: 3 }, provider: provider as never,
      toolRegistry: registry, contextManager: new ContextManager(), workspacePath: 'D:\\workspace',
      fileService: {} as never, terminalService: {} as never,
    })

    const events = []
    for await (const event of runner.run({
      messages: [], newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: '帮我跑个命令', timestamp: Date.now() },
    })) events.push(event)

    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_result', toolResult: expect.objectContaining({ name: 'execute_command', isError: true }) }))
    expect(events.some((event) => event.type === 'tool_call' && (event as { toolCall?: { name?: string } }).toolCall?.name === 'execute_command')).toBe(false)
  })

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
    expect(requestedMaxTokens).toEqual([4096, 4096])
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

  it('continues a truncated final synthesis after tool execution', async () => {
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: 'inspect', description: 'Inspect the current state.', parameters: { type: 'object' } },
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
        if (request === 1) return chunks({ content: '', finishReason: 'tool_calls', toolCalls: [{ index: 0, id: 'inspect-1', name: 'inspect', arguments: '{}' }] })
        if (request === 2) return chunks({ content: '结论的前半部分，', finishReason: 'length' })
        return chunks({ content: '后半部分已经补齐。', finishReason: 'stop' })
      },
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
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: '检查当前状态并总结', timestamp: Date.now() },
    })) events.push(event)

    expect(request).toBe(3)
    expect(events.find((event) => event.type === 'done')).toMatchObject({
      content: '结论的前半部分，后半部分已经补齐。',
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

  it('sends every configured tool on the first request', async () => {
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
    expect(requestedTools[1]).toBeUndefined()
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

  it('keeps detailed process output stepwise and does not request provider CoT', async () => {
    const registry = new ToolRegistry()
    const executedPaths: string[] = []
    registry.register({
      definition: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
      execute: async (params) => {
        executedPaths.push(String(params.path))
        return `Contents of ${String(params.path)}`
      },
    })
    const calls: Array<{ reasoning?: unknown; messages?: Array<{ role: string; content?: string }>; tools?: unknown[] }> = []
    let request = 0
    const provider = {
      id: 'test-provider',
      name: 'Test provider',
      type: 'custom' as const,
      supportsReasoning: () => true,
      chat: (params: { reasoning?: unknown; messages?: Array<{ role: string; content?: string }>; tools?: unknown[] }) => {
        calls.push(params)
        request += 1
        return request === 1
          ? chunks({
              content: '',
              finishReason: 'tool_calls',
              toolCalls: [
                { index: 0, id: 'read-a', name: 'read_file', arguments: '{"path":"a.md"}' },
                { index: 1, id: 'read-b', name: 'read_file', arguments: '{"path":"b.md"}' },
              ],
            })
          : chunks({ content: '已完成。', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, processOutput: 'detailed', showThinking: true, tools: ['read_file'] },
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
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: '逐步读取文件', timestamp: Date.now() },
    })) events.push(event)

    expect(executedPaths).toEqual(['a.md'])
    expect(calls[0]?.reasoning).toEqual({ enabled: false })
    expect(calls[1]?.messages?.some((message) => message.content?.includes('other requested operations were not executed'))).toBe(true)
    expect(events.some((event) => event.type === 'thinking' && event.content?.includes('详细步骤模式'))).toBe(true)
    expect(events.find((event) => event.type === 'done')?.content).toBe('已完成。')
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

  it('turns hidden reasoning off for the empty-response retry', async () => {
    const reasoningParams: Array<unknown> = []
    let request = 0
    const provider = {
      id: 'test-provider',
      name: 'Test provider',
      type: 'deepseek' as const,
      supportsReasoning: () => true,
      chat: (params: { reasoning?: unknown }) => {
        reasoningParams.push(params.reasoning)
        request += 1
        return request === 1
          ? chunks({ content: '', reasoningContent: 'a long internal plan that never reached the answer', finishReason: 'length' })
          : chunks({ content: 'Visible answer.', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, model: 'deepseek-v4-flash', showThinking: true, tools: [] },
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
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: '改造这个模块', timestamp: Date.now() },
    })) events.push(event)

    expect(reasoningParams[0]).toEqual({ enabled: true, budgetTokens: 1024 })
    expect(reasoningParams[1]).toEqual({ enabled: false })
    expect(events.find((event) => event.type === 'done')?.content).toBe('Visible answer.')
    expect(events.some((event) => event.type === 'error')).toBe(false)
  })

  it('names the finish reason and reasoning size when the answer stays empty', async () => {
    let request = 0
    const provider = {
      id: 'test-provider',
      name: 'Test provider',
      type: 'deepseek' as const,
      supportsReasoning: () => true,
      chat: () => {
        request += 1
        return chunks({ content: '', reasoningContent: 'thinking forever', finishReason: 'length', usage: { promptTokens: 100, completionTokens: 8192 } })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, model: 'deepseek-v4-flash', showThinking: true, tools: [] },
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
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: '改造这个模块', timestamp: Date.now() },
    })) events.push(event)

    expect(request).toBe(2)
    const errorEvent = events.find((event) => event.type === 'error')
    // Only this sentence's first line is stored as the round's explanation, so
    // it has to carry both the evidence and what the user can do next.
    expect(errorEvent?.error).toContain('模型 deepseek-v4-flash 未返回可见答案')
    expect(errorEvent?.error).toContain('finish reason=length')
    expect(errorEvent?.error).toContain('输出 8192 tokens')
    expect(errorEvent?.error).toContain('16 字符为隐藏思考')
    expect(errorEvent?.error).toContain('输出上限在产生正文之前就用完了')
    expect(errorEvent?.error).toContain('已关闭思考模式重试一次仍未产出正文')
  })

  it('disables reasoning for the empty tool-result synthesis retry', async () => {
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
      execute: async () => 'Observed file contents.',
    })
    const reasoningParams: Array<unknown> = []
    let request = 0
    const provider = {
      id: 'test-provider',
      name: 'Test provider',
      type: 'deepseek' as const,
      supportsReasoning: () => true,
      chat: (params: { reasoning?: unknown }) => {
        reasoningParams.push(params.reasoning)
        request += 1
        // 1: the read tool call. 2: the lone-read checkpoint. 3: the empty
        // synthesis. 4: the synthesis retry, which must drop hidden reasoning.
        if (request === 1) {
          return chunks({ content: '', finishReason: 'tool_calls', toolCalls: [{ index: 0, id: 'read', name: 'read_file', arguments: '{"path":"README.md"}' }] })
        }
        return request === 4
          ? chunks({ content: 'Recovered from completed tool results.', finishReason: 'stop' })
          : chunks({ content: '', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, model: 'deepseek-v4-flash', showThinking: true, tools: ['read_file'] },
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
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: '检查 README.md', timestamp: Date.now() },
    })) events.push(event)

    expect(request).toBe(4)
    expect(reasoningParams[3]).toEqual({ enabled: false })
    expect(events.find((event) => event.type === 'done')?.content).toBe('Recovered from completed tool results.')
    expect(events.some((event) => event.type === 'error')).toBe(false)
  })

  it('retries an empty tool-result synthesis before surfacing failure', async () => {
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
      execute: async () => 'Observed file contents.',
    })
    let request = 0
    const synthesisMessages: Array<{ role: string; toolCalls?: unknown }> = []
    const provider = {
      id: 'test-provider',
      name: 'Test provider',
      type: 'custom' as const,
      supportsReasoning: () => false,
      chat: (params: { messages?: Array<{ role: string; toolCalls?: unknown }> }) => {
        request += 1
        if (request === 1) {
          return chunks({ content: '', finishReason: 'tool_calls', toolCalls: [{ index: 0, id: 'read', name: 'read_file', arguments: '{"path":"README.md"}' }] })
        }
        if (request >= 2) synthesisMessages.push(...(params.messages || []).map(({ role, toolCalls }) => ({ role, toolCalls })))
        return request === 2
          ? chunks({ content: '', finishReason: 'stop' })
          : chunks({ content: 'Recovered from completed tool results.', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: ['read_file'] },
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
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: '检查 README.md', timestamp: Date.now() },
    })) events.push(event)

    expect(request).toBe(3)
    expect(synthesisMessages.some((message) => message.role === 'tool' || message.toolCalls)).toBe(false)
    expect(events.find((event) => event.type === 'done')?.content).toBe('Recovered from completed tool results.')
    expect(events.some((event) => event.type === 'error')).toBe(false)
  })

  it('does not re-run a side-effecting tool repeated during the final synthesis', async () => {
    const registry = new ToolRegistry()
    let writeExecutions = 0
    registry.register({
      definition: { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      execute: async () => {
        writeExecutions += 1
        return '{"status":"ok"}'
      },
    })
    let request = 0
    const synthesisNotices: string[] = []
    const provider = {
      id: 'test-provider',
      name: 'Test provider',
      type: 'custom' as const,
      supportsReasoning: () => false,
      chat: (params: { messages?: Array<{ role: string; content?: string }>; tools?: Array<{ name: string }> }) => {
        request += 1
        // 1-2: the same write batch twice, which stops the tool loop. 3: the
        // tool-free synthesis, where a gateway that ignores the instruction
        // repeats that same call instead of answering.
        if (request <= 2) {
          return chunks({ content: '', finishReason: 'tool_calls', toolCalls: [{ index: 0, id: `write-${request}`, name: 'write_file', arguments: '{"path":"notes.md","content":"x"}' }] })
        }
        if (!params.tools?.length) {
          synthesisNotices.push(...(params.messages || []).filter((message) => message.role === 'user' && message.content).map((message) => message.content!))
        }
        if (request === 3) {
          return chunks({ content: '', finishReason: 'tool_calls', toolCalls: [{ index: 0, id: 'write-3', name: 'write_file', arguments: '{"path":"notes.md","content":"x"}' }] })
        }
        return chunks({ content: 'The write was already applied.', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: ['write_file'], maxIterations: 6 },
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
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: '写入 notes.md。', timestamp: Date.now() },
    })) events.push(event)

    // The loop itself tolerates one repeated batch, so the write runs twice
    // there. The synthesis turn must not add a third execution of the same
    // call: its result is already in the conversation.
    expect(writeExecutions).toBe(2)
    expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(2)
    expect(synthesisNotices.some((content) => content.includes('already performed them'))).toBe(true)
    expect(events.find((event) => event.type === 'done')?.content).toBe('The write was already applied.')
    expect(events.some((event) => event.type === 'error')).toBe(false)
  })

  it('recovers a read-only call during the final synthesis', async () => {
    const registry = new ToolRegistry()
    let writeExecutions = 0
    registry.register({
      definition: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
      execute: async () => 'Observed file contents.',
    })
    registry.register({
      definition: { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      execute: async () => {
        writeExecutions += 1
        return '{"status":"ok"}'
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
        // 1: read a file. 2: tool-free completion checkpoint. 3: the final
        // synthesis, which asks for the one action this run has not performed.
        if (request === 1) {
          return chunks({ content: '', finishReason: 'tool_calls', toolCalls: [{ index: 0, id: 'read-1', name: 'read_file', arguments: '{"path":"README.md"}' }] })
        }
        if (request === 2) return chunks({ content: '', finishReason: 'stop' })
        if (request === 3) {
          return chunks({ content: '', finishReason: 'tool_calls', toolCalls: [{ index: 0, id: 'write-1', name: 'write_file', arguments: '{"path":"notes.md","content":"x"}' }] })
        }
        return chunks({ content: 'Answer from the evidence already collected.', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: ['read_file', 'write_file'] },
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
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: '读取 README.md 并写入 notes.md', timestamp: Date.now() },
    })) events.push(event)

    // A call the run has not performed yet is still recovered, so a task that
    // reads at synthesis time can finish its action; only repeats are declined.
    expect(writeExecutions).toBe(1)
    expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(2)
    expect(events.find((event) => event.type === 'done')?.content).toBe('Answer from the evidence already collected.')
    expect(events.some((event) => event.type === 'error')).toBe(false)
  })

  it('re-reads a file after a successful write instead of reusing the cached pre-edit content', async () => {
    const registry = new ToolRegistry()
    let readExecutions = 0
    let fileContents = 'export const version = 1'
    registry.register({
      definition: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
      execute: async () => {
        readExecutions += 1
        return fileContents
      },
    })
    registry.register({
      definition: { name: 'list_directory', description: 'List a directory.', parameters: { type: 'object' } },
      execute: async () => 'notes.ts',
    })
    registry.register({
      definition: { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      execute: async () => {
        fileContents = 'export const version = 2'
        return JSON.stringify({ status: 'ok', path: 'notes.ts' })
      },
    })
    let request = 0
    const provider = {
      id: 'test-provider', name: 'Test provider', type: 'custom' as const, supportsReasoning: () => false,
      chat: () => {
        request += 1
        if (request === 1) {
          return chunks({
            content: '', finishReason: 'tool_calls',
            toolCalls: [
              { index: 0, id: 'read-1', name: 'read_file', arguments: '{"path":"notes.ts"}' },
              { index: 1, id: 'list-1', name: 'list_directory', arguments: '{"path":"."}' },
            ],
          })
        }
        if (request === 2) {
          return chunks({
            content: '', finishReason: 'tool_calls',
            toolCalls: [{ index: 0, id: 'write-1', name: 'write_file', arguments: '{"path":"notes.ts","content":"export const version = 2"}' }],
          })
        }
        if (request === 3) {
          return chunks({
            content: '', finishReason: 'tool_calls',
            toolCalls: [
              { index: 0, id: 'read-2', name: 'read_file', arguments: '{"path":"notes.ts"}' },
              { index: 1, id: 'list-2', name: 'list_directory', arguments: '{"path":"src"}' },
            ],
          })
        }
        return chunks({ content: 'Updated and verified.', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: ['read_file', 'list_directory', 'write_file'], maxIterations: 6 },
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
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: '读取 notes.ts，修改 version 后重新读取验证。', timestamp: Date.now() },
    })) events.push(event)

    const readResults = events
      .filter((event) => event.type === 'tool_result' && event.toolResult.name === 'read_file')
      .map((event) => event.toolResult.result)
    expect(readExecutions).toBe(2)
    expect(readResults).toEqual(['export const version = 1', 'export const version = 2'])
    expect(events.find((event) => event.type === 'done')?.content).toBe('Updated and verified.')
  })

  it('decides a lone successful read at a tool-free checkpoint instead of forcing synthesis', async () => {
    const registry = new ToolRegistry()
    let readExecutions = 0
    registry.register({
      definition: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
      execute: async () => {
        readExecutions += 1
        return 'export const version = 1'
      },
    })
    const requestedTools: Array<string[] | undefined> = []
    let request = 0
    const provider = {
      id: 'test-provider', name: 'Test provider', type: 'custom' as const, supportsReasoning: () => false,
      chat: (params: { tools?: Array<{ name: string }> }) => {
        request += 1
        requestedTools.push(params.tools?.map((tool) => tool.name))
        return request === 1
          ? chunks({ content: '', finishReason: 'tool_calls', toolCalls: [{ index: 0, id: 'read-1', name: 'read_file', arguments: '{"path":"notes.ts"}' }] })
          : chunks({ content: 'FINAL: notes.ts exports version 1.', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: ['read_file'], maxIterations: 4 },
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
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: '查看 notes.ts 的版本号。', timestamp: Date.now() },
    })) events.push(event)

    expect(requestedTools).toEqual([['read_file'], undefined])
    expect(readExecutions).toBe(1)
    expect(events.find((event) => event.type === 'done')?.content).toBe('notes.ts exports version 1.')
  })

  it('keeps acting after a lone read when the checkpoint reports pending work', async () => {
    const registry = new ToolRegistry()
    let readExecutions = 0
    const readResults: string[] = []
    let fileContents = 'export const version = 1'
    registry.register({
      definition: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
      execute: async () => {
        readExecutions += 1
        readResults.push(fileContents)
        return fileContents
      },
    })
    registry.register({
      definition: { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      execute: async () => {
        fileContents = 'export const version = 2'
        return JSON.stringify({ status: 'ok', path: 'notes.ts' })
      },
    })
    const requestedTools: Array<string[] | undefined> = []
    let request = 0
    const provider = {
      id: 'test-provider', name: 'Test provider', type: 'custom' as const, supportsReasoning: () => false,
      chat: (params: { tools?: Array<{ name: string }> }) => {
        request += 1
        requestedTools.push(params.tools?.map((tool) => tool.name))
        if (request === 1) {
          return chunks({ content: '', finishReason: 'tool_calls', toolCalls: [{ index: 0, id: 'read-1', name: 'read_file', arguments: '{"path":"notes.ts"}' }] })
        }
        if (request === 2) {
          return chunks({ content: 'CONTINUE: notes.ts still needs the version bump.', finishReason: 'stop' })
        }
        if (request === 3) {
          return chunks({ content: '', finishReason: 'tool_calls', toolCalls: [{ index: 0, id: 'write-1', name: 'write_file', arguments: '{"path":"notes.ts","content":"export const version = 2"}' }] })
        }
        if (request === 4) {
          return chunks({ content: '', finishReason: 'tool_calls', toolCalls: [{ index: 0, id: 'read-2', name: 'read_file', arguments: '{"path":"notes.ts"}' }] })
        }
        return chunks({ content: 'FINAL: notes.ts is now version 2.', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: ['read_file', 'write_file'], maxIterations: 6 },
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
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: '查看并修改 notes.ts 的版本号。', timestamp: Date.now() },
    })) events.push(event)

    expect(requestedTools).toEqual([
      ['read_file', 'write_file'],
      undefined,
      ['read_file', 'write_file'],
      ['read_file', 'write_file'],
      undefined,
    ])
    expect(readExecutions).toBe(2)
    expect(readResults).toEqual(['export const version = 1', 'export const version = 2'])
    expect(events.find((event) => event.type === 'done')?.content).toBe('notes.ts is now version 2.')
  })

  it('re-runs an identical read batch after an intervening write', async () => {
    const registry = new ToolRegistry()
    const readCounts: Record<string, number> = {}
    registry.register({
      definition: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
      execute: async (params: { path?: string }) => {
        const path = String(params.path)
        readCounts[path] = (readCounts[path] || 0) + 1
        return `${path} content`
      },
    })
    registry.register({
      definition: { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      execute: async () => JSON.stringify({ status: 'ok' }),
    })
    const requestedTools: Array<string[] | undefined> = []
    let request = 0
    const provider = {
      id: 'test-provider', name: 'Test provider', type: 'custom' as const, supportsReasoning: () => false,
      chat: (params: { tools?: Array<{ name: string }> }) => {
        request += 1
        requestedTools.push(params.tools?.map((tool) => tool.name))
        if (request === 1 || request === 3) {
          return chunks({
            content: '', finishReason: 'tool_calls',
            toolCalls: [
              { index: 0, id: `read-a-${request}`, name: 'read_file', arguments: '{"path":"a.ts"}' },
              { index: 1, id: `read-b-${request}`, name: 'read_file', arguments: '{"path":"b.ts"}' },
            ],
          })
        }
        if (request === 2) {
          return chunks({ content: '', finishReason: 'tool_calls', toolCalls: [{ index: 0, id: 'write-a', name: 'write_file', arguments: '{"path":"a.ts","content":"updated"}' }] })
        }
        return chunks({ content: 'Both files were re-read after the write.', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: ['read_file', 'write_file'], maxIterations: 6 },
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
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: '查看并修改 a.ts，然后重新读取两个文件。', timestamp: Date.now() },
    })) events.push(event)

    expect(readCounts['a.ts']).toBe(2)
    expect(readCounts['b.ts']).toBe(2)
    expect(requestedTools).toEqual([
      ['read_file', 'write_file'],
      ['read_file', 'write_file'],
      ['read_file', 'write_file'],
      ['read_file', 'write_file'],
    ])
    expect(events.find((event) => event.type === 'done')?.content).toBe('Both files were re-read after the write.')
  })

  it('still stops after an unchanged repeated read batch', async () => {
    const registry = new ToolRegistry()
    const readCounts: Record<string, number> = {}
    registry.register({
      definition: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
      execute: async (params: { path?: string }) => {
        const path = String(params.path)
        readCounts[path] = (readCounts[path] || 0) + 1
        return `${path} content`
      },
    })
    const requestedTools: Array<string[] | undefined> = []
    let request = 0
    const provider = {
      id: 'test-provider', name: 'Test provider', type: 'custom' as const, supportsReasoning: () => false,
      chat: (params: { tools?: Array<{ name: string }> }) => {
        request += 1
        requestedTools.push(params.tools?.map((tool) => tool.name))
        if (request <= 2) {
          return chunks({
            content: '', finishReason: 'tool_calls',
            toolCalls: [
              { index: 0, id: `read-a-${request}`, name: 'read_file', arguments: '{"path":"a.ts"}' },
              { index: 1, id: `read-b-${request}`, name: 'read_file', arguments: '{"path":"b.ts"}' },
            ],
          })
        }
        return chunks({ content: 'The two files were already read.', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: ['read_file'], maxIterations: 6 },
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
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: '查看 a.ts 和 b.ts。', timestamp: Date.now() },
    })) events.push(event)

    expect(readCounts['a.ts']).toBe(1)
    expect(readCounts['b.ts']).toBe(1)
    expect(requestedTools).toEqual([['read_file'], ['read_file'], undefined])
    expect(events.find((event) => event.type === 'done')?.content).toBe('The two files were already read.')
  })

  it('still stops after an unchanged repeated write batch', async () => {
    const registry = new ToolRegistry()
    let writeExecutions = 0
    registry.register({
      definition: { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } },
      execute: async () => {
        writeExecutions += 1
        return JSON.stringify({ status: 'ok' })
      },
    })
    const requestedTools: Array<string[] | undefined> = []
    let request = 0
    const provider = {
      id: 'test-provider', name: 'Test provider', type: 'custom' as const, supportsReasoning: () => false,
      chat: (params: { tools?: Array<{ name: string }> }) => {
        request += 1
        requestedTools.push(params.tools?.map((tool) => tool.name))
        if (request <= 2) {
          return chunks({ content: '', finishReason: 'tool_calls', toolCalls: [{ index: 0, id: `write-${request}`, name: 'write_file', arguments: '{"path":"a.ts","content":"version 2"}' }] })
        }
        return chunks({ content: 'The write was already applied.', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: { ...agent, tools: ['write_file'], maxIterations: 6 },
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
      newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: '写入 a.ts。', timestamp: Date.now() },
    })) events.push(event)

    expect(writeExecutions).toBe(2)
    expect(requestedTools).toEqual([['write_file'], ['write_file'], undefined])
    expect(events.find((event) => event.type === 'done')?.content).toBe('The write was already applied.')
  })
})
