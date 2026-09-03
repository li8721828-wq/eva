import type { LLMProvider } from '../providers/base-provider'
import fs from 'fs'
import path from 'path'
import type { ToolExecutor, ToolContext, ToolRegistry, FileService, TerminalService, ToolResultImage } from '../tools'
import type { AgentConfig, AgentEvent } from '../../shared/types/agent'
import type { ChatMessage, ChatUsage } from '../../shared/types/conversation'
import type { ToolDefinition, ChatMessageInput, ChatChunk } from '../../shared/types/provider'
import { ContextManager } from './context'
import { DEFAULT_MAX_ITERATIONS, getModelInputBudgetTokens } from '../../shared/constants'
import { appendRollingToolEvidence, compactCompletedToolTransactions, compactToolResultForModel, getToolFollowUpInputBudget } from './tool-result-context'
import { learnEnvironmentRuleFromFailure } from '../services/environment-profile-service'
import type { FileAccessGrant } from '../../shared/types/file-access'
import type { ModelPool } from '../../shared/types/model-pool'
import type { ExecutionEnvelope } from '../../shared/types/execution-protocol'
import type { ProviderRegistry } from '../providers'
import { resolveConnectionPricingMode, resolveRateCardUsageCost } from '../services/usage-pricing-service'
import { ensureProviderPricing } from '../services/supplier-pricing-service'
import { formatProviderRequestFailure, type ProviderRequestSource } from '../services/provider-request-diagnostics'
import { classifyError } from '../providers/errors'

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
  runGoal?: (goal: string, estimatedSteps?: number) => Promise<string>
  manageGoal?: (action: 'status' | 'pause' | 'resume' | 'cancel') => Promise<string>
  createExecutionPlan?: (goal: string) => Promise<string>
  applySpecTemplate?: (templateId: string, parameters: Record<string, string>) => Promise<string>
  /** Goal-only budget that can grow after the model explicitly asks for more evidence. */
  adaptiveToolBudget?: AdaptiveToolBudget
  /** Identifies the caller in a provider error without changing the request. */
  requestSource?: ProviderRequestSource
  modelPools?: ModelPool[]
  providerRegistry?: ProviderRegistry
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
const ROLLING_TOOL_EVIDENCE_START = '--- Earlier completed tool evidence ---'
const ROLLING_TOOL_EVIDENCE_END = '--- End earlier completed tool evidence ---'
// A provider may impose a lower, hidden per-request output cap. Continue only
// when it explicitly reports `length`; a natural `stop` must end the turn.
const MAX_PROVIDER_CONTINUATIONS = 3
const MAX_EMPTY_RESPONSE_RETRIES = 1
const MAX_NORMAL_TOOL_CYCLES = 12
const MAX_AGENT_RESPONSE_TOKENS = 2_048
const PARALLEL_SAFE_READ_TOOL_NAMES = new Set(['read_file', 'list_directory', 'search_files', 'web_search', 'read_web_page', 'read_terminal'])
// Tool-generated screenshots need an independent bound from user attachments.
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
  description: 'Run a long-lived goal through Eva\'s internal goal planner. Use only for a genuinely complex, measurable outcome that needs at least 5 independent execution steps, checkpointed progress, and adaptation. For fewer than 5 steps, continue directly with the available tools instead.',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'Concrete outcome to achieve.' },
      estimatedSteps: { type: 'integer', minimum: 5, maximum: 50, description: 'Required estimate of independent execution steps. Do not call run_goal for fewer than 5 steps.' },
    },
    required: ['goal', 'estimatedSteps'],
  },
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

