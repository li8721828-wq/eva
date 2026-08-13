import type { ChatMessageInput } from '../../shared/types/provider'
import { MODEL_CAPABILITIES, type ModelCapability } from '../../shared/types/model-pool'
import type { ProviderRegistry } from '../providers'
import { getStorage } from '../storage'
import { ModelRouter } from '../services/model-router'
import { modelHealthService } from '../services/model-health-service'
import { createExecutionEnvelope, type ToolContext, type ToolExecutionResult, type ToolExecutor } from './index'
import fs from 'fs'
import path from 'path'

const MAX_SUBTASK_CHARS = 16_000
const MAX_RESULT_CHARS = 24_000

export function createModelPoolTools(providerRegistry: ProviderRegistry): ToolExecutor[] {
  return [{
    definition: {
      name: 'delegate_to_model_pool',
      description: 'Delegate one bounded subtask to an authorized model pool. The owning Agent automatically shares its recent task context, tool results, and available images. Vision/Image routes receive images by default; set includeImages=false to omit them. Text-only routes receive the same context as text.',
      parameters: {
        type: 'object',
        properties: {
          poolId: { type: 'string', description: 'Authorized model pool ID selected for this agent.' },
          capability: { type: 'string', enum: MODEL_CAPABILITIES, description: 'Required model capability.' },
          task: { type: 'string', description: 'Self-contained subtask and required output format.' },
          includeImages: { type: 'boolean', description: 'Optional override. Vision/Image routes include Agent images by default; set false to omit them.' },
        },
        required: ['poolId', 'capability', 'task'],
      },
    },
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<string | ToolExecutionResult> {
      const poolId = String(params.poolId || '').trim()
      const capability = String(params.capability || '').trim() as ModelCapability
      const task = String(params.task || '').trim()
      const includeImages = params.includeImages !== false
      if (!context.allowedModelPoolIds?.includes(poolId)) return `Model pool "${poolId}" is not authorized for this agent.`
      if (!MODEL_CAPABILITIES.includes(capability)) return 'Choose a supported model capability.'
      if (!task) return 'A self-contained subtask is required.'
      const imageCapability = capability === 'vision' || capability === 'image'
      const router = new ModelRouter(getStorage().config.get('modelPools'), (entry) => Boolean(providerRegistry.get(entry.providerId)))
      const route = router.resolve({ poolId, capability })
      const candidates = [route.primary, ...route.fallbacks].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      if (!candidates.length) return `No available ${capability} model is configured in pool "${poolId}".`
      const images = imageCapability && includeImages ? await loadVisualAttachments(context.visualAttachments) : undefined
      const contextBlock = context.agentContext?.trim() || '(No additional Agent context was available.)'
      const messages: ChatMessageInput[] = [
        { role: 'system', content: 'You are a delegated specialist inside an owning Eva Agent. Complete only the assigned subtask using the supplied Agent context and images. Do not claim to have used files, tools, browsers, terminals, or external services yourself. Distinguish observed tool results from inferences and return JSON when possible: {"status":"verified|unknown|rejected","summary":"...","confidence":0-1,"observations":["..."],"proposedAction":{"tool":"...","arguments":{},"reason":"...","expectedState":{}}}. Never present a proposed action as executed.' },
        { role: 'user', content: `Assigned subtask:\n${task.slice(0, MAX_SUBTASK_CHARS)}\n\nOwning Agent context:\n${contextBlock}`, images },
      ]
      const errors: string[] = []
      for (const entry of candidates) {
        const provider = providerRegistry.get(entry.providerId)
        if (!provider) continue
        try {
          const startedAt = Date.now()
          const response = await provider.chatComplete({ model: entry.model, messages, temperature: 0.3, maxTokens: 4096 })
          if (!response.content.trim()) throw new Error('Model returned an empty response.')
          modelHealthService.recordSuccess(entry.id, Date.now() - startedAt)
          const parsed = parsePoolResponse(response.content)
          const text = `Delegated to ${entry.name} (${entry.providerId} / ${entry.model})\n\n${parsed.summary}`
          return {
            content: text,
            protocol: createExecutionEnvelope('analysis', parsed.status, {
              poolId,
              modelEntryId: entry.id,
              capability,
              summary: parsed.summary,
              confidence: parsed.confidence,
              observations: parsed.observations,
            }, {
              evidence: [
                { type: imageCapability && images?.length ? 'model' : 'structured', summary: parsed.summary, confidence: parsed.confidence },
              ],
              proposedAction: parsed.proposedAction,
              nextAction: parsed.nextAction,
            }),
          }
        } catch (error) {
          modelHealthService.recordFailure(entry.id)
          errors.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return `All routed models failed for pool "${poolId}".\n${errors.join('\n')}`
    },
  }]
}

interface ParsedPoolResponse {
  status: 'verified' | 'unknown' | 'rejected'
  summary: string
  confidence?: number
  observations?: string[]
  proposedAction?: { tool: string; arguments: Record<string, unknown>; reason: string; expectedState?: Record<string, unknown>; confidence?: number }
  nextAction?: { tool: string; arguments: Record<string, unknown>; reason: string; expectedState?: Record<string, unknown>; confidence?: number }
}

function parsePoolResponse(raw: string): ParsedPoolResponse {
  const summary = raw.trim().slice(0, MAX_RESULT_CHARS)
  const match = summary.match(/\{[\s\S]*\}/)
  if (!match) return { status: 'unknown', summary }
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>
    const status = parsed.status === 'verified' || parsed.status === 'rejected' ? parsed.status : 'unknown'
    const observations = Array.isArray(parsed.observations) ? parsed.observations.filter((item): item is string => typeof item === 'string').slice(0, 20) : undefined
    const confidence = typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence) ? Math.max(0, Math.min(1, parsed.confidence)) : undefined
    const normalizeAction = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
      const action = value as Record<string, unknown>
      if (typeof action.tool !== 'string' || !action.tool.trim() || !action.arguments || typeof action.arguments !== 'object' || Array.isArray(action.arguments)) return undefined
      return { tool: action.tool, arguments: action.arguments as Record<string, unknown>, reason: typeof action.reason === 'string' ? action.reason : 'No reason provided.', expectedState: action.expectedState && typeof action.expectedState === 'object' && !Array.isArray(action.expectedState) ? action.expectedState as Record<string, unknown> : undefined, confidence: typeof action.confidence === 'number' ? Math.max(0, Math.min(1, action.confidence)) : undefined }
    }
    return { status, summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, MAX_RESULT_CHARS) : summary, confidence, observations, proposedAction: normalizeAction(parsed.proposedAction), nextAction: normalizeAction(parsed.nextAction) }
  } catch {
    return { status: 'unknown', summary }
  }
}

async function loadVisualAttachments(attachments: ToolContext['visualAttachments']): Promise<NonNullable<ChatMessageInput['images']>> {
  const loaded: NonNullable<ChatMessageInput['images']> = []
  for (const attachment of attachments || []) {
    try {
      const stat = await fs.promises.stat(attachment.path)
      if (!stat.isFile() || stat.size <= 0 || stat.size > 32 * 1024 * 1024) continue
      const data = await fs.promises.readFile(attachment.path)
      loaded.push({
        name: attachment.name || path.basename(attachment.path),
        mediaType: attachment.mediaType,
        dataUrl: `data:${attachment.mediaType};base64,${data.toString('base64')}`,
      })
      if (loaded.length >= 4) break
    } catch {
      // Tool output may be cleaned up between calls; skip unavailable images.
    }
  }
  return loaded
}
