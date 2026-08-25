import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron-store and electron before importing providers
vi.mock('electron-store', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      get: vi.fn().mockReturnValue([]),
      set: vi.fn(),
      store: {},
    })),
  }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/tmp/eva-test') },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
}))

import { ProviderRegistry, createProvider } from '../../src/main/providers'
import { OpenAIProvider } from '../../src/main/providers/openai'
import type { LLMProviderConfig } from '../../src/shared/types/provider'

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry

  beforeEach(() => {
    registry = new ProviderRegistry()
  })

  const makeConfig = (overrides?: Partial<LLMProviderConfig>): LLMProviderConfig => ({
    id: 'test-provider',
    name: 'Test',
    type: 'openai',
    apiKey: 'test-api-key',
    models: [],
    defaultModel: 'gpt-4o',
    isEnabled: true,
    ...overrides,
  })

  it('should register and retrieve a provider', () => {
    registry.register(makeConfig())
    const provider = registry.get('test-provider')
    expect(provider).toBeDefined()
  })

  it('should return undefined for unregistered provider', () => {
    expect(registry.get('nonexistent')).toBeUndefined()
  })

  it('should list registered provider IDs', () => {
    registry.register(makeConfig({ id: 'p1' }))
    registry.register(makeConfig({ id: 'p2', type: 'anthropic' }))
    const list = registry.list()
    expect(list).toContain('p1')
    expect(list).toContain('p2')
    expect(list.length).toBe(2)
  })

  it('should unregister a provider', () => {
    registry.register(makeConfig({ id: 'to-remove' }))
    expect(registry.get('to-remove')).toBeDefined()
    registry.unregister('to-remove')
    expect(registry.get('to-remove')).toBeUndefined()
  })

  it('should not register disabled providers', () => {
    registry.register(makeConfig({ id: 'disabled', isEnabled: false }))
    expect(registry.get('disabled')).toBeUndefined()
  })

  it('should get default model', () => {
    registry.register(makeConfig({ id: 'with-model', defaultModel: 'gpt-4o-mini' }))
    expect(registry.getDefaultModel('with-model')).toBe('gpt-4o-mini')
  })

  it('registerAll should register multiple configs', () => {
    registry.registerAll([
      makeConfig({ id: 'a' }),
      makeConfig({ id: 'b', type: 'anthropic' }),
    ])
    expect(registry.list()).toEqual(expect.arrayContaining(['a', 'b']))
  })
})

describe('createProvider', () => {
  it('should create OpenAI provider for type=openai', () => {
    const provider = createProvider({
      id: 'oai',
      name: 'OpenAI',
      type: 'openai',
      apiKey: 'test-api-key',
      models: [],
      defaultModel: 'gpt-4o',
      isEnabled: true,
    })
    expect(provider).toBeDefined()
  })

  it('should create OpenAI-compatible provider for type=deepseek', () => {
    const provider = createProvider({
      id: 'ds',
      name: 'DeepSeek',
      type: 'deepseek',
      apiKey: 'ds-test',
      models: [],
      defaultModel: 'deepseek-chat',
      isEnabled: true,
    })
    expect(provider).toBeDefined()
  })

  it('should create Anthropic provider for type=anthropic', () => {
    const provider = createProvider({
      id: 'ant',
      name: 'Anthropic',
      type: 'anthropic',
      apiKey: 'ant-test',
      models: [],
      defaultModel: 'claude-3-sonnet',
      isEnabled: true,
    })
    expect(provider).toBeDefined()
  })

  it('should throw for unknown provider type', () => {
    expect(() =>
      createProvider({
        id: 'x',
        name: 'X',
        type: 'unknown' as any,
        apiKey: 'k',
        models: [],
        defaultModel: '',
        isEnabled: true,
      })
    ).toThrow('Unknown provider type')
  })
})

describe('OpenAIProvider streaming tool calls', () => {
  it('recognizes DeepSeek Reasoner as a reasoning-capable model', () => {
    const provider = new OpenAIProvider('test', 'Test', 'deepseek', { apiKey: 'test-key' })
    expect(provider.supportsReasoning('deepseek-reasoner')).toBe(true)
    expect(provider.supportsReasoning('deepseek-v4-flash-ga-260731')).toBe(true)
    expect(provider.supportsReasoning('deepseek-chat')).toBe(false)
  })

  it('recognizes DeepSeek V4 models behind an OpenAI-compatible gateway', () => {
    const provider = new OpenAIProvider('gateway', 'Volcano Coding Plan', 'custom', { apiKey: 'test-key' })
    expect(provider.supportsReasoning('deepseek-v4-flash-ga-260731')).toBe(true)
    expect(provider.supportsReasoning('deepseek-v4-pro')).toBe(true)
    expect(provider.supportsReasoning('gpt-4o')).toBe(false)
  })

  it('passes the thinking switch through a custom OpenAI-compatible gateway', async () => {
    async function* responseStream() {
      yield { choices: [{ delta: { reasoning_content: 'plan' }, finish_reason: null }] }
      yield { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }
    }

    const provider = new OpenAIProvider('gateway', 'Volcano Coding Plan', 'custom', { apiKey: 'test-key' })
    const create = vi.fn().mockResolvedValue(responseStream())
    ;(provider as any).client = { chat: { completions: { create } } }

    const chunks = []
    for await (const chunk of provider.chat({
      model: 'deepseek-v4-flash-ga-260731',
      messages: [],
      reasoning: { enabled: true, budgetTokens: 1024 },
    })) {
      chunks.push(chunk)
    }

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ thinking: { type: 'enabled' } }), expect.anything())
    expect(chunks.some((chunk) => chunk.reasoningContent === 'plan')).toBe(true)
  })

  it('emits one complete tool call instead of duplicating streamed arguments', async () => {
    async function* streamToolCall() {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  function: { name: 'write_file', arguments: '{"path":"notes/' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: 'story.md","content":"hello"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }
      yield {
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      }
    }

    const provider = new OpenAIProvider('test', 'Test', 'openai', { apiKey: 'test-key' })
    ;(provider as any).client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(streamToolCall()),
        },
      },
    }

    const chunks = []
    for await (const chunk of provider.chat({ model: 'test-model', messages: [], tools: [] })) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual([
      {
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [
          {
            index: 0,
            id: 'call_1',
            name: 'write_file',
            arguments: '{"path":"notes/story.md","content":"hello"}',
          },
        ],
      },
    ])
  })

  it('preserves a non-streaming length stop reason for callers that must reject partial artifacts', async () => {
    const provider = new OpenAIProvider('test', 'Test', 'openai', { apiKey: 'test-key' })
    ;(provider as any).client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{
              finish_reason: 'length',
              message: { content: 'partial document' },
            }],
          }),
        },
      },
    }

    const result = await provider.chatComplete({ model: 'test-model', messages: [] })

    expect(result).toMatchObject({ content: 'partial document', finishReason: 'length' })
  })
})
