import type { LLMProvider } from '../providers/base-provider'
import fs from 'fs'
import path from 'path'
import type { ToolExecutor, ToolContext, ToolRegistry, FileService, TerminalService, ToolResultImage } from '../tools'
import type { AgentConfig, AgentEvent } from '../../shared/types/agent'
import type { ChatMessage, ChatUsage } from '../../shared/types/conversation'
import type { ToolDefinition, ChatMessageInput, ChatChunk } from '../../shared/types/provider'
import { ContextManager } from './context'
import { DEFAULT_MAX_ITERATIONS, getModelInputBudgetTokens } from '../../shared/constants'
import type { FileAccessGrant } from '../../shared/types/file-access'
import type { ModelPoolEntry } from '../../shared/types/model-pool'
import type { ExecutionEnvelope } from '../../shared/types/execution-protocol'
import { getStorage } from '../storage'
import { providerRegistry } from '../providers'
import { ModelRouter } from '../services/model-router'
import { modelHealthService } from '../services/model-health-service'

export interface AgentRunnerConfig {
  conversationId?: string
  agentConfig: AgentConfig
  provider: LLMProvider
  toolRegistry: ToolRegistry
  contextManager: ContextManager
  maxIterations?: number
  workspacePath: string
  fileAccessGrants?: FileAccessGrant[]
  fullFilesystemAccess?: boolean
  fileService: FileService
  terminalService: TerminalService
  requestToolApproval?: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>
  /** Optional exact paths an otherwise permitted file-editing call may modify. */
  allowedWritePaths?: string[]
  /** Internal orchestration capability available in Auto conversations. */
  delegateToTeam?: (goal: string) => Promise<string>
  runTask?: (task: string) => Promise<string>
  runGoal?: (goal: string) => Promise<string>
  manageGoal?: (action: 'status' | 'pause' | 'resume' | 'cancel') => Promise<string>
  createExecutionPlan?: (goal: string) => Promise<string>
  applySpecTemplate?: (templateId: string, parameters: Record<string, string>) => Promise<string>
  /** Goal-only budget that can grow after the model explicitly asks for more evidence. */
  adaptiveToolBudget?: AdaptiveToolBudget
}

export interface AdaptiveToolBudget {
  /** Initial number of model/tool cycles before the first continuation check. */
  initialIterations: number
  /** Additional cycles granted after each justified continuation. */
  extensionIterations: number
  /** Absolute cap for this run. It may not exceed the Agent configuration. */
  maxIterations: number
}

export interface ToolApprovalRequest {
  toolCall: {
    id: string
    name: string
    arguments: Record<string, unknown>
  }
  workspacePath: string
}

export interface ToolApprovalDecision {
  approved: boolean
  message?: string
}

export interface RunParams {
  messages: ChatMessage[]
  newMessage: ChatMessage
}

interface CompletedToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

interface CompletedToolResult {
  result: string
  isError: boolean
  images?: ToolResultImage[]
  protocol?: ExecutionEnvelope
}

const MAX_TOOL_REVIEW_IMAGES = 4
const PARALLEL_SAFE_READ_TOOL_NAMES = new Set(['read_file', 'list_directory', 'search_files', 'web_search', 'read_web_page'])
// A complete virtual desktop can include multiple high-resolution displays.
// Keep this distinct from ordinary user attachment limits so desktop_observe
// does not silently drop a valid multi-display PNG before visual analysis.
const MAX_TOOL_REVIEW_IMAGE_BYTES = 32 * 1024 * 1024
const TEAM_DELEGATION_TOOL: ToolDefinition = {
  name: 'delegate_to_team',
  description: 'Delegate a complex multi-step task to Eva\'s internal specialist team. Use this when work benefits from separate research, implementation, review, or testing. The team returns a consolidated result; do not ask the user to switch modes.',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'A complete, concrete task goal for the specialist team.' },
    },
    required: ['goal'],
  },
}
const GOAL_TOOL: ToolDefinition = {
  name: 'run_goal',
  description: 'Run a long-lived goal through Eva\'s internal goal planner. Use when the task requires a measurable multi-step outcome with progress evaluation and adaptation.',
  parameters: { type: 'object', properties: { goal: { type: 'string', description: 'Concrete outcome to achieve.' } }, required: ['goal'] },
}
const GOAL_CONTROL_TOOL: ToolDefinition = {
  name: 'manage_goal',
  description: 'Inspect or control the current conversation\'s Goal task. Use this when the user asks to check progress, pause, continue, or stop a Goal. Never claim a Goal was controlled without using this tool.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'pause', 'resume', 'cancel'], description: 'The Goal control action to perform.' },
    },
    required: ['action'],
  },
}
const TASK_TOOL: ToolDefinition = {
  name: 'run_task',
  description: 'Run one bounded implementation or investigation task through an isolated internal worker. The worker uses only this agent\'s existing tools and current workspace permissions.',
  parameters: { type: 'object', properties: { task: { type: 'string', description: 'A concrete, self-contained task to carry out.' } }, required: ['task'] },
}
const PLAN_TOOL: ToolDefinition = {
  name: 'create_execution_plan',
  description: 'Create a structured execution plan without carrying out changes. Use before broad, risky, or ambiguous work when a plan will help the current conversation.',
  parameters: { type: 'object', properties: { goal: { type: 'string', description: 'Objective to plan.' } }, required: ['goal'] },
}
const SPEC_TOOL: ToolDefinition = {
  name: 'apply_spec_template',
  description: 'Expand a reusable Eva specification template into an implementation brief. Use only when a matching template will add useful structure.',
  parameters: { type: 'object', properties: { templateId: { type: 'string', description: 'Template identifier.' }, parameters: { type: 'object', description: 'Template parameter values.' } }, required: ['templateId'] },
}

