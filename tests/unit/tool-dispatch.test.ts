import { describe, expect, it, vi } from 'vitest'
import { AgentRunner } from '../../src/main/agent-engine/agent-runner'
import { ContextManager } from '../../src/main/agent-engine/context'
import { createExecutionEnvelope, ToolRegistry } from '../../src/main/tools'
import { buildToolIndex, parseDispatchCalls, resolveDispatchArguments, validateToolArguments } from '../../src/main/agent-engine/tool-dispatch'
import type { AgentConfig } from '../../src/shared/types/agent'
import type { ChatChunk } from '../../src/shared/types/provider'

vi.mock('../../src/main/services/usage-pricing-service', () => ({
  resolveConnectionPricingMode: () => ({}),
  resolveRateCardUsageCost: () => ({}),
}))

function chunks(...items: ChatChunk[]): AsyncIterable<ChatChunk> {
  return { async *[Symbol.asyncIterator]() { yield* items } }
}

const agent: AgentConfig = {
  id: 'dispatch-agent', name: 'Dispatch agent', description: 'Test agent', role: 'coder', systemPrompt: '',
  model: 'test-model', providerId: 'test-provider', tools: ['list_directory', 'read_file'], maxIterations: 2,
  temperature: 0, isBuiltIn: false, createdAt: 0, updatedAt: 0,
}

describe('tool dispatch', () => {
  it('builds a compact index without embedding full schemas', () => {
    const index = buildToolIndex([{ name: 'read_file', description: 'Read a specific file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }])
    expect(index).toContain('read_file')
    expect(index).toContain('params: path')
    expect(index).not.toContain('"properties"')
  })

  it('validates dispatch calls and resolves only structured dependency data', () => {
    const parsed = parseDispatchCalls({ calls: [
      { id: 'find', name: 'search_files', arguments: { pattern: 'project.godot' } },
      { id: 'read', name: 'read_file', dependsOn: ['find'], arguments: { path: { $ref: 'find.data.matches.0' } } },
    ] }, new Set(['search_files', 'read_file']))
    expect(parsed.error).toBeUndefined()
    const resolved = resolveDispatchArguments(parsed.calls![1].arguments, new Map([
      ['find', { id: 'find', data: { matches: ['D:\\GameDev\\project.godot'] } }],
    ]))
    expect(resolved).toEqual({ path: 'D:\\GameDev\\project.godot' })
    expect(parseDispatchCalls({ calls: [{ id: 'x', name: 'execute_command', arguments: {} }] }, new Set(['read_file'])).error).toContain('not available')
    expect(validateToolArguments({ path: 42 }, { name: 'read_file', description: '', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } })).toContain('must be a string')
  })

  it('normalizes JSON-encoded nested arguments from model gateways', () => {
    const parsed = parseDispatchCalls({ calls: [
      { id: 'search', name: 'web_search', arguments: '{"query":"AI model release dates","maxResults":8}' },
    ] }, new Set(['web_search']))

    expect(parsed.error).toBeUndefined()
    expect(parsed.calls).toEqual([{
      id: 'search',
      name: 'web_search',
      arguments: { query: 'AI model release dates', maxResults: 8 },
      dependsOn: [],
    }])
  })

  it('allows one dependency-driven local follow-up, then synthesizes', async () => {
    const registry = new ToolRegistry()
    const executionOrder: string[] = []
    registry.register({
      definition: { name: 'list_directory', description: 'List files.', parameters: { type: 'object' } },
      execute: async () => {
        executionOrder.push('list_directory')
        return { content: 'project.godot', protocol: createExecutionEnvelope('observation', 'observed', { projectPath: 'D:\\GameDev\\project.godot' }) }
      },
    })
    registry.register({
      definition: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
      execute: async (params) => {
        executionOrder.push(`read_file:${params.path}`)
        return 'config_version=5'
      },
    })

    const requestedTools: Array<string[] | undefined> = []
    let request = 0
    const provider = {
      id: 'test-provider', name: 'Test provider', type: 'custom' as const, supportsReasoning: () => false,
      chat: (params: { tools?: Array<{ name: string }> }) => {
        requestedTools.push(params.tools?.map((tool) => tool.name))
        request += 1
        return request === 1
          ? chunks({
              content: '', finishReason: 'tool_calls',
              toolCalls: [{ index: 0, id: 'find', name: 'list_directory', arguments: JSON.stringify({ path: 'D:\\GameDev' }) }],
            })
          : request === 2
            ? chunks({ content: '', finishReason: 'tool_calls', toolCalls: [{ index: 0, id: 'read', name: 'read_file', arguments: JSON.stringify({ path: 'D:\\GameDev\\project.godot' }) }] })
            : chunks({ content: 'Found the project.', finishReason: 'stop' })
      },
    }
    const runner = new AgentRunner({
      agentConfig: agent, provider: provider as never, toolRegistry: registry, contextManager: new ContextManager(),
      workspacePath: 'D:\\workspace', fileService: {} as never, terminalService: {} as never,
    })

    const events = []
    for await (const event of runner.run({
      messages: [], newMessage: { id: 'message', conversationId: 'conversation', role: 'user', content: 'Find and inspect the project.', timestamp: Date.now() },
    })) events.push(event)

    expect(requestedTools).toEqual([['list_directory', 'read_file'], ['list_directory', 'read_file'], undefined])
    expect(executionOrder).toEqual(['list_directory', 'read_file:D:\\GameDev\\project.godot'])
    expect(events.findIndex((event) => event.type === 'tool_call')).toBeLessThan(events.findIndex((event) => event.type === 'tool_result'))
    expect(events.find((event) => event.type === 'done')?.content).toBe('Found the project.')
  })
})
