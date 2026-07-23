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
    apiKey: 'sk-test-key',
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
      apiKey: 'sk-test',
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