function modelPoolDelegationTool(allowedPoolIds?: string[]): ToolDefinition | undefined {
  if (!allowedPoolIds?.length) return undefined
  const pools = getStorage().config.get('modelPools').filter((pool) => allowedPoolIds.includes(pool.id))
  if (!pools.length) return undefined
  const availablePools = pools.map((pool) => `${pool.name} (id: ${pool.id}; capabilities: ${[...new Set(pool.entries.flatMap((entry) => entry.capabilities))].join(', ') || 'none'})`).join('; ')
  return {
    name: 'delegate_to_model_pool',
    description: `Delegate one bounded subtask to an authorized model pool. The owning Agent automatically shares recent task context, tool results, and available images. Vision/Image routes receive images by default; set includeImages=false to omit them. Delegated models cannot use files, terminal, browser, or desktop tools. Available pools: ${availablePools}.`,
    parameters: {
      type: 'object',
      properties: {
        poolId: { type: 'string', enum: pools.map((pool) => pool.id), description: 'Pool ID selected for this subtask.' },
        capability: { type: 'string', enum: ['language', 'reasoning', 'code', 'vision', 'image', 'video', 'embedding'], description: 'Required capability within the selected pool.' },
        task: { type: 'string', description: 'A self-contained subtask, relevant evidence, and desired answer format.' },
        includeImages: { type: 'boolean', description: 'Optional override. Vision/Image routes include Agent images by default; set false to omit them.' },
      },
      required: ['poolId', 'capability', 'task'],
    },
  }
}
export class AgentRunner {
  private config: AgentRunnerConfig
  private abortController: AbortController | null = null
  private isRunning = false

  constructor(config: AgentRunnerConfig) {
    this.config = config
  }

