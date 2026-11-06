import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({ fetch: vi.fn() }))
const storageMocks = vi.hoisted(() => ({ getStorage: vi.fn(), createProvider: vi.fn() }))

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/tmp/eva-test') },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
  net: { fetch: electronMocks.fetch },
}))

vi.mock('../../src/main/storage', () => ({ getStorage: storageMocks.getStorage }))
vi.mock('../../src/main/providers', () => ({ createProvider: storageMocks.createProvider }))

import { OpenAIProvider } from '../../src/main/providers/openai'
import { createImageGenerationTools } from '../../src/main/tools/image-generation-tools'
import type { ToolContext, ToolExecutionResult } from '../../src/main/tools'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])

describe('provider image generation', () => {
  beforeEach(() => electronMocks.fetch.mockReset())

  it('posts an image request and identifies the returned format from its bytes', async () => {
    electronMocks.fetch.mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: PNG.toString('base64'), revised_prompt: 'a clearer cat' }],
    }), { status: 200 }))
    const provider = new OpenAIProvider('img', 'Image gateway', 'custom', { apiKey: 'secret-key', baseUrl: 'https://img.example/v1' })

    const image = await provider.generateImage({ model: 'gpt-image-2', prompt: 'a cat', size: '1024x1024' })

    const [url, init] = electronMocks.fetch.mock.calls[0]
    expect(url).toBe('https://img.example/v1/images/generations')
    expect(init.headers.authorization).toBe('Bearer secret-key')
    expect(JSON.parse(init.body)).toMatchObject({ model: 'gpt-image-2', prompt: 'a cat', n: 1, size: '1024x1024', response_format: 'b64_json' })
    expect(image.mediaType).toBe('image/png')
    expect(image.revisedPrompt).toBe('a clearer cat')
    expect(Buffer.from(image.base64, 'base64').equals(PNG)).toBe(true)
  })

  it('downloads an image URL instead of trusting its headers', async () => {
    electronMocks.fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/image.jpg' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JPEG, { status: 200 }))

    const image = await new OpenAIProvider('img', 'Image gateway', 'openai', { apiKey: 'k', baseUrl: 'https://img.example/v1' })
      .generateImage({ model: 'img-1', prompt: 'a dog' })

    expect(electronMocks.fetch.mock.calls[1][0]).toBe('https://cdn.example/image.jpg')
    expect(image.mediaType).toBe('image/jpeg')
  })

  it('rejects data that is not an image', async () => {
    electronMocks.fetch.mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] }), { status: 200 }))
    await expect(new OpenAIProvider('img', 'Image gateway', 'openai', { apiKey: 'k' }).generateImage({ model: 'img-1', prompt: 'x' }))
      .rejects.toThrow(/not a PNG, JPEG, or WebP/)
  })

  it('reports an upstream failure without leaking credentials', async () => {
    electronMocks.fetch.mockResolvedValue(new Response('model not found', { status: 404 }))
    const error = await new OpenAIProvider('img', 'Image gateway', 'openai', { apiKey: 'secret-key' })
      .generateImage({ model: 'missing', prompt: 'x' })
      .catch((caught: unknown) => caught as Error)
    expect(error.message).toContain('HTTP 404')
    expect(error.message).toContain('model not found')
    expect(error.message).not.toContain('secret-key')
  })
})

describe('generate_image tool', () => {
  const tool = createImageGenerationTools()[0]
  const providerEntry = { id: 'img', name: 'Image gateway', type: 'custom' as const, apiKey: 'k', isEnabled: true, models: [] }

  function configure(route: { providerId: string; model: string } | undefined) {
    storageMocks.getStorage.mockReturnValue({
      config: {
        get: (key: string) => key === 'imageGeneration' ? route : undefined,
        getProviders: () => [providerEntry],
      },
    })
  }

  function contextWithPaths() {
    const written: Array<{ path: string; bytes: Buffer }> = []
    const context = {
      workspacePath: 'C:/workspace',
      fileService: {
        writeBuffer: async (filePath: string, content: Buffer) => { written.push({ path: filePath, bytes: content }) },
      },
    } as unknown as ToolContext
    return { context, written }
  }

  beforeEach(() => {
    storageMocks.getStorage.mockReset()
    storageMocks.createProvider.mockReset()
  })

  it('tells the model to configure a route instead of failing silently', async () => {
    configure(undefined)
    const result = await tool.execute({ prompt: 'a cat' }, contextWithPaths().context)
    expect(result).toContain('Settings > Model > Image generation')
  })

  it('saves the generated image inside the workspace and reports it inline', async () => {
    configure({ providerId: 'img', model: 'gpt-image-2' })
    storageMocks.createProvider.mockReturnValue({ generateImage: async () => ({ base64: PNG.toString('base64'), mediaType: 'image/png' }) })
    const { context, written } = contextWithPaths()

    const result = await tool.execute({ prompt: 'a cat' }, context) as ToolExecutionResult

    expect(storageMocks.createProvider).toHaveBeenCalledWith(expect.objectContaining({ id: 'img', apiKey: 'k' }))
    expect(written).toHaveLength(1)
    expect(written[0].path).toMatch(/^\.eva[\\/]generated-images[\\/]image-\d{14}-[a-f0-9]{8}\.png$/)
    expect(written[0].bytes.equals(PNG)).toBe(true)
    expect(result.images).toEqual([{ path: expect.stringContaining('image-'), name: expect.stringMatching(/\.png$/), mediaType: 'image/png' }])
    expect(result.protocol).toMatchObject({ kind: 'action', status: 'applied', data: { model: 'gpt-image-2', providerId: 'img' } })
  })

  it('appends the extension a requested path is missing', async () => {
    configure({ providerId: 'img', model: 'gpt-image-2' })
    storageMocks.createProvider.mockReturnValue({ generateImage: async () => ({ base64: PNG.toString('base64'), mediaType: 'image/png' }) })
    const { context, written } = contextWithPaths()

    await tool.execute({ prompt: 'a cat', path: 'assets/hero' }, context)

    expect(written[0].path).toBe('assets/hero.png')
  })

  it('refuses a connection without an image endpoint', async () => {
    configure({ providerId: 'img', model: 'gpt-image-2' })
    storageMocks.createProvider.mockReturnValue({})
    const result = await tool.execute({ prompt: 'a cat' }, contextWithPaths().context)
    expect(result).toContain('does not expose an image-generation endpoint')
  })

  it('rejects an unsupported size before calling the provider', async () => {
    configure({ providerId: 'img', model: 'gpt-image-2' })
    const result = await tool.execute({ prompt: 'a cat', size: 'huge' }, contextWithPaths().context)
    expect(result).toContain('1024x1024')
    expect(storageMocks.createProvider).not.toHaveBeenCalled()
  })
})