function modelPoolDelegationTool(modelPools: ModelPool[] | undefined, allowedPoolIds?: string[]): ToolDefinition | undefined {
  if (!allowedPoolIds?.length) return undefined
  const pools = (modelPools || []).filter((pool) => allowedPoolIds.includes(pool.id))
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
  /** Prevent a model feedback-loop from restarting the whole team in one chat turn. */
  private teamDelegationUsed = false

  constructor(config: AgentRunnerConfig) {
    this.config = config
  }

  /**
   * Execute one direct tool batch for ordinary chat, then synthesize its
   * results. Goal steps opt into the bounded ReAct loop because dependent
   * actions such as inspect -> edit -> verify need later tool decisions.
   */
  async *run(params: RunParams): AsyncGenerator<AgentEvent> {
    if (this.isRunning) {
      yield { type: 'error', error: 'AgentRunner is already running' }
      return
    }

    this.isRunning = true
    this.teamDelegationUsed = false
    this.abortController = new AbortController()

    try {
      // Synchronize the active supplier connection before any model call so a
      // newly used connection does not require a separate Cost Center visit.
      await ensureProviderPricing(this.config.provider.id).catch(() => undefined)
      const { agentConfig, toolRegistry, contextManager, workspacePath, fileAccessGrants, fullFilesystemAccess } = this.config
      const configuredMaxIterations = this.config.maxIterations ?? agentConfig.maxIterations ?? DEFAULT_MAX_ITERATIONS
      const adaptiveToolBudget = this.config.adaptiveToolBudget
      const maxIter = adaptiveToolBudget
        ? Math.max(1, Math.min(configuredMaxIterations, adaptiveToolBudget.maxIterations))
        : configuredMaxIterations
      // Normal chat follows only model-requested tool calls. It has a generous
      // safety ceiling, while exact repeated tool batches terminate early to
      // prevent a failed lookup from turning into an open-ended loop.
      const toolCycleLimit = adaptiveToolBudget ? maxIter : Math.min(maxIter, MAX_NORMAL_TOOL_CYCLES)
      let nextBudgetCheck = adaptiveToolBudget
        ? Math.max(1, Math.min(toolCycleLimit, adaptiveToolBudget.initialIterations))
        : toolCycleLimit
      if (agentConfig.showThinking && !this.config.provider.supportsReasoning(agentConfig.model)) {
        yield { type: 'thinking', content: '当前模型不支持慢思考内容输出，将按普通模式继续执行。' }
      }

      // Tool definitions filtered by agent's allowed tool list
      const hasSpreadsheetAttachment = [
        ...params.messages,
        params.newMessage,
      ].some((message) => message.attachments?.some((attachment) => /\.(xlsx|xls|ods)$/iu.test(attachment.name) || /\.(xlsx|xls|ods)$/iu.test(attachment.path)))
      const poolTool = agentConfig.tools.includes('delegate_to_model_pool') ? modelPoolDelegationTool(this.config.modelPools, agentConfig.modelPoolIds) : undefined
      const mcpToolNames = agentConfig.tools.includes('mcp:*')
        ? toolRegistry.getAll().filter((tool) => tool.definition.name.startsWith('mcp__')).map((tool) => tool.definition.name)
        : []
      const configuredToolNames = agentConfig.tools.filter((name) => name !== 'delegate_to_model_pool' && name !== 'mcp:*' && name !== 'spreadsheet')
      const spreadsheetDefinition = toolRegistry.getDefinitionsByNames(['spreadsheet'])
      const allToolDefs: ToolDefinition[] = [
        ...(hasSpreadsheetAttachment ? spreadsheetDefinition : []),
        ...toolRegistry.getDefinitionsByNames([...configuredToolNames, ...mcpToolNames]),
        ...(toolRegistry.has('manage_personal_preferences') && !agentConfig.tools.includes('manage_personal_preferences') ? toolRegistry.getDefinitionsByNames(['manage_personal_preferences']) : []),
        ...(!hasSpreadsheetAttachment && toolRegistry.has('spreadsheet') ? spreadsheetDefinition : []),
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
      let mustReadWebPageBeforeMoreSearch = false
      const pendingWriteVerifications = new Set<string>()
      let recentVisualAttachments: ToolResultImage[] = dedupeToolImages(
        allHistory.flatMap((message) => (message.images || []).map((image) => ({
          path: image.path,
          name: image.name,
          mediaType: image.mediaType,
        }))),
      ).slice(-8)
      let accumulatedUsage: ChatUsage | undefined
      let completedResponse = ''
      let providerContinuationCount = 0
      let emptyResponseRetries = 0
      let protocolRepairAttempts = 0
      let latestProtocolResults: NonNullable<CompletedToolResult['protocol']>[] = []
      let rollingToolEvidence = ''
      const previousNormalToolBatches = new Set<string>()

      // Progressive tool disclosure is intentionally disabled. The active
      // agent's configured capabilities are all visible to the model, so an
      // intent heuristic can never prevent a legitimate tool call.
      const activeToolDefs = allToolDefs
      const spreadsheetPolicy = hasSpreadsheetAttachment
        ? '\n\n--- Spreadsheet attachment policy ---\nA spreadsheet attachment is present. Use the structured `spreadsheet` tool first. Make one `inspect` call without a `sheet` argument to get the workbook and sheet overview; inspect an individual sheet only when the first result shows it is necessary. Use `create` or `update` only when the user explicitly requests a file change. Do not write Python, PowerShell, Node, or other scripts for spreadsheet work unless the spreadsheet tool returns an error or explicitly reports that the requested operation is unsupported. If fallback is needed, report the spreadsheet tool failure before using `execute_command`. Do not repeat an identical spreadsheet call.\n'
        : ''
      let activeSystemPrompt = contextManager.buildSystemPrompt(
        agentConfig,
        workspacePath,
        fileAccessGrants,
        fullFilesystemAccess,
        activeToolDefs,
      ) + spreadsheetPolicy
      let messages: ChatMessageInput[] = contextManager.buildContext({
        agentConfig,
        messages: safeAllHistory,
        workspacePath,
        fileAccessGrants,
        fullFilesystemAccess,
        maxContextTokens: getModelInputBudgetTokens(agentConfig.model),
        tools: activeToolDefs,
        systemPromptSuffix: spreadsheetPolicy,
      })

      // ── Tool execution loop ─────────────────────────────────────────────────
      for (let iteration = 0; iteration < toolCycleLimit; iteration++) {
        if (this.abortController.signal.aborted) {
          yield { type: 'done', content: '' }
          return
        }

        yield {
          type: 'thinking',
          content: iteration === 0 ? 'Preparing the response and any required tools...' : 'Reviewing the tool results...',
        }

        // Call LLM (yields real-time text_delta events to caller)
        const response = yield* this.executeLLMCall(messages, activeToolDefs)
        accumulatedUsage = this.recordModelCallUsage(accumulatedUsage, response.usage)

        // A few gateways duplicate the same tool invocation in one response
        // while assembling DSML/function-call output. Keep the first call so
        // the UI and tool protocol do not show or execute it repeatedly.
        const seenToolCallSignatures = new Set<string>()
        response.toolCalls = response.toolCalls.filter((toolCall) => {
          const signature = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`
          if (seenToolCallSignatures.has(signature)) return false
          seenToolCallSignatures.add(signature)
          return true
        })

        const hasToolCalls = response.toolCalls.length > 0

        // No tool calls → the model is done reasoning
        if (!hasToolCalls) {
          if (response.protocolTextDetected && !response.toolCallParseFailure && activeToolDefs.length > 0 && protocolRepairAttempts < 1) {
            protocolRepairAttempts += 1
            if (response.content) yield { type: 'text_reset', discardProvisionalText: true }
            completedResponse = ''
            messages.push({
              role: 'user',
              content: 'Your previous response returned tool-call protocol markup without an executable structured call. Retry using the provided structured tool-calling interface only. Do not emit DSML, XML, or tool-call markup as ordinary response text.',
            })
            yield { type: 'thinking', content: '检测到未执行的工具协议文本，正在按标准工具协议重试一次。' }
            continue
          }
          if (response.protocolTextDetected && !response.toolCallParseFailure) {
            if (response.content) yield { type: 'text_reset', discardProvisionalText: true }
            yield {
              type: 'error',
              error: '模型在最终回复中返回了未执行的工具协议文本；本轮未执行该工具。请重试，或更换兼容工具调用协议的模型。',
            }
            return
          }
          if (response.toolCallParseFailure && activeToolDefs.length > 0 && protocolRepairAttempts < 1) {
            protocolRepairAttempts += 1
            // The provider streamed an unparseable tool envelope as prose.
            // Clear it rather than presenting it as a completed answer, then
            // give the model one bounded retry with the same tool schemas.
            if (response.content) yield { type: 'text_reset', discardProvisionalText: true }
            completedResponse = ''
            messages.push({
              role: 'user',
              content: 'Your previous response attempted a tool call, but the gateway returned an invalid text envelope and nothing was executed. Retry the needed operation now using the provided structured tool-calling interface only. Do not emit DSML, XML, or tool-call markup as ordinary response text.',
            })
            yield { type: 'thinking', content: '检测到未执行的工具调用格式，正在按标准工具协议重试一次。' }
            continue
          }
          if (response.toolCallParseFailure) {
            // A second malformed/unsupported text envelope is not a valid
            // answer. The provider may have streamed DSML/XML as provisional
            // text; clear it before surfacing a concise execution error so
            // protocol markup never becomes part of the user-visible reply.
            if (response.content) yield { type: 'text_reset', discardProvisionalText: true }
            yield {
              type: 'error',
              error: '模型返回了无法执行的工具协议文本；本轮未执行该工具。请确认 Agent 已启用所需工具，或让当前 Agent 直接完成该步骤。',
            }
            return
          }
          if (!response.content.trim() && emptyResponseRetries < MAX_EMPTY_RESPONSE_RETRIES) {
            emptyResponseRetries += 1
            messages.push({
              role: 'user',
              content: 'The previous request did not include a final answer. Reply with the concise user-facing answer now. Do not return reasoning-only content, an empty message, or tool-call markup.',
            })
            yield {
              type: 'thinking',
              content: '供应商未返回最终答案，正在自动重试一次。',
            }
            continue
          }
          if (!response.content.trim()) {
            const imageHint = hasImageInput
              ? ` The conversation includes image input; select a vision-capable model before retrying.`
              : ''
            const reasoningHint = response.reasoningContent?.trim()
              ? ' The provider returned reasoning content but no final answer; its reasoning/response mode may be incompatible with this gateway.'
              : ''
            yield {
              type: 'error',
              error: `Model ${agentConfig.model} returned an empty response.${reasoningHint}${imageHint}`,
            }
            return
          }
          completedResponse += response.content
          if (response.finishReason === 'length' && providerContinuationCount < MAX_PROVIDER_CONTINUATIONS) {
            providerContinuationCount += 1
            messages.push({ role: 'assistant', content: response.content })
            messages.push({
              role: 'user',
              content: 'The provider ended the response because its per-request output limit was reached. Continue from the exact end of the previous response without repeating it. Finish the answer completely, then stop naturally.',
            })
            yield {
              type: 'thinking',
              content: `The provider output limit was reached; continuing the response (${providerContinuationCount}/${MAX_PROVIDER_CONTINUATIONS})...`,
            }
            continue
          }
          if (pendingWriteVerifications.size > 0 && activeToolDefs.some((tool) => tool.name === 'read_file') && iteration < toolCycleLimit - 1) {
            messages.push({ role: 'assistant', content: response.content })
            messages.push({
              role: 'user',
              content: `You wrote ${this.formatPaths(pendingWriteVerifications)} in this run but have not verified the saved contents. Before finalizing, call read_file for each changed path. Do not claim the file is correct or complete until that verification succeeds.`,
            })
            continue
          }
          // Text chunks were already emitted by executeLLMCall. The done event
          // supplies the canonical, complete content for persistence.
          yield { type: 'done', content: completedResponse, finishReason: response.finishReason, usage: accumulatedUsage }
          return
        }

        // A normal pre-tool reply is meaningful user-facing process and is
        // promoted to the accumulated progress view by the conversation
        // handler. Gateways can nevertheless mix native tool_calls with a
        // serialized DSML/XML envelope in the same response; discard any such
        // protocol-looking provisional text even when native calls exist.
        const containsToolProtocolMarkup = /<\s*(?:[|｜]\s*){1,2}DSML\b|<\s*tool_call\b|<\s*function=/i.test(response.content)
        if (response.content) {
          yield {
            type: 'text_reset',
            discardProvisionalText: Boolean(response.textToolCallEnvelope || response.toolCallParseFailure || containsToolProtocolMarkup),
          }
        }
        completedResponse = ''

        // A model may request several independent reads in one turn. Execute
        // only a wholly read-only batch in parallel; any mutation, terminal,
        // browser, or desktop action keeps the original strict ordering.
        const toolResults = new Map<string, CompletedToolResult>()
        const parallelReadBatch = !mustReadWebPageBeforeMoreSearch && response.toolCalls.length > 1
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
          const inFlightReadExecutions = new Map<string, Promise<CompletedToolResult>>()
          const completedBatch = await Promise.all(response.toolCalls.map(async (toolCall) => {
            const cacheKey = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`
            let execution = inFlightReadExecutions.get(cacheKey)
            if (!execution) {
              execution = Promise.resolve(readOnlyToolCache.get(cacheKey))
                .then(async (cached) => cached || this.normalizeToolResult(await this.executeTool(toolCall, baseContext)))
                .then((result) => {
                  readOnlyToolCache.set(cacheKey, result)
                  return result
                })
              inFlightReadExecutions.set(cacheKey, execution)
            }
            const result = await execution
            return { toolCall, result }
          }))
          for (const { toolCall, result } of completedBatch) {
            toolResults.set(toolCall.id, result)
            if (result.isError) learnEnvironmentRuleFromFailure(toolCall.name, toolCall.arguments, result.result)
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

          if (toolCall.name === 'web_search' && mustReadWebPageBeforeMoreSearch) {
            const deferredResult: CompletedToolResult = {
              result: 'Search results already returned readable source URLs. Read a relevant result with read_web_page before issuing another web_search.',
              // This is a workflow hint, not a provider failure. Marking it
              // as an error makes the model report that search failed and
              // encourages the retry loop this guard is meant to stop.
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
          let result: CompletedToolResult
          const cacheable = ['read_file', 'list_directory', 'search_files', 'web_search', 'read_web_page'].includes(toolCall.name)
          const cacheKey = cacheable ? `${toolCall.name}:${JSON.stringify(toolCall.arguments)}` : ''
          const cached = cacheKey ? readOnlyToolCache.get(cacheKey) : undefined
          const rawResult = cached || await this.executeTool(toolCall, toolContext)
          result = this.normalizeToolResult(rawResult)
          if (cacheKey && !cached) readOnlyToolCache.set(cacheKey, result)
          if (result.isError) learnEnvironmentRuleFromFailure(toolCall.name, toolCall.arguments, result.result)
          toolResults.set(toolCall.id, result)
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
        const completedPageRead = response.toolCalls.some((toolCall) => toolCall.name === 'read_web_page' && !toolResults.get(toolCall.id)?.isError)
        const returnedReadableSearchResult = response.toolCalls.some((toolCall) => {
          const result = toolResults.get(toolCall.id)
          return toolCall.name === 'web_search' && !result?.isError && /https?:\/\/\S+/i.test(result?.result || '')
        })
        if (completedPageRead) mustReadWebPageBeforeMoreSearch = false
        else if (returnedReadableSearchResult && activeToolDefs.some((tool) => tool.name === 'read_web_page')) mustReadWebPageBeforeMoreSearch = true
        latestProtocolResults = Array.from(toolResults.values())
          .map((toolResult) => toolResult.protocol)
          .filter((protocol): protocol is NonNullable<CompletedToolResult['protocol']> => Boolean(protocol))
        const nextSystemPrompt = contextManager.buildSystemPrompt(
          agentConfig,
          workspacePath,
          fileAccessGrants,
          fullFilesystemAccess,
          activeToolDefs,
        ) + spreadsheetPolicy
        const currentSystemMessage = messages[0]
        const preservedSystemSuffix = currentSystemMessage?.role === 'system' && currentSystemMessage.content.startsWith(activeSystemPrompt)
          ? currentSystemMessage.content.slice(activeSystemPrompt.length)
          : ''
        if (currentSystemMessage?.role === 'system') {
          messages[0] = { ...currentSystemMessage, content: `${nextSystemPrompt}${preservedSystemSuffix}` }
        }
        activeSystemPrompt = nextSystemPrompt

        const integrityReminder = this.buildToolIntegrityReminder(
          response.toolCalls,
          toolResults,
          activeToolDefs.some((tool) => tool.name === 'read_web_page'),
        )
        if (integrityReminder) messages.push({ role: 'user', content: integrityReminder })

        const visualToolImages = await this.loadToolImages(response.toolCalls, toolResults, ['browser_control'])
        if (visualToolImages.length > 0 && this.supportsVisionInput()) {
          messages.push({
            role: 'user',
            content: 'Browser control supplied visual evidence. First decide whether the requested visible outcome occurred. If it did not, identify one corrective next action and observe again after it. Use the returned visualObservationId with browser_control click_at, type_at, scroll_at, or press_key; do not reuse stale observations.',
            images: visualToolImages,
          })
        } else if (visualToolImages.length > 0) {
          messages.push({
            role: 'user',
            content: 'A browser screenshot was captured, but this text-only primary model cannot inspect it. Do not guess visual coordinates; use a vision-capable primary model for visual browser interaction.',
          })
        }

        const compactedHistory = compactCompletedToolTransactions(messages)
        messages = compactedHistory.messages
        rollingToolEvidence = appendRollingToolEvidence(rollingToolEvidence, compactedHistory.evidence)
        if (rollingToolEvidence && messages[0]?.role === 'system') {
          messages[0] = {
            ...messages[0],
            content: this.withRollingToolEvidence(messages[0].content, rollingToolEvidence),
          }
        }

        const batchSignature = response.toolCalls
          .map((toolCall) => `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`)
          .sort()
          .join('|')
        // Providers sometimes replay the same read batch after a long tool
        // result (especially in hidden Goal-step conversations). Do not emit
        // or execute it repeatedly: the prior result is already in `messages`,
        // so move directly to synthesis. A deferred search is intentionally
        // allowed once so the read_web_page guard can take effect.
        const deferredForPageRead = mustReadWebPageBeforeMoreSearch
          && response.toolCalls.some((toolCall) => toolCall.name === 'web_search')
        if (previousNormalToolBatches.has(batchSignature) && !deferredForPageRead) break
        previousNormalToolBatches.add(batchSignature)

        // Goal steps should not blindly consume their maximum tool budget. At
        // each checkpoint the model first decides whether the evidence is
        // sufficient. The existing message history stays intact if it needs
        // another bounded block of tool calls.
        if (adaptiveToolBudget && iteration + 1 >= nextBudgetCheck && nextBudgetCheck < toolCycleLimit) {
          yield { type: 'thinking', content: `Reviewing progress after ${iteration + 1} tool cycles...` }
          const decision = yield* this.executeLLMCall([
            ...messages,
            {
              role: 'user',
              content: `You have completed ${iteration + 1} model-and-tool cycles for this task. Do not call tools in this response. Decide whether the work can now be completed with the evidence already collected.\n\nReply with exactly one of:\nFINAL: followed by the concise, complete result for the user.\nCONTINUE: followed by a short reason why additional tool evidence is essential.\n\nChoose CONTINUE only when a specific unresolved fact, failed verification, or necessary change still requires tools. Do not continue merely to improve wording.`,
            },
          ], [])
          accumulatedUsage = this.recordModelCallUsage(accumulatedUsage, decision.usage)
          const decisionContent = decision.content.trim()
          if (/^CONTINUE\s*:/i.test(decisionContent)) {
            nextBudgetCheck = Math.min(toolCycleLimit, nextBudgetCheck + Math.max(1, adaptiveToolBudget.extensionIterations))
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

      // Tool calls can legitimately take several passes in a Goal, but normal
      // chat intentionally stops after its first tool batch. In both cases,
      // give the model a final synthesis turn. Some gateways ignore the
      // tool-free instruction and return one last DSML/native call; allow one
      // bounded recovery batch instead of reporting that the task failed.
      const finalVerificationNotice = pendingWriteVerifications.size > 0
        ? ` The following file writes remain unverified: ${this.formatPaths(pendingWriteVerifications)}. Do not call them correct, complete, or successfully verified; state that verification is still required.`
        : ''
      if (latestProtocolResults.length) {
        messages.push({ role: 'user', content: `Structured execution protocol results (authoritative state; do not infer success from prose):\n${JSON.stringify(latestProtocolResults).slice(0, 24_000)}` })
      }
      messages.push({
        role: 'user',
        content: `Tool execution is complete for this response. Using only the evidence already available in this conversation, provide the best concise final answer now. If evidence is incomplete, state the specific unverified limitation plainly and, where useful, the smallest user-facing next step. Do not mention internal tool limits, tool cycles, implementation details, or instructions.${finalVerificationNotice}`,
      })
      yield { type: 'thinking', content: 'Synthesizing the available results...' }
      let finalResponse = yield* this.executeLLMCall(messages, [])
      accumulatedUsage = this.recordModelCallUsage(accumulatedUsage, finalResponse.usage)
      // The model may legitimately discover one or two missing pieces of
      // evidence while synthesizing. Recover those calls in a small bounded
      // loop; do not turn an otherwise executable Agent into a hard failure.
      for (let recoveryAttempt = 0; recoveryAttempt < 2 && activeToolDefs.length > 0; recoveryAttempt += 1) {
        if ((finalResponse.protocolTextDetected || finalResponse.toolCallParseFailure) && finalResponse.toolCalls.length === 0) {
          yield { type: 'thinking', content: '检测到最终阶段仍需要工具，正在执行补充操作...' }
          finalResponse = yield* this.executeLLMCall(messages, activeToolDefs)
          accumulatedUsage = this.recordModelCallUsage(accumulatedUsage, finalResponse.usage)
        }
        if (finalResponse.toolCalls.length === 0) break

        const recoveryCalls = finalResponse.toolCalls.filter((toolCall, index, calls) => {
          const signature = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`
          return calls.findIndex((candidate) => `${candidate.name}:${JSON.stringify(candidate.arguments)}` === signature) === index
        })
        const recoveryResults = new Map<string, CompletedToolResult>()
        for (const toolCall of recoveryCalls) {
          yield { type: 'tool_call', toolCall: { id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments } }
          const toolContext: ToolContext = {
            conversationId: this.config.conversationId,
            workspacePath,
            fileAccessGrants,
            fullFilesystemAccess,
            supportsVisionInput: this.supportsVisionInput(),
            fileService: this.config.fileService,
            terminalService: this.config.terminalService,
            allowedModelPoolIds: agentConfig.modelPoolIds,
            visualAttachments: dedupeToolImages(recentVisualAttachments),
            agentContext: this.buildModelPoolContext(messages, recoveryResults),
          }
          const result = this.normalizeToolResult(await this.executeTool(toolCall, toolContext))
          recoveryResults.set(toolCall.id, result)
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
        messages = this.appendToolMessages(messages, recoveryCalls, recoveryResults)
        messages.push({
          role: 'user',
          content: 'The additional tool result is now available. Provide the concise final answer using the evidence already collected. Do not call another tool and do not emit DSML or XML tool-call markup.',
        })
        finalResponse = yield* this.executeLLMCall(messages, [])
        accumulatedUsage = this.recordModelCallUsage(accumulatedUsage, finalResponse.usage)
      }
      if (finalResponse.protocolTextDetected || finalResponse.toolCallParseFailure) {
        if (finalResponse.content) yield { type: 'text_reset', discardProvisionalText: true }
        const protocolHint = finalResponse.toolCallParseFailure
          ? `（${finalResponse.toolCallParseFailure}）`
          : '（检测到 DSML/XML 工具协议标记，但最终汇总轮未返回可执行调用）'
        yield {
          type: 'error',
          error: `模型在最终汇总阶段返回了未执行的工具协议文本${protocolHint}；之前已执行的工具结果不会被自动标记为最终成功。请重试，或更换兼容工具调用协议的模型。`,
        }
        yield { type: 'done', content: '' }
        return
      }
      if (finalResponse.content.trim()) {
        const finalContent = finalResponse.content.replace(/^FINAL\s*:\s*/i, '').trim()
        yield { type: 'done', content: finalContent || finalResponse.content.trim(), usage: accumulatedUsage }
        return
      }

      yield { type: 'error', error: 'The model did not produce a final answer from the completed tool results. The available evidence remains in the activity record.' }
      yield { type: 'done', content: '' }
    } catch (err: any) {
      if (this.abortController?.signal.aborted) {
        yield { type: 'done', content: '' }
      } else {
        const errorMsg = formatProviderRequestFailure(
          err,
          this.config.provider,
          this.config.agentConfig.model,
          this.config.requestSource || 'chat',
        )
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
  ): AsyncGenerator<AgentEvent, { content: string; reasoningContent?: string; toolCalls: CompletedToolCall[]; finishReason: string; usage?: ChatUsage; toolCallParseFailure?: string; textToolCallEnvelope?: boolean; protocolTextDetected?: boolean }> {
    const { agentConfig, provider } = this.config
    const signal = this.abortController?.signal
    // Tool output can grow on every ReAct cycle. Refit immediately before the
    // provider call, including the serialized tool definitions that providers
    // count as input tokens.
    const modelInputBudget = getModelInputBudgetTokens(agentConfig.model)
    const inputBudget = getToolFollowUpInputBudget(
      modelInputBudget,
      messages.some((message) => message.role === 'tool'),
    )
    const fittedMessages = this.config.contextManager.fitMessages(
      messages,
      inputBudget,
      tools,
    )

    const stream: AsyncIterable<ChatChunk> = provider.chat(
      {
        model: agentConfig.model,
        messages: fittedMessages,
        tools: tools.length > 0 ? tools : undefined,
        temperature: agentConfig.temperature,
        maxTokens: MAX_AGENT_RESPONSE_TOKENS,
        stream: true,
        reasoning: agentConfig.showThinking && provider.supportsReasoning(agentConfig.model)
          ? { enabled: true, budgetTokens: 1024 }
          : undefined,
      },
      signal
    )

    let content = ''
    let reasoningContent = ''
    let receivedReasoning = false
    let finishReason = ''
    let usage: ChatUsage | undefined
    let toolCallParseFailure: string | undefined
    let textToolCallEnvelope = false
    // Do not stream provider protocol markup as user-facing prose. Gateways
    // may split `< | DSML | ...>` across many chunks, so keep a small pending
    // buffer until the stream proves that it is ordinary text.
    let pendingProtocolText = ''
    let protocolTextDetected = false

    // Tool call accumulation state (keyed by chunk index)
    const tcAccumulator: Map<number, { id: string; name: string; argsStr: string }> = new Map()

    try {
      for await (const chunk of stream) {
        // Check abort between chunks
        if (signal?.aborted) break
        // A streaming request is still one model call. OpenAI-compatible
        // gateways commonly repeat a cumulative usage snapshot on every text
        // chunk, so adding it here inflates tokens and calls by chunk count.
        usage = this.selectUsageSnapshot(usage, this.toChatUsage(chunk.usage))
        if (chunk.toolCallParseFailure) toolCallParseFailure = chunk.toolCallParseFailure
        if (chunk.textToolCallEnvelope) textToolCallEnvelope = true

        if (agentConfig.showThinking && chunk.reasoningContent) {
          receivedReasoning = true
          reasoningContent += chunk.reasoningContent
          yield { type: 'reasoning', content: chunk.reasoningContent }
        }

        // ── Text content ──────────────────────────────────────────────────────
        if (chunk.content) {
          content += chunk.content
          pendingProtocolText += chunk.content
          const protocolIndex = pendingProtocolText.search(/<\s*(?:(?:[|｜]\s*){1,2}DSML(?:\s*[|｜]){1,2}\s*(?:tool_calls?|toolcalls|invoke|parameter)|tool_call\b|function=)/i)
          if (protocolIndex >= 0) {
            const visiblePrefix = pendingProtocolText.slice(0, protocolIndex)
            if (visiblePrefix) yield { type: 'text', content: visiblePrefix }
            pendingProtocolText = pendingProtocolText.slice(protocolIndex)
            protocolTextDetected = true
          } else if (pendingProtocolText.length > 96) {
            // Retain enough suffix for a marker split at a chunk boundary.
            const safeLength = pendingProtocolText.length - 48
            yield { type: 'text', content: pendingProtocolText.slice(0, safeLength) }
            pendingProtocolText = pendingProtocolText.slice(safeLength)
          }
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
    } catch (error) {
      const classified = classifyError(error, provider.id)
      Object.assign(classified, { phase: 'stream' })
      throw classified
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

    // Flush ordinary text only after the provider has finished and we know it
    // was not a tool protocol envelope. This prevents the UI from briefly
    // rendering raw DSML while a tool call is still being assembled.
    // Native structured calls alone do not make the streamed prose invalid;
    // only discard text when a serialized envelope (or parser failure) was
    // actually observed.
    const protocolWasReturned = protocolTextDetected || toolCallParseFailure || textToolCallEnvelope
    if (pendingProtocolText && !protocolWasReturned) {
      yield { type: 'text', content: pendingProtocolText }
    }

    const contextDiagnostics = this.config.contextManager.getLastDiagnostics()
    return {
      content,
      ...(reasoningContent ? { reasoningContent } : {}),
      toolCalls,
      finishReason,
      usage: usage ? { ...usage, ...(contextDiagnostics ? { contextDiagnostics } : {}) } : usage,
      toolCallParseFailure,
      textToolCallEnvelope,
      protocolTextDetected,
    }
  }

  private toChatUsage(usage?: ChatChunk['usage']): ChatUsage | undefined {
    if (!usage) return undefined
    const promptTokens = Math.max(0, usage.promptTokens || 0)
    const completionTokens = Math.max(0, usage.completionTokens || 0)
    const cachedTokens = usage.cachedTokens
    const cacheMissTokens = usage.cacheMissTokens
      ?? (typeof cachedTokens === 'number' ? Math.max(0, promptTokens - cachedTokens) : undefined)
    const rateCardCost = resolveRateCardUsageCost(this.config.provider.id, this.config.agentConfig.model, {
      promptTokens,
      completionTokens,
      ...(typeof cachedTokens === 'number' ? { cachedTokens } : {}),
    })
    const connectionPricing = resolveConnectionPricingMode(this.config.provider.id)
    return {
      promptTokens,
      completionTokens,
      ...(typeof cachedTokens === 'number' ? { cachedTokens } : {}),
      ...(typeof cacheMissTokens === 'number' ? { cacheMissTokens } : {}),
      ...(typeof usage.providerReportedCost === 'number'
        ? {
            providerReportedCost: usage.providerReportedCost,
            ...(usage.providerReportedCurrency ? { providerReportedCurrency: usage.providerReportedCurrency } : {}),
            costSource: 'provider' as const,
          }
        : { ...connectionPricing, ...rateCardCost }),
      modelCalls: 1,
    }
  }

  /**
   * Stream usage is a per-request cumulative snapshot, not a delta. Retain
   * the largest snapshot and prefer the latest one on a tie so a gateway that
   * reports it on every chunk still contributes exactly one model call.
   */
  private selectUsageSnapshot(current?: ChatUsage, next?: ChatUsage): ChatUsage | undefined {
    if (!current) return next
    if (!next) return current
    const currentTotal = current.promptTokens + current.completionTokens
    const nextTotal = next.promptTokens + next.completionTokens
    return nextTotal >= currentTotal ? next : current
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
      estimatedCost: this.sameEstimatedCost(current, next),
      estimatedCostCurrency: current.estimatedCostCurrency || next.estimatedCostCurrency,
      providerReportedCost: this.sameCurrencyCost(current, next),
      providerReportedCurrency: current.providerReportedCurrency || next.providerReportedCurrency,
      costSource: current.costSource === 'provider' || next.costSource === 'provider' ? 'provider' : current.costSource || next.costSource,
      rateCardId: current.rateCardId || next.rateCardId,
      rateCardUpdatedAt: current.rateCardUpdatedAt || next.rateCardUpdatedAt,
      pricingMode: current.pricingMode === 'subscription' || next.pricingMode === 'subscription' ? 'subscription' : current.pricingMode || next.pricingMode,
      pricingSourceUrl: current.pricingSourceUrl || next.pricingSourceUrl,
      modelCalls: (current.modelCalls ?? 1) + (next.modelCalls ?? 1),
      modelCallUsage: current.modelCallUsage || next.modelCallUsage,
      contextDiagnostics: next.contextDiagnostics || current.contextDiagnostics,
    }
  }

  /** Keep the provider usage boundary for each model request as well as the aggregate. */
  private recordModelCallUsage(total?: ChatUsage, callUsage?: ChatUsage): ChatUsage | undefined {
    const merged = this.mergeUsage(total, callUsage)
    if (!merged || !callUsage) return merged
    const call = {
      promptTokens: callUsage.promptTokens,
      completionTokens: callUsage.completionTokens,
      ...(callUsage.cachedTokens !== undefined ? { cachedTokens: callUsage.cachedTokens } : {}),
      ...(callUsage.cacheMissTokens !== undefined ? { cacheMissTokens: callUsage.cacheMissTokens } : {}),
      ...(callUsage.contextDiagnostics ? { contextDiagnostics: callUsage.contextDiagnostics } : {}),
    }
    return {
      ...merged,
      modelCallUsage: [...(total?.modelCallUsage || []), call],
    }
  }

  private addOptional(left?: number, right?: number): number | undefined {
    if (left === undefined && right === undefined) return undefined
    return (left ?? 0) + (right ?? 0)
  }

  private sameCurrencyCost(current: ChatUsage, next: ChatUsage): number | undefined {
    if (current.providerReportedCost === undefined) return next.providerReportedCost
    if (next.providerReportedCost === undefined) return current.providerReportedCost
    if (current.providerReportedCurrency !== next.providerReportedCurrency) return undefined
    return current.providerReportedCost + next.providerReportedCost
  }

  private sameEstimatedCost(current: ChatUsage, next: ChatUsage): number | undefined {
    if (current.estimatedCost === undefined) return next.estimatedCost
    if (next.estimatedCost === undefined) return current.estimatedCost
    if (current.estimatedCostCurrency !== next.estimatedCostCurrency) return undefined
    return current.estimatedCost + next.estimatedCost
  }

  private withRollingToolEvidence(systemPrompt: string, evidence: string): string {
    const existingBlock = new RegExp(`\\n*${ROLLING_TOOL_EVIDENCE_START}[\\s\\S]*?${ROLLING_TOOL_EVIDENCE_END}`, 'g')
    return `${systemPrompt.replace(existingBlock, '').trimEnd()}\n\n${ROLLING_TOOL_EVIDENCE_START}\n${evidence}\n${ROLLING_TOOL_EVIDENCE_END}`
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
      if (this.teamDelegationUsed) {
        return {
          result: 'Error: delegate_to_team was already executed in this chat turn. Do not start the team again; continue from the existing team result or finish the response.',
          isError: true,
        }
      }
      const goal = typeof toolCall.arguments.goal === 'string' ? toolCall.arguments.goal.trim() : ''
      if (!goal) return { result: 'Error: delegate_to_team requires a non-empty goal.', isError: true }
      this.teamDelegationUsed = true
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
      const estimatedSteps = typeof toolCall.arguments.estimatedSteps === 'number' && Number.isFinite(toolCall.arguments.estimatedSteps)
        ? Math.floor(toolCall.arguments.estimatedSteps)
        : 0
      if (estimatedSteps < 5) {
        return {
          result: 'Goal execution was not started. Automatic Goal mode requires at least 5 independent execution steps. Continue this request directly with the available tools unless the user explicitly asks to use Goal.',
          isError: false,
        }
      }
      try { return { result: await this.config.runGoal(goal, estimatedSteps), isError: false } } catch (error: any) { return { result: `Error: Goal execution failed: ${error?.message ?? String(error)}`, isError: true } }
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

    const mcpAllowed = toolCall.name.startsWith('mcp__') && this.config.agentConfig.tools.includes('mcp:*')
    const isPersonalPreferenceTool = toolCall.name === 'manage_personal_preferences'
    const isSpreadsheetTool = toolCall.name === 'spreadsheet'
    if (!this.config.agentConfig.tools.includes(toolCall.name) && !mcpAllowed && !isPersonalPreferenceTool && !isSpreadsheetTool) {
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
        content: compactToolResultForModel(tc.name, tr?.result ?? ''),
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
    toolResults: Map<string, CompletedToolResult>,
    canReadWebPages: boolean,
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
      return canReadWebPages
        ? 'Research continuation: the search result contains navigation snippets, not webpage evidence. Before another web_search or a source-backed conclusion, use read_web_page on one or more relevant returned URLs. Search again only if those pages are inaccessible, irrelevant, or reveal a specific evidence gap.'
        : 'Research integrity notice: base current-information claims only on the returned search results or pages read in this execution. Include the relevant returned source URLs or explicitly distinguish your own inference from sourced facts.'
    }

    return undefined
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