  /**
   * Execute the ReAct (Reason-Act) loop.
   *
   * Flow per iteration:
   *  1. Build/update context messages
   *  2. Stream LLM response → yield real-time text_delta events
   *  3. If no tool_calls → yield { type: 'done' } and stop
   *  4. If tool_calls → yield text (full reasoning), execute each tool,
   *     yield tool_call / tool_result events, append to history, loop
   *  5. Abort or max-iterations → stop
   */
  async *run(params: RunParams): AsyncGenerator<AgentEvent> {
    if (this.isRunning) {
      yield { type: 'error', error: 'AgentRunner is already running' }
      return
    }

    this.isRunning = true
    this.abortController = new AbortController()

    try {
      const { agentConfig, toolRegistry, contextManager, workspacePath, fileAccessGrants, fullFilesystemAccess } = this.config
      const configuredMaxIterations = this.config.maxIterations ?? agentConfig.maxIterations ?? DEFAULT_MAX_ITERATIONS
      const adaptiveToolBudget = this.config.adaptiveToolBudget
      const maxIter = adaptiveToolBudget
        ? Math.max(1, Math.min(configuredMaxIterations, adaptiveToolBudget.maxIterations))
        : configuredMaxIterations
      let nextBudgetCheck = adaptiveToolBudget
        ? Math.max(1, Math.min(maxIter, adaptiveToolBudget.initialIterations))
        : maxIter
      if (agentConfig.showThinking && !this.config.provider.supportsReasoning(agentConfig.model)) {
        yield {
          type: 'error',
          error: `无法显示模型思考：${agentConfig.providerId} / ${agentConfig.model} 不支持推理内容输出。请选择 DeepSeek Reasoner 或支持扩展思考的 Claude 模型，或关闭此选项。`,
        }
        return
      }

      // Tool definitions filtered by agent's allowed tool list
      const poolTool = agentConfig.tools.includes('delegate_to_model_pool') ? modelPoolDelegationTool(agentConfig.modelPoolIds) : undefined
      const toolDefs: ToolDefinition[] = [
        ...toolRegistry.getDefinitionsByNames(agentConfig.tools.filter((name) => name !== 'delegate_to_model_pool')),
        ...(poolTool ? [poolTool] : []),
        ...(this.config.delegateToTeam ? [TEAM_DELEGATION_TOOL] : []),
        ...(this.config.runTask ? [TASK_TOOL] : []),
        ...(this.config.runGoal ? [GOAL_TOOL] : []),
        ...(this.config.manageGoal ? [GOAL_CONTROL_TOOL] : []),
        ...(this.config.createExecutionPlan ? [PLAN_TOOL] : []),
        ...(this.config.applySpecTemplate ? [SPEC_TOOL] : []),
      ]

      // Build initial context: system prompt + history + new user message
      // Internal callers should pass ChatMessage, but normalize defensively so
      // a malformed legacy caller can never send a role-less API message.
      const candidateMessage = params.newMessage as unknown
      const userMessage: ChatMessage = typeof candidateMessage === 'string'
        ? {
            id: '__pending_user_msg__',
            conversationId: '',
            role: 'user',
            content: candidateMessage,
            timestamp: Date.now(),
          }
        : {
            ...params.newMessage,
            id: '__pending_user_msg__',
            role: params.newMessage.role || 'user',
            content: params.newMessage.content || '',
            timestamp: params.newMessage.timestamp || Date.now(),
          }
      const allHistory = [...params.messages, userMessage]
      const primarySupportsVision = this.supportsVisionInput()
      // Text-only OpenAI-compatible endpoints reject multimodal content with
      // an opaque deserialization error. Strip image payloads at the final
      // runner boundary even when a legacy/history path still contains them.
      const safeHistory = primarySupportsVision
        ? params.messages
        : params.messages.map((message) => message.images?.length ? { ...message, images: undefined } : message)
      const safeUserMessage = primarySupportsVision || !userMessage.images?.length
        ? userMessage
        : { ...userMessage, images: undefined }
      const safeAllHistory = [...safeHistory, safeUserMessage]
      const hasImageInput = allHistory.some((message) => message.images?.some((image) => Boolean(image.dataUrl)))
      // Repeated read-only requests are common when a model re-evaluates a tool
      // result. Reuse the result during one ReAct run instead of re-reading the
      // same file/page/search result over and over.
      const readOnlyToolCache = new Map<string, CompletedToolResult>()
      const pendingWriteVerifications = new Set<string>()
      let recentVisualAttachments: ToolResultImage[] = dedupeToolImages(
        allHistory.flatMap((message) => (message.images || []).map((image) => ({
          path: image.path,
          name: image.name,
          mediaType: image.mediaType,
        }))),
      ).slice(-8)
      let accumulatedUsage: ChatUsage | undefined

      let messages: ChatMessageInput[] = contextManager.buildContext({
        agentConfig,
        messages: safeAllHistory,
        workspacePath,
        fileAccessGrants,
        fullFilesystemAccess,
        maxContextTokens: getModelInputBudgetTokens(agentConfig.model),
        tools: toolDefs,
      })

      // ── ReAct loop ──────────────────────────────────────────────────────────
      for (let iteration = 0; iteration < maxIter; iteration++) {
        if (this.abortController.signal.aborted) {
          yield { type: 'done', content: '' }
          return
        }

        yield {
          type: 'thinking',
          content: iteration === 0 ? 'Preparing the response and any required tools...' : 'Reviewing the tool results...',
        }

        // Call LLM (yields real-time text_delta events to caller)
        const response = yield* this.executeLLMCall(messages, toolDefs)
        accumulatedUsage = this.mergeUsage(accumulatedUsage, response.usage)

        const hasToolCalls = response.toolCalls.length > 0

        // No tool calls → the model is done reasoning
        if (!hasToolCalls) {
          if (!response.content.trim()) {
            const imageHint = hasImageInput
              ? ` The conversation includes image input; select a vision-capable model before retrying.`
              : ''
            yield {
              type: 'error',
              error: `Model ${agentConfig.model} returned an empty response.${imageHint}`,
            }
            return
          }
          if (pendingWriteVerifications.size > 0 && toolDefs.some((tool) => tool.name === 'read_file') && iteration < maxIter - 1) {
            messages.push({ role: 'assistant', content: response.content })
            messages.push({
              role: 'user',
              content: `You wrote ${this.formatPaths(pendingWriteVerifications)} in this run but have not verified the saved contents. Before finalizing, call read_file for each changed path. Do not claim the file is correct or complete until that verification succeeds.`,
            })
            continue
          }
          yield { type: 'done', content: response.content, usage: accumulatedUsage }
          return
        }

        // A model may request several independent reads in one turn. Execute
        // only a wholly read-only batch in parallel; any mutation, terminal,
        // browser, or desktop action keeps the original strict ordering.
        const toolResults = new Map<string, CompletedToolResult>()
        const parallelReadBatch = response.toolCalls.length > 1
          && response.toolCalls.every((toolCall) => PARALLEL_SAFE_READ_TOOL_NAMES.has(toolCall.name))
        if (parallelReadBatch) {
          const visualAttachments = dedupeToolImages(recentVisualAttachments)
          const baseContext: ToolContext = {
            conversationId: this.config.conversationId,
            workspacePath,
            fileAccessGrants,
            fullFilesystemAccess,
            supportsVisionInput: this.supportsVisionInput(),
            fileService: this.config.fileService,
            terminalService: this.config.terminalService,
            allowedModelPoolIds: agentConfig.modelPoolIds,
            visualAttachments,
            agentContext: this.buildModelPoolContext(messages, toolResults),
          }
          for (const toolCall of response.toolCalls) {
            yield {
              type: 'tool_call',
              toolCall: { id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments },
            }
          }
          const completedBatch = await Promise.all(response.toolCalls.map(async (toolCall) => {
            const cacheKey = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`
            const cached = readOnlyToolCache.get(cacheKey)
            const rawResult = cached || await this.executeTool(toolCall, baseContext)
            const result = cached || this.normalizeToolResult(rawResult)
            if (!cached) readOnlyToolCache.set(cacheKey, result)
            return { toolCall, result }
          }))
          for (const { toolCall, result } of completedBatch) {
            toolResults.set(toolCall.id, result)
            yield {
              type: 'tool_result',
              toolResult: {
                toolCallId: toolCall.id,
                name: toolCall.name,
                result: result.result,
                isError: result.isError,
                protocol: result.protocol,
              },
            }
          }
        } else {
          let desktopActionExecuted = false
          for (const toolCall of response.toolCalls) {
          // Emit tool_call event
          yield {
            type: 'tool_call',
            toolCall: {
              id: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.arguments,
            },
          }

          const isDesktopAction = toolCall.name === 'mouse_control' || toolCall.name === 'keyboard_control'
          if (isDesktopAction && desktopActionExecuted) {
            const deferredResult: CompletedToolResult = {
              result: 'Deferred: a desktop action already ran in this cycle. Inspect its automatic post-action screenshot and model-pool visual analysis before choosing the next desktop action.',
              isError: false,
            }
            toolResults.set(toolCall.id, deferredResult)
            yield {
              type: 'tool_result',
              toolResult: { toolCallId: toolCall.id, name: toolCall.name, result: deferredResult.result, isError: false },
            }
            continue
          }

          // Execute the tool
          const visualAttachments = dedupeToolImages([
            ...recentVisualAttachments,
            ...Array.from(toolResults.values()).flatMap((toolResult) => toolResult.images || []),
          ])
          const toolContext: ToolContext = {
            conversationId: this.config.conversationId,
            workspacePath,
            fileAccessGrants,
            fullFilesystemAccess,
            supportsVisionInput: this.supportsVisionInput(),
            fileService: this.config.fileService,
            terminalService: this.config.terminalService,
            allowedModelPoolIds: agentConfig.modelPoolIds,
            visualAttachments,
            agentContext: this.buildModelPoolContext(messages, toolResults),
          }
          const cacheable = ['read_file', 'list_directory', 'search_files', 'web_search', 'read_web_page'].includes(toolCall.name)
          const cacheKey = cacheable ? `${toolCall.name}:${JSON.stringify(toolCall.arguments)}` : ''
          const cached = cacheKey ? readOnlyToolCache.get(cacheKey) : undefined
          const rawResult = cached || await this.executeTool(toolCall, toolContext)
          const result = this.normalizeToolResult(rawResult)
          if (cacheKey && !cached) readOnlyToolCache.set(cacheKey, result)
          toolResults.set(toolCall.id, result)
          if (isDesktopAction && !result.isError) desktopActionExecuted = true
          if (result.images?.length) {
            recentVisualAttachments = dedupeToolImages([...recentVisualAttachments, ...result.images]).slice(-8)
          }

          const targetPath = this.resolveWorkspacePath(toolCall.arguments.path, workspacePath)
          if (!result.isError && (toolCall.name === 'write_file' || toolCall.name === 'edit_file') && targetPath) pendingWriteVerifications.add(targetPath)
          if (!result.isError && toolCall.name === 'read_file' && targetPath) pendingWriteVerifications.delete(targetPath)

          // Emit tool_result event
          yield {
            type: 'tool_result',
            toolResult: {
              toolCallId: toolCall.id,
              name: toolCall.name,
              result: result.result,
              isError: result.isError,
              protocol: result.protocol,
            },
          }
        }
        }

        // Append assistant tool_calls + tool results to message history
        messages = this.appendToolMessages(messages, response.toolCalls, toolResults)

        const integrityReminder = this.buildToolIntegrityReminder(response.toolCalls, toolResults)
        if (integrityReminder) messages.push({ role: 'user', content: integrityReminder })

        // Tool-role messages cannot safely carry multimodal content for every
        // provider. Add generated renders as a new user turn so the next model
        // iteration can visually compare them with the original references.
        const reviewImages = await this.loadBlenderReviewImages(response.toolCalls, toolResults)
        if (reviewImages.length > 0) {
          messages.push({
            role: 'user',
            content: 'Blender generated these review renders of the current model. Compare them directly with the original reference image(s) still in this conversation. Identify visible mismatches in silhouette, proportions, colors, materials, hair, facial features, clothing, and accessories. Continue by correcting the same .blend file, then render another review before you finish.',
            images: reviewImages,
          })
        }

        const visualToolImages = await this.loadToolImages(response.toolCalls, toolResults, ['desktop_observe', 'browser_control', 'mouse_control', 'keyboard_control'])
        if (visualToolImages.length > 0 && this.supportsVisionInput()) {
          messages.push({
            role: 'user',
            content: 'A desktop, mouse, keyboard, or browser tool supplied visual evidence. For desktop tools, the image is the complete visible virtual desktop after the latest observation or action. First decide whether the requested visible outcome actually occurred. If it did not, identify only one corrective next action and observe again after it; never treat pointer arrival or input dispatch as success by itself. Use the returned observationId with mouse_control or keyboard_control for desktop actions. For browser screenshots, use the returned visualObservationId with browser_control click_at, type_at, scroll_at, or press_key. Do not infer pixels obscured by another window or continuous monitoring.',
            images: visualToolImages,
          })
        } else if (visualToolImages.length > 0) {
          const desktopImages = await this.loadToolImages(response.toolCalls, toolResults, ['desktop_observe', 'mouse_control', 'keyboard_control'])
          if (desktopImages.length > 0) {
            const poolToolCallId = `model_pool_visual_${Date.now()}_${iteration}`
            const poolIds = agentConfig.modelPoolIds || []
            const poolToolCall = {
              id: poolToolCallId,
              name: 'delegate_to_model_pool',
              arguments: {
                poolId: poolIds[0] || 'authorized-vision-pool',
                capability: 'vision',
                includeImages: true,
                task: 'Analyze the complete desktop screenshot after the latest Agent action. State whether the requested visible outcome occurred, visible evidence for or against it, and exactly one next corrective action if it did not.',
                automatic: true,
              },
            }
            yield { type: 'tool_call', toolCall: poolToolCall }
            const analysis = await this.analyzeDesktopWithAuthorizedPool(desktopImages)
            yield {
              type: 'tool_result',
              toolResult: {
                toolCallId: poolToolCallId,
                name: 'delegate_to_model_pool',
                result: analysis || 'No authorized visual model pool could analyze the screenshot.',
                isError: !analysis,
              },
            }
            messages.push({
              role: 'user',
              content: analysis || 'A complete virtual-desktop screenshot was captured, but this text-only primary model has no authorized Vision or Image model pool to analyze it. Do not claim that the latest desktop action succeeded. Ask the user to authorize a visual model pool in Agent > Model access or select a vision-capable primary model.',
            })
          } else {
            messages.push({
              role: 'user',
              content: 'A browser screenshot was captured, but this text-only primary model cannot inspect it. Do not guess visual coordinates; use a vision-capable primary model for visual browser interaction.',
            })
          }
        }

        // Goal steps should not blindly consume their maximum tool budget. At
        // each checkpoint the model first decides whether the evidence is
        // sufficient. The existing message history stays intact if it needs
        // another bounded block of tool calls.
        if (adaptiveToolBudget && iteration + 1 >= nextBudgetCheck && nextBudgetCheck < maxIter) {
          yield { type: 'thinking', content: `Reviewing progress after ${iteration + 1} tool cycles...` }
          const decision = yield* this.executeLLMCall([
            ...messages,
            {
              role: 'user',
              content: `You have completed ${iteration + 1} model-and-tool cycles for this task. Do not call tools in this response. Decide whether the work can now be completed with the evidence already collected.\n\nReply with exactly one of:\nFINAL: followed by the concise, complete result for the user.\nCONTINUE: followed by a short reason why additional tool evidence is essential.\n\nChoose CONTINUE only when a specific unresolved fact, failed verification, or necessary change still requires tools. Do not continue merely to improve wording.`,
            },
          ], [])
          accumulatedUsage = this.mergeUsage(accumulatedUsage, decision.usage)
          const decisionContent = decision.content.trim()
          if (/^CONTINUE\s*:/i.test(decisionContent)) {
            nextBudgetCheck = Math.min(maxIter, nextBudgetCheck + Math.max(1, adaptiveToolBudget.extensionIterations))
            messages.push({ role: 'assistant', content: decisionContent })
            messages.push({
              role: 'user',
              content: `Continuation approved. You may use tools again, but focus only on the unresolved evidence described above. The next review is after ${nextBudgetCheck} total tool cycles.`,
            })
            yield { type: 'thinking', content: `Continuing with an expanded budget of ${nextBudgetCheck} tool cycles.` }
            continue
          }
          const finalContent = decisionContent.replace(/^FINAL\s*:\s*/i, '').trim()
          if (finalContent) {
            yield { type: 'done', content: finalContent, usage: accumulatedUsage }
            return
          }
        }
      }

      // Tool calls can legitimately take several passes, but a model must not
      // lose all of its collected evidence merely because it did not stop
      // calling tools by the iteration limit. Give it one final, tool-free
      // synthesis turn so the result can be delivered without another action.
      const finalVerificationNotice = pendingWriteVerifications.size > 0
        ? ` The following file writes remain unverified: ${this.formatPaths(pendingWriteVerifications)}. Do not call them correct, complete, or successfully verified; state that verification is still required.`
        : ''
      const protocolResults = Array.from(toolResults.values()).map((toolResult) => toolResult.protocol).filter(Boolean)
      if (protocolResults.length) {
        messages.push({ role: 'user', content: `Structured execution protocol results (authoritative state; do not infer success from prose):\n${JSON.stringify(protocolResults).slice(0, 24_000)}` })
      }
      messages.push({
        role: 'user',
        content: `You have reached the ${maxIter}-iteration tool-use limit. Do not call any more tools. Using only the results already available in this conversation, provide your concise final answer now. If the evidence is incomplete, state that clearly rather than retrying a tool.${finalVerificationNotice}`,
      })
      yield { type: 'thinking', content: 'Synthesizing the available results...' }
      const finalResponse = yield* this.executeLLMCall(messages, [])
      accumulatedUsage = this.mergeUsage(accumulatedUsage, finalResponse.usage)
      if (finalResponse.content.trim()) {
        yield { type: 'done', content: finalResponse.content, usage: accumulatedUsage }
        return
      }

      yield { type: 'error', error: `Tool-use limit (${maxIter}) reached before the model produced a final response. Completed tool results are retained.` }
      yield { type: 'done', content: '' }
    } catch (err: any) {
      if (this.abortController?.signal.aborted) {
        yield { type: 'done', content: '' }
      } else {
        const errorMsg = err?.message ?? String(err)
        yield { type: 'error', error: errorMsg }
        yield { type: 'done', content: '' }
      }
    } finally {
      this.isRunning = false
      this.abortController = null
    }
  }

  /** Abort the current execution. */
  abort(): void {
    if (this.abortController && !this.abortController.signal.aborted) {
      this.abortController.abort()
    }
  }

  /** Whether the runner is currently executing. */
  get running(): boolean {
    return this.isRunning
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  /**
   * Execute a single LLM call with streaming.
   *
   * - Yields `AgentEvent { type: 'text', content: delta }` for each text chunk.
   * - Accumulates tool_call fragments (OpenAI sends arguments as partial JSON strings).
   * - Returns the full accumulated content, completed tool_calls, and finish reason.
   */
  private async *executeLLMCall(
    messages: ChatMessageInput[],
    tools: ToolDefinition[]
  ): AsyncGenerator<AgentEvent, { content: string; toolCalls: CompletedToolCall[]; finishReason: string; usage?: ChatUsage }> {
    const { agentConfig, provider } = this.config
    const signal = this.abortController?.signal

    const stream: AsyncIterable<ChatChunk> = provider.chat(
      {
        model: agentConfig.model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        temperature: agentConfig.temperature,
        stream: true,
        reasoning: agentConfig.showThinking ? { enabled: true, budgetTokens: 1024 } : undefined,
      },
      signal
    )

    let content = ''
    let receivedReasoning = false
    let finishReason = ''
    let usage: ChatUsage | undefined

    // Tool call accumulation state (keyed by chunk index)
    const tcAccumulator: Map<number, { id: string; name: string; argsStr: string }> = new Map()

    for await (const chunk of stream) {
      // Check abort between chunks
      if (signal?.aborted) break
      usage = this.mergeUsage(usage, this.toChatUsage(chunk.usage))

      if (agentConfig.showThinking && chunk.reasoningContent) {
        receivedReasoning = true
        yield { type: 'reasoning', content: chunk.reasoningContent }
      }

      // ── Text content ──────────────────────────────────────────────────────
      if (chunk.content) {
        content += chunk.content
        // Yield real-time text delta to the caller
        yield { type: 'text', content: chunk.content }
      }

      // ── Tool call fragments ───────────────────────────────────────────────
      if (chunk.toolCalls) {
        for (const tc of chunk.toolCalls) {
          let acc = tcAccumulator.get(tc.index)
          if (!acc) {
            acc = { id: tc.id ?? '', name: tc.name ?? '', argsStr: '' }
            tcAccumulator.set(tc.index, acc)
          }
          if (tc.id) acc.id = tc.id
          if (tc.name) acc.name = tc.name
          if (tc.arguments !== undefined) acc.argsStr += tc.arguments
        }
      }

      if (chunk.finishReason) {
        finishReason = chunk.finishReason
      }
    }

    // Parse accumulated tool calls
    const toolCalls: CompletedToolCall[] = []
    const sortedEntries = Array.from(tcAccumulator.entries()).sort(([a], [b]) => a - b)

    for (const [, acc] of sortedEntries) {
      let parsedArgs: Record<string, unknown> = {}
      if (acc.argsStr.trim()) {
        try {
          parsedArgs = JSON.parse(acc.argsStr)
        } catch {
          parsedArgs = { _raw: acc.argsStr }
        }
      }
      toolCalls.push({
        id: acc.id,
        name: acc.name,
        arguments: parsedArgs,
      })
    }

    if (agentConfig.showThinking && !receivedReasoning) {
      throw new Error(`模型未返回可显示的思考内容。${agentConfig.providerId} / ${agentConfig.model} 可能未启用推理模式或当前连接不支持该能力。`)
    }

    return { content, toolCalls, finishReason, usage }
  }

  private toChatUsage(usage?: ChatChunk['usage']): ChatUsage | undefined {
    if (!usage) return undefined
    const promptTokens = Math.max(0, usage.promptTokens || 0)
    const completionTokens = Math.max(0, usage.completionTokens || 0)
    const cachedTokens = usage.cachedTokens
    const cacheMissTokens = usage.cacheMissTokens
      ?? (typeof cachedTokens === 'number' ? Math.max(0, promptTokens - cachedTokens) : undefined)
    return {
      promptTokens,
      completionTokens,
      ...(typeof cachedTokens === 'number' ? { cachedTokens } : {}),
      ...(typeof cacheMissTokens === 'number' ? { cacheMissTokens } : {}),
      estimatedCostCny: this.estimateUsageCostCny(promptTokens, completionTokens, cachedTokens),
      modelCalls: 1,
    }
  }

  private mergeUsage(current?: ChatUsage, next?: ChatUsage): ChatUsage | undefined {
    if (!current) return next
    if (!next) return current
    return {
      promptTokens: current.promptTokens + next.promptTokens,
      completionTokens: current.completionTokens + next.completionTokens,
      cachedTokens: this.addOptional(current.cachedTokens, next.cachedTokens),
      cacheMissTokens: this.addOptional(current.cacheMissTokens, next.cacheMissTokens),
      estimatedCostCny: this.addOptional(current.estimatedCostCny, next.estimatedCostCny),
      modelCalls: (current.modelCalls ?? 1) + (next.modelCalls ?? 1),
    }
  }

  private addOptional(left?: number, right?: number): number | undefined {
    if (left === undefined && right === undefined) return undefined
    return (left ?? 0) + (right ?? 0)
  }

  private estimateUsageCostCny(promptTokens: number, completionTokens: number, cachedTokens?: number): number | undefined {
    // Estimates are local reference values, not provider billing records.
    if (this.config.provider.type !== 'deepseek') return undefined
    const isFlash = this.config.agentConfig.model.toLowerCase().includes('flash')
    const inputPerMillion = isFlash ? 0.5 : 2
    const cachedInputPerMillion = isFlash ? 0.05 : 0.2
    const outputPerMillion = isFlash ? 2 : 8
    const cached = Math.min(promptTokens, Math.max(0, cachedTokens ?? 0))
    const uncached = Math.max(0, promptTokens - cached)
    return (uncached * inputPerMillion + cached * cachedInputPerMillion + completionTokens * outputPerMillion) / 1_000_000
  }

  /**
   * Execute a single tool call.
   *
   * 1. Look up the tool in the registry
   * 2. Check the agent is allowed to use it
   * 3. Execute, catching errors and returning them as-is (not thrown)
   */
  private async executeTool(
    toolCall: CompletedToolCall,
    toolContext: ToolContext
  ): Promise<CompletedToolResult> {
    if (toolCall.name === TEAM_DELEGATION_TOOL.name && this.config.delegateToTeam) {
      const goal = typeof toolCall.arguments.goal === 'string' ? toolCall.arguments.goal.trim() : ''
      if (!goal) return { result: 'Error: delegate_to_team requires a non-empty goal.', isError: true }
      try {
        return { result: await this.config.delegateToTeam(goal), isError: false }
      } catch (error: any) {
        return { result: `Error: Team delegation failed: ${error?.message ?? String(error)}`, isError: true }
      }
    }

    if (toolCall.name === TASK_TOOL.name && this.config.runTask) {
      const task = typeof toolCall.arguments.task === 'string' ? toolCall.arguments.task.trim() : ''
      if (!task) return { result: 'Error: run_task requires a non-empty task.', isError: true }
      try { return { result: await this.config.runTask(task), isError: false } } catch (error: any) { return { result: `Error: Task execution failed: ${error?.message ?? String(error)}`, isError: true } }
    }

    if (toolCall.name === GOAL_TOOL.name && this.config.runGoal) {
      const goal = typeof toolCall.arguments.goal === 'string' ? toolCall.arguments.goal.trim() : ''
      if (!goal) return { result: 'Error: run_goal requires a non-empty goal.', isError: true }
      try { return { result: await this.config.runGoal(goal), isError: false } } catch (error: any) { return { result: `Error: Goal execution failed: ${error?.message ?? String(error)}`, isError: true } }
    }

    if (toolCall.name === GOAL_CONTROL_TOOL.name && this.config.manageGoal) {
      const action = typeof toolCall.arguments.action === 'string' ? toolCall.arguments.action : ''
      if (action !== 'status' && action !== 'pause' && action !== 'resume' && action !== 'cancel') {
        return { result: 'Error: manage_goal requires action to be status, pause, resume, or cancel.', isError: true }
      }
      try {
        return { result: await this.config.manageGoal(action), isError: false }
      } catch (error: any) {
        return { result: `Error: Goal control failed: ${error?.message ?? String(error)}`, isError: true }
      }
    }

    if (toolCall.name === PLAN_TOOL.name && this.config.createExecutionPlan) {
      const goal = typeof toolCall.arguments.goal === 'string' ? toolCall.arguments.goal.trim() : ''
      if (!goal) return { result: 'Error: create_execution_plan requires a non-empty goal.', isError: true }
      try { return { result: await this.config.createExecutionPlan(goal), isError: false } } catch (error: any) { return { result: `Error: Plan creation failed: ${error?.message ?? String(error)}`, isError: true } }
    }

    if (toolCall.name === SPEC_TOOL.name && this.config.applySpecTemplate) {
      const templateId = typeof toolCall.arguments.templateId === 'string' ? toolCall.arguments.templateId.trim() : ''
      const parameters = typeof toolCall.arguments.parameters === 'object' && toolCall.arguments.parameters && !Array.isArray(toolCall.arguments.parameters)
        ? Object.fromEntries(Object.entries(toolCall.arguments.parameters as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
        : {}
      if (!templateId) return { result: 'Error: apply_spec_template requires a templateId.', isError: true }
      try { return { result: await this.config.applySpecTemplate(templateId, parameters), isError: false } } catch (error: any) { return { result: `Error: Template expansion failed: ${error?.message ?? String(error)}`, isError: true } }
    }

    const tool: ToolExecutor | undefined = this.config.toolRegistry.get(toolCall.name)

    if (!tool) {
      return { result: `Error: Tool '${toolCall.name}' not found in registry.`, isError: true }
    }

    if (!this.config.agentConfig.tools.includes(toolCall.name)) {
      return {
        result: `Error: Tool '${toolCall.name}' is not permitted for this agent.`,
        isError: true,
      }
    }

    if ((toolCall.name === 'write_file' || toolCall.name === 'edit_file') && this.config.allowedWritePaths?.length) {
      const requestedPath = typeof toolCall.arguments.path === 'string' ? toolCall.arguments.path : ''
      const resolvedRequested = requestedPath
        ? path.resolve(path.isAbsolute(requestedPath) ? requestedPath : toolContext.workspacePath, requestedPath)
        : ''
      const isAllowed = this.config.allowedWritePaths.some((allowedPath) =>
        path.resolve(allowedPath).toLowerCase() === resolvedRequested.toLowerCase()
      )
      if (!isAllowed) {
        return {
          result: 'Error: This agent may write only to its explicitly authorized paths.',
          isError: true,
        }
      }
    }

    if (this.config.requestToolApproval) {
      const approval = await this.config.requestToolApproval({
        toolCall: {
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
        },
        workspacePath: toolContext.workspacePath,
      })
      if (!approval.approved) {
        return {
          result: approval.message || `Execution of '${toolCall.name}' was not approved.`,
          isError: true,
        }
      }
    }

    try {
      const output = await tool.execute(toolCall.arguments, toolContext)
      if (typeof output === 'string') return { result: output, isError: false }
      return { result: output.content, images: output.images, protocol: output.protocol, isError: false }
    } catch (err: any) {
      return { result: `Error: ${err?.message ?? String(err)}`, isError: true }
    }
  }

  /**
   * Append assistant's tool_call message and tool result messages to history.
   * The assistant message carries all tool_calls from one LLM response;
   * each tool gets its own tool-role message with the corresponding toolCallId.
   */
  private appendToolMessages(
    messages: ChatMessageInput[],
    toolCalls: CompletedToolCall[],
    toolResults: Map<string, CompletedToolResult>
  ): ChatMessageInput[] {
    const updated = [...messages]

    // Assistant message that issued the tool calls
    updated.push({
      role: 'assistant',
      content: '',
      toolCalls: toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      })),
    })

    // One tool message per tool_call result
    for (const tc of toolCalls) {
      const tr = toolResults.get(tc.id)
      updated.push({
        role: 'tool',
        content: tr?.result ?? '',
        toolCallId: tc.id,
      })
    }

    return updated
  }

  private normalizeToolResult(result: CompletedToolResult): CompletedToolResult {
    if (result.isError) return result
    // Some legacy executors return a textual failure instead of throwing. Do
    // not let that be mistaken for evidence that the requested action worked.
    if (/^(?:error|failed|failure|mouse control failed)\b/i.test(result.result.trim())) {
      return { ...result, isError: true, protocol: result.protocol ? { ...result.protocol, status: 'failed' } : undefined }
    }
    return result
  }

  private resolveWorkspacePath(value: unknown, workspacePath: string): string | undefined {
    if (typeof value !== 'string' || !value.trim()) return undefined
    const requestedPath = value.trim()
    return path.resolve(path.isAbsolute(requestedPath) ? requestedPath : workspacePath, requestedPath).toLowerCase()
  }

  private formatPaths(paths: Set<string>): string {
    return Array.from(paths).map((filePath) => `"${filePath}"`).join(', ')
  }

  private buildToolIntegrityReminder(
    toolCalls: CompletedToolCall[],
    toolResults: Map<string, CompletedToolResult>
  ): string | undefined {
    const failures = toolCalls
      .map((toolCall) => ({ toolCall, result: toolResults.get(toolCall.id) }))
      .filter((entry) => entry.result?.isError)

    if (failures.length > 0) {
      const names = failures.map(({ toolCall }) => toolCall.name).join(', ')
      return `Execution integrity notice: ${names} did not complete successfully. Do not claim any requested outcome from those calls succeeded, and do not fabricate the missing data. State the limitation plainly and identify the next concrete requirement (permission, service configuration, source, or user approval).`
    }

    const successfulSearch = toolCalls.some((toolCall) => toolCall.name === 'web_search' && !toolResults.get(toolCall.id)?.isError)
    if (successfulSearch) {
      return 'Research integrity notice: base current-information claims only on the returned search results or pages read in this execution. Include the relevant returned source URLs or explicitly distinguish your own inference from sourced facts.'
    }

    return undefined
  }

  /**
   * Only Blender renders are sent back as multimodal user content. Tool
   * screenshots (such as desktop_observe and browser_control) remain execution evidence and must
   * not be attached to a follow-up model request: many OpenAI-compatible
   * endpoints accept text-only message parts and reject image_url entirely.
   */
  private async loadBlenderReviewImages(
    toolCalls: CompletedToolCall[],
    toolResults: Map<string, CompletedToolResult>
  ): Promise<NonNullable<ChatMessageInput['images']>> {
    return this.loadToolImages(toolCalls, toolResults, ['blender_render_review', 'blender_model_from_reference'])
  }

  private supportsVisionInput(): boolean {
    if (this.config.provider.type === 'anthropic') return true
    if (this.config.provider.type !== 'openai') return false
    return /(?:gpt-4o|gpt-4\.1|gpt-5|o1|o3|o4-mini)/i.test(this.config.agentConfig.model)
  }

  private buildModelPoolContext(
    messages: ChatMessageInput[],
    currentResults: Map<string, CompletedToolResult>,
  ): string {
    const recentMessages = messages
      .slice(-12)
      .map((message) => {
        const role = message.role.toUpperCase()
        const toolCalls = message.toolCalls?.length ? ` tool_calls=${JSON.stringify(message.toolCalls).slice(0, 2_000)}` : ''
        return `[${role}] ${message.content.slice(0, 4_000)}${toolCalls}`
      })
      .join('\n')
    const currentTools = Array.from(currentResults.entries())
      .map(([id, result]) => `[tool:${id}] ${result.result.slice(0, 5_000)}`)
      .join('\n')
    return `${recentMessages}\n${currentTools}`.slice(-32_000)
  }

  /**
   * Desktop screenshots are explicit user-authorized observations. When the
   * primary model is text-only, use only the pools granted to this agent to
   * turn that screenshot into a bounded visual handoff.
   */
  private async analyzeDesktopWithAuthorizedPool(
    images: NonNullable<ChatMessageInput['images']>,
  ): Promise<string | undefined> {
    const poolIds = this.config.agentConfig.modelPoolIds || []
    if (!poolIds.length) return undefined

    const candidates: ModelPoolEntry[] = []
    const seen = new Set<string>()
    const router = new ModelRouter(getStorage().config.get('modelPools'), (entry) => Boolean(providerRegistry.get(entry.providerId)))
    for (const poolId of poolIds) {
      for (const capability of ['vision', 'image'] as const) {
        const route = router.resolve({ poolId, capability })
        for (const entry of [route.primary, ...route.fallbacks]) {
          if (entry && !seen.has(entry.id)) {
            seen.add(entry.id)
            candidates.push(entry)
          }
        }
      }
    }
    if (!candidates.length) return undefined

    for (const entry of candidates) {
      const provider = providerRegistry.get(entry.providerId)
      if (!provider) continue
      try {
        const startedAt = Date.now()
        const response = await provider.chatComplete({
          model: entry.model,
          messages: [
            {
              role: 'system',
              content: 'You analyze one user-authorized point-in-time screenshot of the complete Windows virtual desktop. Describe only visible pixels, including each display, desktop icons, taskbars, open windows, and relevant text. State uncertainty for small or unreadable content. Do not claim access to hidden windows, persistent monitoring, tools, or the computer outside this image.',
            },
            {
              role: 'user',
              content: 'Analyze this desktop screenshot for the primary assistant so it can answer the user or choose the next explicitly authorized desktop action.',
              images,
            },
          ],
          temperature: 0.1,
          maxTokens: 4096,
        })
        if (response.content.trim()) {
          modelHealthService.recordSuccess(entry.id, Date.now() - startedAt)
          return `Visual analysis from the authorized desktop model ${entry.name} (${entry.providerId} / ${entry.model}):\n${response.content.trim()}`
        }
      } catch {
        modelHealthService.recordFailure(entry.id)
        // Try the next configured fallback without leaking provider internals
        // into the primary model's desktop decision.
      }
    }
    return undefined
  }

  private async loadToolImages(
    toolCalls: CompletedToolCall[],
    toolResults: Map<string, CompletedToolResult>,
    toolNames: string[],
  ): Promise<NonNullable<ChatMessageInput['images']>> {
    const loaded: NonNullable<ChatMessageInput['images']> = []
    const imageResults = toolCalls
      .filter((toolCall) => toolNames.includes(toolCall.name))
      .flatMap((toolCall) => toolResults.get(toolCall.id)?.images || [])

    for (const image of imageResults) {
      if (loaded.length >= MAX_TOOL_REVIEW_IMAGES) break
      try {
        const stat = await fs.promises.stat(image.path)
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_TOOL_REVIEW_IMAGE_BYTES) continue
        const data = await fs.promises.readFile(image.path)
        loaded.push({
          name: image.name || path.basename(image.path),
          mediaType: image.mediaType,
          dataUrl: `data:${image.mediaType};base64,${data.toString('base64')}`,
        })
      } catch {
        // A render can be cleaned up between the tool call and this next turn.
      }
    }

    return loaded
  }
}

function dedupeToolImages(images: ToolResultImage[]): ToolResultImage[] {
  const seen = new Set<string>()
  return images.filter((image) => {
    const key = `${image.path}|${image.name}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
