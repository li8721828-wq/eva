import { describe, expect, it, vi } from 'vitest'
import { AgentRunner } from '../../src/main/agent-engine/agent-runner'
import { ContextManager } from '../../src/main/agent-engine/context'
import { ToolRegistry } from '../../src/main/tools'
import type { AgentConfig } from '../../src/shared/types/agent'
import type { ChatChunk, ChatMessageInput } from '../../src/shared/types/provider'

vi.mock('../../src/main/services/usage-pricing-service', () => ({
  resolveConnectionPricingMode: () => ({}),
  resolveRateCardUsageCost: () => ({}),
}))

vi.mock('../../src/main/services/supplier-pricing-service', () => ({
  ensureProviderPricing: () => new Promise<void>(() => undefined),
}))

function chunks(...items: ChatChunk[]): AsyncIterable<ChatChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* items
    },
  }
}

const image = {
  path: 'C:/reference/sketch.png',
  name: 'sketch.png',
  mediaType: 'image/png' as const,
  size: 2048,
  dataUrl: 'data:image/png;base64,aGVsbG8=',
}

async function firstModelRequest(
  providerType: 'openai' | 'deepseek' | 'custom' | 'anthropic',
  model: string,
  providerRegistry?: { getModelCapabilities: (providerId: string, modelId: string) => never },
): Promise<ChatMessageInput[]> {
  const chat = vi.fn(() => chunks({ content: '看到了。', finishReason: 'stop' }))
  const provider = { id: 'test-provider', name: 'Test provider', type: providerType, supportsReasoning: () => false, chat }
  const agentConfig: AgentConfig = {
    id: 'image-input-agent',
    name: 'Image input agent',
    description: 'Test agent',
    role: 'coder',
    systemPrompt: 'Answer briefly.',
    model,
    providerId: 'test-provider',
    tools: [],
    maxIterations: 2,
    temperature: 0,
    isBuiltIn: false,
    createdAt: 0,
    updatedAt: 0,
  }
  const runner = new AgentRunner({
    agentConfig,
    provider: provider as never,
    ...(providerRegistry ? { providerRegistry: providerRegistry as never } : {}),
    toolRegistry: new ToolRegistry(),
    contextManager: new ContextManager(),
    workspacePath: 'D:\\workspace',
    fileService: {} as never,
    terminalService: {} as never,
  })
  for await (const _event of runner.run({
    messages: [],
    newMessage: {
      id: 'message', conversationId: 'conversation', role: 'user', content: '这张图里是什么？',
      images: [image], timestamp: Date.now(),
    } as never,
  })) { /* drain */ }
  expect(chat).toHaveBeenCalledTimes(1)
  return chat.mock.calls[0][0].messages
}

describe('AgentRunner image input gate', () => {
  it('sends pixels to a DeepSeek route whose profile marks vision', async () => {
    const messages = await firstModelRequest('deepseek', 'deepseek-v4-flash-vision-exp')
    expect(messages.at(-1)?.images?.[0]?.dataUrl).toBe(image.dataUrl)
  })

  it('strips pixels for the text-only checkpoint of the same family', async () => {
    const messages = await firstModelRequest('deepseek', 'deepseek-v4-flash')
    expect(messages.at(-1)?.images).toBeUndefined()
  })

  it('follows a declared capability on an unknown custom gateway', async () => {
    const profile = {
      providerType: 'custom' as const,
      modelId: 'gateway-model',
      protocol: 'unknown' as const,
      supportsVision: true,
      contextWindowTokens: 128_000,
      source: 'declared' as const,
      checkedAt: 0,
    }
    const providerRegistry = { getModelCapabilities: () => profile as never }
    const declared = await firstModelRequest('custom', 'gateway-model', providerRegistry)
    expect(declared.at(-1)?.images?.[0]?.dataUrl).toBe(image.dataUrl)
    const unprofiled = await firstModelRequest('custom', 'gateway-model')
    expect(unprofiled.at(-1)?.images).toBeUndefined()
  })

  it('keeps the Anthropic family able to read images without a declaration', async () => {
    const messages = await firstModelRequest('anthropic', 'claude-opus-4-6-thinking')
    expect(messages.at(-1)?.images?.[0]?.dataUrl).toBe(image.dataUrl)
  })
})
