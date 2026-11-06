import path from 'path'
import { randomUUID } from 'crypto'
import { createExecutionEnvelope, type ToolContext, type ToolExecutionResult, type ToolExecutor } from './index'
import { createProvider } from '../providers'
import { getStorage } from '../storage'

const OUTPUT_DIRECTORY = path.join('.eva', 'generated-images')
const MAX_PROMPT_CHARS = 8_000
const SIZE_PATTERN = /^(?:auto|\d{2,5}x\d{2,5})$/i
const EXTENSION_BY_MEDIA_TYPE = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
} as const

/** One generated file, named so repeated generations in a run never collide. */
function outputPathFor(context: ToolContext, requestedPath: string | undefined, mediaType: keyof typeof EXTENSION_BY_MEDIA_TYPE): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const fallback = path.join(OUTPUT_DIRECTORY, `image-${stamp}-${randomUUID().slice(0, 8)}${EXTENSION_BY_MEDIA_TYPE[mediaType]}`)
  const candidate = requestedPath?.trim()
  if (!candidate) return fallback
  return path.extname(candidate) ? candidate : `${candidate}${EXTENSION_BY_MEDIA_TYPE[mediaType]}`
}

export function createImageGenerationTools(): ToolExecutor[] {
  return [{
    definition: {
      name: 'generate_image',
      description: 'Generate one image from a text description. Use it when the user asks for a picture, illustration, icon, poster, or any visual asset. The image is saved into the workspace and shown to the user in the conversation. Requires an image-generation connection configured in Settings.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Detailed description of the desired image: subject, style, composition, lighting, and text to render.' },
          path: { type: 'string', description: 'Optional output path relative to the workspace. Defaults to .eva/generated-images/ with a generated name.' },
          size: { type: 'string', description: 'Optional output size in <width>x<height> form, for example 1024x1024, 1536x1024, or 1024x1536. Omit to use the model default.' },
        },
        required: ['prompt'],
      },
    },
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<string | ToolExecutionResult> {
      const prompt = String(params.prompt || '').trim()
      const requestedSize = typeof params.size === 'string' ? params.size.trim() : ''
      const requestedPath = typeof params.path === 'string' ? params.path : undefined
      if (!prompt) return 'generate_image requires a non-empty prompt.'
      if (prompt.length > MAX_PROMPT_CHARS) return `The prompt is too long; keep it under ${MAX_PROMPT_CHARS} characters.`
      if (requestedSize && !SIZE_PATTERN.test(requestedSize)) return 'The size must be "auto" or a <width>x<height> value such as 1024x1024.'
      if (!context.workspacePath) return 'Image generation needs a workspace so the generated file has an authorized location.'

      const route = getStorage().config.get('imageGeneration')
      if (!route?.providerId?.trim() || !route.model?.trim()) {
        return 'No image-generation model is configured. Ask the user to choose a connection and model under Settings > Model > Image generation, then retry.'
      }

      const providerConfig = getStorage().config.getProviders().find((provider) => provider.id === route.providerId)
      if (!providerConfig) return `The configured image connection "${route.providerId}" no longer exists. Ask the user to update Settings > Model > Image generation.`

      const provider = createProvider({
        id: providerConfig.id,
        name: providerConfig.name,
        type: providerConfig.type,
        apiKey: providerConfig.apiKey,
        baseUrl: providerConfig.baseUrl,
        defaultModel: route.model,
        models: [],
        isEnabled: true,
      })
      if (!provider.generateImage) {
        return `The configured connection "${providerConfig.name}" does not expose an image-generation endpoint. Ask the user to choose an OpenAI-compatible image connection in Settings.`
      }

      const startedAt = Date.now()
      let image
      try {
        image = await provider.generateImage(
          { model: route.model, prompt, ...(requestedSize ? { size: requestedSize } : {}) },
          context.signal,
        )
      } catch (error) {
        return `Image generation failed: ${error instanceof Error ? error.message : String(error)}`
      }

      const relativePath = outputPathFor(context, requestedPath, image.mediaType)
      const buffer = Buffer.from(image.base64, 'base64')
      try {
        if (context.fileService.writeBuffer) {
          await context.fileService.writeBuffer(relativePath, buffer, context.workspacePath, context.fileAccessGrants, context.fullFilesystemAccess)
        } else {
          return 'This runtime cannot save generated images.'
        }
      } catch (error) {
        return `The image was generated but could not be saved: ${error instanceof Error ? error.message : String(error)}`
      }

      const absolutePath = path.isAbsolute(relativePath) ? relativePath : path.resolve(context.workspacePath, relativePath)
      const displayPath = path.relative(context.workspacePath, absolutePath) || absolutePath
      const modelLabel = `${providerConfig.name} / ${route.model}`
      return {
        content: [
          `Generated image with ${modelLabel} and saved it to ${displayPath}.`,
          image.revisedPrompt ? `The provider revised the prompt to: ${image.revisedPrompt}` : '',
          'The image is displayed to the user in this conversation.',
        ].filter(Boolean).join('\n'),
        images: [{ path: absolutePath, name: path.basename(absolutePath), mediaType: image.mediaType }],
        protocol: createExecutionEnvelope('action', 'applied', {
          path: absolutePath,
          mediaType: image.mediaType,
          model: route.model,
          providerId: providerConfig.id,
          prompt,
          size: requestedSize || undefined,
          durationMs: Date.now() - startedAt,
        }),
      }
    },
  }]
}
