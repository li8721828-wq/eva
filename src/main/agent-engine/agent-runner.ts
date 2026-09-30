import type { LLMProvider } from '../providers/base-provider'
import fs from 'fs'
import path from 'path'
import type { ToolExecutor, ToolContext, ToolRegistry, FileService, TerminalService, ToolResultImage } from '../tools'
import type { AgentConfig, AgentEvent } from '../../shared/types/agent'
import type { ChatMessage, ChatUsage, ModelCallTiming, ResponseTiming, ToolCallTiming } from '../../shared/types/conversation'
import type { ToolDefinition, ChatMessageInput, ChatChunk } from '../../shared/types/provider'
import { ContextManager } from './context'
import { DEFAULT_MAX_ITERATIONS, getModelInputBudgetTokens } from '../../shared/constants'
import { appendRollingToolEvidence, compactCompletedToolTransactions, compactToolResultForModel } from './tool-result-context'
import { learnEnvironmentRuleFromFailure } from '../services/environment-profile-service'
import type { FileAccessGrant } from '../../shared/types/file-access'
import type { ModelPool } from '../../shared/types/model-pool'
import type { ExecutionEnvelope } from '../../shared/types/execution-protocol'
import type { ProviderRegistry } from '../providers'
import { resolveConnectionPricingMode, resolveRateCardUsageCost } from '../services/usage-pricing-service'
import { ensureProviderPricing } from '../services/supplier-pricing-service'
import { formatProviderRequestFailure, type ProviderRequestSource } from '../services/provider-request-diagnostics'
import { classifyError, InvalidRequestError } from '../providers/errors'
import { describeModelCapabilityProfile, inferModelCapabilities } from '../../shared/model-capabilities'
import { randomUUID } from 'crypto'
import type { AgentRunEventStore } from '../storage/agent-run-event-store'
import type { AutomationConfig } from '../../shared/types/automation'
import { resolveSandboxPolicy } from '../services/sandbox/policy'
import { openSandboxScope, closeSandboxScope } from '../services/sandbox/scope'
import { ToolDispatcher } from '../services/tool-dispatcher'

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
  /** Automation settings: tool approval policy and sandbox config. */
  automation?: AutomationConfig
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
  /** Optional durable execution journal for run/turn lifecycle events. */
  eventStore?: AgentRunEventStore
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
const MAX_NORMAL_TOOL_CYCLES = 4
const DEFAULT_AGENT_RESPONSE_TOKENS = 4_096
const REASONING_AGENT_RESPONSE_TOKENS = 8_192
const PARALLEL_SAFE_READ_TOOL_NAMES = new Set(['read_file', 'list_directory', 'search_files', 'web_search', 'read_web_page', 'read_terminal'])
/** Identity of one concrete tool invocation, used to detect repeated batches and calls. */
function toolCallSignature(name: string, toolArguments: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(toolArguments)}`
}
// Directory/search results commonly identify the next file to read, so they
// remain in the bounded loop. A concrete read is usually sufficient to
// synthesize immediately.
function isFastSynthesisReadTool(name: string): boolean {
  return ['read_file', 'read_terminal', 'read_web_page', 'inspect_runtime'].includes(name)
}
// Reads of local files are only valid for the workspace state they observed.
const LOCAL_FILE_READ_TOOL_NAMES = new Set(['read_file', 'list_directory', 'search_files'])
const WORKSPACE_MUTATION_TOOL_NAMES = new Set(['write_file', 'edit_file', 'execute_command'])
// A lone successful read usually answers the request, but the same shape also
// opens work that still needs an action. Ask the model itself before closing.
const LONE_READ_CHECKPOINT_PROMPT = `You have the content you asked for. Decide whether the user's request can now be completed with the evidence already collected.

Reply with exactly one of:
FINAL: followed by the concise, complete answer for the user.
CONTINUE: followed by the specific action that is still required.

Choose CONTINUE whenever the request needs a change, a command, or a verification that has not happened yet. Never present unperformed work as complete.`
const SEARCH_UNAVAILABLE_MARKER = '[SEARCH_UNAVAILABLE]'
// Tool-generated screenshots need an independent bound from user attachments.
const MAX_TOOL_REVIEW_IMAGE_BYTES = 32 * 1024 * 1024

function normalizePendingUserMessage(message: RunParams['newMessage']): ChatMessage {
  const candidate = message as unknown
  if (typeof candidate === 'string') {
    return {
      id: '__pending_user_msg__',
      conversationId: '',
      role: 'user',
      content: candidate,
      timestamp: Date.now(),
    }
  }
  return {
    ...message,
    id: '__pending_user_msg__',
    role: message.role || 'user',
    content: message.content || '',
    timestamp: message.timestamp || Date.now(),
  }
}

/**
 * Some coding-plan gateways return an English client/quota notice with a 200
 * response. It is neither an answer nor a provider error object, so detect it
 * before it can become a persisted assistant message.
 */
function isGatewayInstructionLeak(content: string): boolean {
  // Require a gateway envelope, not quoted troubleshooting text.
  if (!/^(?:\[req_[\w-]+\]\s*\[[^\]\r\n]+\]\s*\*\*Bad request from AI provider\*\*|\d+ cached tokens\.)/i.test(content.trim())) return false
  const markers = [
    /do not resend the same request/i,
    /these responses are optimized for (?:opencode|claude code|codex)/i,
    /if you are using a non-standard client/i,
    /recommended tools:/i,
  ]
  return markers.filter((pattern) => pattern.test(content)).length >= 2
}
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

/**
 * Derive a {@link SandboxContext} from the active {@link AgentRunnerConfig}.
 * Returns null when sandbox is effectively off (including when the user is in
 * `normal` mode and explicitly disabled the sandbox).
 */
function buildSandboxContext(config: AgentRunnerConfig): import('../services/sandbox/types').SandboxContext | null {
  const automation = config.automation
  if (!automation) return null
  const policy = resolveSandboxPolicy(automation.toolApproval.policy, automation.sandbox, automation.mode)
  if (!policy.sandboxActive) return null
  return {
    workspacePath: config.workspacePath,
    fileAccessGrants: config.fileAccessGrants ?? [],
    extraAllowedPaths: automation.sandbox.extraAllowedPaths,
    allowNetwork: automation.sandbox.allowNetwork,
    level: policy.effectiveSandboxLevel,
  }
}

export class AgentRunner {
  private config: AgentRunnerConfig
  private readonly toolDispatcher: ToolDispatcher
  private abortController: AbortController | null = null
  private isRunning = false
  private runStartedAt = 0
  private contextBuildMs = 0
  private modelCallTimings: ModelCallTiming[] = []
  private toolCallTimings: ToolCallTiming[] = []
  /** Prevent a model feedback-loop from restarting the whole team in one chat turn. */
  private teamDelegationUsed = false
  private currentRunId = ''
  private currentTurnId = ''

  constructor(config: AgentRunnerConfig) {
    this.config = config
    this.toolDispatcher = new ToolDispatcher({
      toolRegistry: config.toolRegistry,
      agentTools: config.agentConfig.tools,
      requestToolApproval: config.requestToolApproval,
      allowedWritePaths: config.allowedWritePaths,
    })
  }

  /**
   * Execute one direct tool batch for ordinary chat, then synthesize its
   * results. Goal steps opt into the bounded ReAct loop because dependent
   * actions such as inspect -> edit -> verify need later tool decisions.
   */
  async *run(params: RunParams): AsyncGenerator<AgentEvent> {
    if (this.isRunning) {
      yield { type: 'error', error: '上一个任务仍在同一个执行器中运行，本次请求未发送。请等待它完成，或先停止上一轮。' }
      return
    }

    this.isRunning = true
    this.teamDelegationUsed = false
    this.abortController = new AbortController()
    this.runStartedAt = Date.now()
    this.contextBuildMs = 0
    this.modelCallTimings = []
    this.toolCallTimings = []
    this.currentRunId = randomUUID()
    this.currentTurnId = randomUUID()

    // Bind the sandbox context for the duration of this run. The context is
    // derived from the automation config and includes the workspace + grants
    // that the per-backend policy evaluates against. It lives in a per-run
    // scope registry so concurrent runs cannot clear each other's policy when
    // the first one finishes.
    const sandboxScopeToken = openSandboxScope(buildSandboxContext(this.config))

    try {
      const userMessage = normalizePendingUserMessage(params.newMessage)
      await this.config.eventStore?.appendLifecycle(this.currentRunId, this.currentTurnId, 'run_started')
      await this.config.eventStore?.appendLifecycle(this.currentRunId, this.currentTurnId, 'turn_started')

      // Synchronize the active supplier connection before any model call so a
      // newly used connection does not require a separate Cost Center visit.
      // Not awaited: pricing is hydrated when a conversation is read, while
      // this refresh is an untimed request to the supplier, and the first token
      // must not wait on it.
      void ensureProviderPricing(this.config.provider.id).catch(() => undefined)
      const { agentConfig, toolRegistry, contextManager, workspacePath, fileAccessGrants, fullFilesystemAccess } = this.config
      const configuredMaxIterations = this.config.maxIterations ?? agentConfig.maxIterations ?? DEFAULT_MAX_ITERATIONS
      // Detailed process output is a user-facing step mode. It must not turn
      // provider-private slow reasoning into the main visible activity, and
      // it executes one tool operation per model turn so the next decision is
      // made from the fresh result.
      const stepwiseProcessMode = agentConfig.processOutput === 'detailed'
      const adaptiveToolBudget = this.config.adaptiveToolBudget
      const maxIter = adaptiveToolBudget
        ? Math.max(1, Math.min(configuredMaxIterations, adaptiveToolBudget.maxIterations))
        : configuredMaxIterations
      // Normal chat follows only model-requested tool calls. It has a generous
      // safety ceiling, while exact repeated tool batches terminate early to
      // prevent a failed lookup from turning into an open-ended loop.
      const toolCycleLimit = adaptiveToolBudget ? maxIter : Math.min(maxIter, MAX_NORMAL_TOOL_CYCLES)
      const modelCapabilities = this.config.providerRegistry?.getModelCapabilities(this.config.provider.id, agentConfig.model)
        || inferModelCapabilities(this.config.provider.type, agentConfig.model)
      if (agentConfig.tools.length > 0 && modelCapabilities.supportsTools === false) {
        yield {
          type: 'error',
          error: `模型 ${agentConfig.model} 不支持工具调用（${describeModelCapabilityProfile(modelCapabilities)}）。请为该智能体配置支持工具的聊天模型；本轮未发送请求。`,
        }
        return
      }
      let nextBudgetCheck = adaptiveToolBudget
        ? Math.max(1, Math.min(toolCycleLimit, adaptiveToolBudget.initialIterations))
        : toolCycleLimit
      if (this.shouldRequestProviderReasoning(agentConfig) && !this.config.provider.supportsReasoning(agentConfig.model)) {
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
      // A successful workspace mutation invalidates earlier local reads so a
      // verification read can never be served pre-edit content from the cache.
      let workspaceRevision = 0
      const readOnlyCacheKey = (toolName: string, toolArguments: Record<string, unknown>): string => {
        const fingerprint = `${toolName}:${JSON.stringify(toolArguments)}`
        return LOCAL_FILE_READ_TOOL_NAMES.has(toolName) ? `rev${workspaceRevision}:${fingerprint}` : fingerprint
      }
      const mutatesWorkspace = (toolName: string, toolArguments: Record<string, unknown>): boolean => {
        if (WORKSPACE_MUTATION_TOOL_NAMES.has(toolName)) return true
        return toolName === 'spreadsheet' && (toolArguments.action === 'create' || toolArguments.action === 'update')
      }
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
      // Set by a recovery branch to change how the *next* loop call is made.
      let nextCallOverrides: { disableReasoning?: boolean } | undefined
      let protocolRepairAttempts = 0
      let continuationDirectiveAttempts = 0
      let latestProtocolResults: NonNullable<CompletedToolResult['protocol']>[] = []
      let rollingToolEvidence = ''
      // A repeated tool batch only ends the loop while the workspace state its
      // earlier result observed is unchanged; the value is the revision that
      // was current when the batch last ran.
      const previousNormalToolBatches = new Map<string, number>()
      // Every call this run has actually executed. The synthesis recovery batch
      // consults it so a repeated call cannot run a mutation a second time.
      const executedToolSignatures = new Set<string>()
      let consecutiveSearchFailures = 0

      // The agent's configured catalog is loaded in full for every run. Which
      // tool to call is the model's decision, not a keyword match on this
      // turn's text; the agent config stays the authorization boundary.
      const activeToolDefs: ToolDefinition[] = allToolDefs
      const spreadsheetPolicy = hasSpreadsheetAttachment
        ? '\n\n--- Spreadsheet attachment policy ---\nA spreadsheet attachment is present. Use the structured `spreadsheet` tool first. Make one `inspect` call without a `sheet` argument to get the workbook and sheet overview; inspect an individual sheet only when the first result shows it is necessary. Use `create` or `update` only when the user explicitly requests a file change. Do not write Python, PowerShell, Node, or other scripts for spreadsheet work unless the spreadsheet tool returns an error or explicitly reports that the requested operation is unsupported. If fallback is needed, report the spreadsheet tool failure before using `execute_command`. Do not repeat an identical spreadsheet call.\n'
        : ''
      const modelCapabilityPolicy = this.buildModelCapabilityPolicy(modelCapabilities, activeToolDefs.length > 0)
      const contextBuildStartedAt = Date.now()
      let activeSystemPrompt = contextManager.buildSystemPrompt(
        agentConfig,
        workspacePath,
        fileAccessGrants,
        fullFilesystemAccess,
        activeToolDefs,
      ) + spreadsheetPolicy + modelCapabilityPolicy
      let messages: ChatMessageInput[] = contextManager.buildContext({
        agentConfig,
        messages: safeAllHistory,
        workspacePath,
        fileAccessGrants,
        fullFilesystemAccess,
        maxContextTokens: getModelInputBudgetTokens(agentConfig.model, modelCapabilities.contextWindowTokens),
        tools: activeToolDefs,
        systemPromptSuffix: spreadsheetPolicy + modelCapabilityPolicy,
      })
      this.contextBuildMs = Date.now() - contextBuildStartedAt

      // ── Tool execution loop ─────────────────────────────────────────────────
      for (let iteration = 0; iteration < toolCycleLimit; iteration++) {
        if (this.abortController.signal.aborted) {
          yield { type: 'done', content: '', timing: this.buildResponseTiming() }
          return
        }

        yield {
          type: 'thinking',
          content: iteration === 0 ? 'Preparing the response and any required tools...' : 'Reviewing the tool results...',
        }

        // Call LLM (yields real-time text_delta events to caller). The override
        // applies only to a recovery retry requested by the previous response
        // and is consumed here so later calls return to the configured route.
        const response = yield* this.executeLLMCall(messages, activeToolDefs, nextCallOverrides)
        nextCallOverrides = undefined
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

        const requestedToolCallCount = response.toolCalls.length
        if (stepwiseProcessMode && requestedToolCallCount > 1) {
          // Do not execute a whole model batch before the model sees any
          // observation. The remaining calls are intentionally reconsidered
          // after the first result, which preserves a visible ReAct rhythm.
          response.toolCalls = response.toolCalls.slice(0, 1)
          yield { type: 'thinking', content: '详细步骤模式：本轮只执行一个工具操作，结果返回后重新判断。' }
        }

        const hasToolCalls = response.toolCalls.length > 0

        // No tool calls → the model is done reasoning
        if (!hasToolCalls) {
          if (response.protocolTextDetected && !response.toolCallParseFailure && activeToolDefs.length > 0 && protocolRepairAttempts < 1) {
            protocolRepairAttempts += 1
            if (response.content) yield { type: 'text_reset', discardProvisionalText: true, reason: 'protocol-repair' }
            completedResponse = ''
            messages.push({
              role: 'user',
              content: 'Your previous response returned tool-call protocol markup without an executable structured call. Retry using the provided structured tool-calling interface only. Do not emit DSML, XML, or tool-call markup as ordinary response text. Answer the user\'s most recent message directly; do not continue unrelated earlier work.',
            })
            yield { type: 'thinking', content: '检测到未执行的工具协议文本，正在按标准工具协议重试一次。' }
            continue
          }
          if (response.protocolTextDetected && !response.toolCallParseFailure) {
            if (response.content) yield { type: 'text_reset', discardProvisionalText: true, reason: 'protocol-repair' }
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
            if (response.content) yield { type: 'text_reset', discardProvisionalText: true, reason: 'protocol-repair' }
            completedResponse = ''
            messages.push({
              role: 'user',
              content: 'Your previous response attempted a tool call, but the gateway returned an invalid text envelope and nothing was executed. Retry the needed operation now using the provided structured tool-calling interface only. Do not emit DSML, XML, or tool-call markup as ordinary response text. Answer the user\'s most recent message directly; do not continue unrelated earlier work.',
            })
            yield { type: 'thinking', content: '检测到未执行的工具调用格式，正在按标准工具协议重试一次。' }
            continue
          }
          if (response.toolCallParseFailure) {
            // A second malformed/unsupported text envelope is not a valid
            // answer. The provider may have streamed DSML/XML as provisional
            // text; clear it before surfacing a concise execution error so
            // protocol markup never becomes part of the user-visible reply.
            if (response.content) yield { type: 'text_reset', discardProvisionalText: true, reason: 'protocol-repair' }
            yield {
              type: 'error',
              error: '模型返回了无法执行的工具协议文本；本轮未执行该工具。请确认 Agent 已启用所需工具，或让当前 Agent 直接完成该步骤。',
            }
            return
          }
          const continuationDirective = response.content.match(/^CONTINUE\s*:\s*([\s\S]*)$/i)?.[1]?.trim()
          if (continuationDirective && activeToolDefs.length > 0 && continuationDirectiveAttempts < 2) {
            continuationDirectiveAttempts += 1
            if (response.content) yield { type: 'text_reset', discardProvisionalText: true, reason: 'protocol-repair' }
            completedResponse = ''
            messages.push({ role: 'assistant', content: continuationDirective })
            messages.push({
              role: 'user',
              content: 'The preceding text was an internal continuation decision, not a final answer. Complete the specific remaining action now with the available structured tools, then provide the user-facing result. Do not emit CONTINUE: or FINAL: markers in ordinary text.',
            })
            yield { type: 'thinking', content: `已识别待完成事项：${continuationDirective.slice(0, 180)}` }
            continue
          }
          if (!response.content.trim() && emptyResponseRetries < MAX_EMPTY_RESPONSE_RETRIES) {
            emptyResponseRetries += 1
            // Retrying the identical request reproduces the identical failure.
            // An empty answer from a reasoning route means the budget went to
            // thinking the user never sees, so the retry switches that mode off.
            const truncated = response.finishReason === 'length'
            nextCallOverrides = { disableReasoning: true }
            messages.push({
              role: 'user',
              content: truncated
                ? 'The previous attempt reached the provider output limit before producing any user-visible text, so everything it generated was internal reasoning. Reply with the answer itself now and keep internal reasoning to a minimum; the answer must be visible text.'
                : 'The previous request did not include a final answer. Reply with the concise user-facing answer now. Do not return reasoning-only content, an empty message, or tool-call markup.',
            })
            yield {
              type: 'thinking',
              content: truncated
                ? '供应商在产出正文前就用尽了输出上限，正在关闭思考模式后重试一次。'
                : '供应商未返回最终答案，正在关闭思考模式后重试一次。',
            }
            continue
          }
          if (!response.content.trim()) {
            const attemptHint = emptyResponseRetries > 0
              ? '已关闭思考模式重试一次仍未产出正文。'
              : ''
            yield {
              type: 'error',
              error: `${this.describeEmptyResponse(response, agentConfig.model, hasImageInput)}${attemptHint}`,
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
          const finalResponseContent = completedResponse.replace(/^FINAL\s*:\s*/i, '').trim()
          await this.config.eventStore?.appendLifecycle(this.currentRunId, this.currentTurnId, 'turn_completed', { id: randomUUID(), kind: 'assistant_output', status: 'completed', content: finalResponseContent })
          await this.config.eventStore?.appendLifecycle(this.currentRunId, this.currentTurnId, 'run_completed')
          yield { type: 'done', content: finalResponseContent || completedResponse, finishReason: response.finishReason, usage: accumulatedUsage, timing: this.buildResponseTiming() }
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
        const activeToolNames = new Set(activeToolDefs.map((tool) => tool.name))
        const unavailableToolCalls = response.toolCalls.filter((toolCall) => !activeToolNames.has(toolCall.name))
        for (const toolCall of unavailableToolCalls) {
          const result: CompletedToolResult = {
            result: `Tool ${toolCall.name} is not available to this agent. Continue with the tools that are available to you.`,
            isError: true,
          }
          toolResults.set(toolCall.id, result)
          yield { type: 'tool_result', toolResult: { toolCallId: toolCall.id, name: toolCall.name, result: result.result, isError: true } }
        }
        const executableToolCalls = response.toolCalls.filter((toolCall) => activeToolNames.has(toolCall.name))
        // The workspace state this batch observed, captured before any of its
        // own mutations run; repeat detection below compares against it.
        const batchStartRevision = workspaceRevision
        const parallelReadBatch = !mustReadWebPageBeforeMoreSearch && executableToolCalls.length > 1
          && executableToolCalls.every((toolCall) => PARALLEL_SAFE_READ_TOOL_NAMES.has(toolCall.name))
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
          for (const toolCall of executableToolCalls) {
            yield {
              type: 'tool_call',
              toolCall: { id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments },
            }
          }
          const inFlightReadExecutions = new Map<string, Promise<CompletedToolResult>>()
          const completedBatch = await Promise.all(executableToolCalls.map(async (toolCall) => {
            const cacheKey = readOnlyCacheKey(toolCall.name, toolCall.arguments)
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
            executedToolSignatures.add(toolCallSignature(toolCall.name, toolCall.arguments))
            if (toolCall.name === 'web_search') {
              consecutiveSearchFailures = result.result.includes(SEARCH_UNAVAILABLE_MARKER)
                ? consecutiveSearchFailures + 1
                : 0
            }
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
          for (const toolCall of executableToolCalls) {
          // Emit tool_call event
          yield {
            type: 'tool_call',
            toolCall: {
              id: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.arguments,
            },
          }

          if (toolCall.name === 'web_search' && consecutiveSearchFailures >= 3) {
            const deferredResult: CompletedToolResult = {
              result: `${SEARCH_UNAVAILABLE_MARKER} Search has returned no usable results three times in this run. Stop searching and continue with known URLs or an explicitly marked unverified limitation; if this task requires an output file, write and verify it now.`,
              isError: false,
            }
            toolResults.set(toolCall.id, deferredResult)
            yield { type: 'tool_result', toolResult: { toolCallId: toolCall.id, name: toolCall.name, result: deferredResult.result, isError: false } }
            continue
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
          const cacheKey = cacheable ? readOnlyCacheKey(toolCall.name, toolCall.arguments) : ''
          const cached = cacheKey ? readOnlyToolCache.get(cacheKey) : undefined
          const rawResult = cached || await this.executeTool(toolCall, toolContext)
          result = this.normalizeToolResult(rawResult)
          if (toolCall.name === 'web_search') {
            consecutiveSearchFailures = result.result.includes(SEARCH_UNAVAILABLE_MARKER)
              ? consecutiveSearchFailures + 1
              : 0
          }
          if (cacheKey && !cached) readOnlyToolCache.set(cacheKey, result)
          if (result.isError) learnEnvironmentRuleFromFailure(toolCall.name, toolCall.arguments, result.result)
          toolResults.set(toolCall.id, result)
          executedToolSignatures.add(toolCallSignature(toolCall.name, toolCall.arguments))
          if (result.images?.length) {
            recentVisualAttachments = dedupeToolImages([...recentVisualAttachments, ...result.images]).slice(-8)
          }

          const targetPath = this.resolveWorkspacePath(toolCall.arguments.path, workspacePath)
          if (!result.isError && mutatesWorkspace(toolCall.name, toolCall.arguments)) workspaceRevision += 1
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
        messages = this.appendToolMessages(messages, response.toolCalls, toolResults, response.reasoningContent)
        if (stepwiseProcessMode && requestedToolCallCount > response.toolCalls.length) {
          messages.push({
            role: 'user',
            content: 'Detailed step mode: only the first tool operation from the previous response was executed. The other requested operations were not executed. Use this result to decide the next single operation; do not assume the remaining operations are complete.',
          })
        }
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
        ) + spreadsheetPolicy + modelCapabilityPolicy
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
          .map((toolCall) => toolCallSignature(toolCall.name, toolCall.arguments))
          .sort()
          .join('|')
        // Providers sometimes replay the same batch after a long tool result
        // (especially in hidden Goal-step conversations). Do not start another
        // tool-planning turn while the earlier result is already in `messages`
        // and still valid: move directly to synthesis. The recorded revision is
        // the batch's own post-execution revision, so an identical batch
        // repeated after a later mutation (a verification re-read after a
        // write, a command re-run after an edit) is a new observation and runs
        // again. A deferred search is intentionally allowed once so the
        // read_web_page guard can take effect.
        const deferredForPageRead = mustReadWebPageBeforeMoreSearch
          && response.toolCalls.some((toolCall) => toolCall.name === 'web_search')
        const batchRevision = previousNormalToolBatches.get(batchSignature)
        if (batchRevision !== undefined && batchRevision === batchStartRevision && !deferredForPageRead) break
        previousNormalToolBatches.set(batchSignature, workspaceRevision)

        // A lone successful read in normal chat must not start another
        // open-ended tool-planning turn: when it already answers the request,
        // the shared tool-free synthesis below is substantially faster. The
        // same shape also opens work that still needs an action ("read the
        // file, then fix it"), so the model itself decides the next step at a
        // tool-free checkpoint instead of a hard stop.
        const onlyOneExecutableRead = !adaptiveToolBudget
          && executableToolCalls.length === 1
          && isFastSynthesisReadTool(executableToolCalls[0].name)
          && !toolResults.get(executableToolCalls[0].id)?.isError
        if (onlyOneExecutableRead) {
          if (iteration + 1 >= toolCycleLimit) break
          // Reading something else must not finalize unverified writes; reuse
          // the loop's verification nudge instead of closing the turn.
          if (pendingWriteVerifications.size > 0 && activeToolDefs.some((tool) => tool.name === 'read_file')) {
            messages.push({
              role: 'user',
              content: `You wrote ${this.formatPaths(pendingWriteVerifications)} in this run but have not verified the saved contents. Before finalizing, call read_file for each changed path. Do not claim the file is correct or complete until that verification succeeds.`,
            })
            continue
          }
          yield { type: 'thinking', content: 'Reviewing whether the request is complete...' }
          const checkpoint = yield* this.executeLLMCall(
            this.buildFinalSynthesisMessages([
              ...messages,
              { role: 'user', content: LONE_READ_CHECKPOINT_PROMPT },
            ]),
            [],
          )
          accumulatedUsage = this.recordModelCallUsage(accumulatedUsage, checkpoint.usage)
          const checkpointContent = checkpoint.content.trim()
          if (checkpoint.toolCalls.length > 0 || /^CONTINUE\s*:/i.test(checkpointContent)) {
            if (checkpointContent) messages.push({ role: 'assistant', content: checkpointContent })
            messages.push({
              role: 'user',
              content: 'The remaining step is still required. Complete it now with the available tools; do not report it as done until it has actually executed.',
            })
            continue
          }
          const checkpointFinal = checkpointContent.replace(/^FINAL\s*:\s*/i, '').trim()
          if (checkpointFinal && !checkpoint.protocolTextDetected && !checkpoint.toolCallParseFailure) {
            yield { type: 'done', content: checkpointFinal, usage: accumulatedUsage, timing: this.buildResponseTiming() }
            return
          }
          break
        }

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
            yield { type: 'done', content: finalContent, usage: accumulatedUsage, timing: this.buildResponseTiming() }
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
        content: `Tool execution is complete for this response. Using only the evidence already available in this conversation, perform a final editorial pass and provide the best user-facing answer now. First choose the lightest response shape that fits the active request; do not apply a code-review or execution-report template unless the request actually calls for one. Deduplicate overlapping points, drop speculative or low-impact details, and do not restate raw tool evidence. Shorten by selection, not by compression: keep the surviving content in complete sentences and connected prose rather than telegraphic fragments, abbreviations, or arrow chains. Report user-relevant changes and verification when they exist, but never imply that a file was read, changed, or tested without evidence. If the request is a mixed task, answer the primary outcome first and include only the supporting details needed to make it actionable. If evidence is incomplete, state the specific unverified limitation plainly and, where useful, the smallest user-facing next step. Do not mention internal tool limits, tool cycles, or these instructions.${finalVerificationNotice}`,
      })
      yield { type: 'thinking', content: 'Synthesizing the available results...' }
      // Do not send the provider's native tool-call transcript back into the
      // tool-free synthesis request. Some DeepSeek-compatible gateways accept
      // the tool transaction while tools are enabled but return an empty
      // message when that same transcript is followed by a tools=undefined
      // request. Keep the user/system context and flatten completed results
      // into one authoritative evidence message for the final answer.
      let synthesisMessages = this.buildFinalSynthesisMessages(messages)
      let finalResponse = yield* this.executeLLMCall(synthesisMessages, [])
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
          const signature = toolCallSignature(toolCall.name, toolCall.arguments)
          return calls.findIndex((candidate) => toolCallSignature(candidate.name, candidate.arguments) === signature) === index
        })
        // Gateways reach this phase by ignoring the tool-free instruction and
        // repeating a call whose result the model already holds, so re-running
        // it would duplicate the effect the user asked for once. The evidence
        // is already in the message history; decline the repeat and tell the
        // model to answer instead. A call this run has not performed yet is
        // still recovered, because that is what this bounded batch is for.
        const isRepeat = (toolCall: (typeof recoveryCalls)[number]): boolean =>
          executedToolSignatures.has(toolCallSignature(toolCall.name, toolCall.arguments))
        const executableRecoveryCalls = recoveryCalls.filter((toolCall) => !isRepeat(toolCall))
        const declinedRecoveryCalls = recoveryCalls.filter((toolCall) => isRepeat(toolCall))
        const recoveryResults = new Map<string, CompletedToolResult>()
        for (const toolCall of executableRecoveryCalls) {
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
        if (executableRecoveryCalls.length > 0) {
          messages = this.appendToolMessages(messages, executableRecoveryCalls, recoveryResults, finalResponse.reasoningContent)
        }
        messages.push({
          role: 'user',
          content: declinedRecoveryCalls.length > 0
            ? `These calls were not executed again because this run already performed them: ${declinedRecoveryCalls.map((toolCall) => toolCall.name).join(', ')}. Their results are already in this conversation. Do not retry them and do not emit DSML or XML tool-call markup; provide the concise final answer from the evidence already collected.`
            : 'The additional tool result is now available. Provide the concise final answer using the evidence already collected. Do not call another tool and do not emit DSML or XML tool-call markup.',
        })
        synthesisMessages = this.buildFinalSynthesisMessages(messages)
        finalResponse = yield* this.executeLLMCall(synthesisMessages, [])
        accumulatedUsage = this.recordModelCallUsage(accumulatedUsage, finalResponse.usage)
      }

      // Final synthesis is also subject to the provider's per-request output
      // limit. Continue from the exact end instead of persisting a response
      // that stops halfway through a sentence after tool work is complete.
      let finalSynthesisContent = finalResponse.content
      let continuationMessages = synthesisMessages
      for (let attempt = 0; attempt < MAX_PROVIDER_CONTINUATIONS && finalResponse.finishReason === 'length'; attempt += 1) {
        continuationMessages = [
          ...continuationMessages,
          { role: 'assistant', content: finalSynthesisContent },
          { role: 'user', content: 'The final answer was truncated by the provider output limit. Continue from the exact end of the previous answer without repeating it. Finish the current sentence, complete the remaining sections, and then stop naturally. Do not mention this continuation instruction.' },
        ]
        yield { type: 'thinking', content: `最终回复达到长度上限，正在续写未完成部分（${attempt + 1}/${MAX_PROVIDER_CONTINUATIONS}）...` }
        const continuation = yield* this.executeLLMCall(continuationMessages, [])
        accumulatedUsage = this.recordModelCallUsage(accumulatedUsage, continuation.usage)
        if (continuation.protocolTextDetected || continuation.toolCallParseFailure || continuation.toolCalls.length > 0) {
          finalResponse = continuation
          break
        }
        finalSynthesisContent += continuation.content
        finalResponse = { ...continuation, content: finalSynthesisContent }
      }
      if (finalResponse.protocolTextDetected || finalResponse.toolCallParseFailure) {
        // Some DeepSeek-compatible gateways keep emitting DSML during the
        // tool-free synthesis turn even after all spreadsheet/file tools have
        // completed. Give the model one final plain-text-only retry before
        // surfacing an error; never execute a guessed call from this phase.
        if (finalResponse.content) yield { type: 'text_reset', discardProvisionalText: true, reason: 'protocol-repair' }
        messages.push({
          role: 'user',
          content: 'The previous synthesis was invalid because it contained tool-call markup. All requested tool work is already complete. Reply with the concise final answer in ordinary plain text or Markdown only. Do not call tools and do not emit DSML, XML, JSON tool envelopes, or protocol tags.',
        })
        yield { type: 'thinking', content: '最终汇总格式异常，正在重试纯文本回复。' }
        synthesisMessages = this.buildFinalSynthesisMessages(messages)
        const plainTextRetry = yield* this.executeLLMCall(synthesisMessages, [])
        accumulatedUsage = this.recordModelCallUsage(accumulatedUsage, plainTextRetry.usage)
        if (!plainTextRetry.protocolTextDetected && !plainTextRetry.toolCallParseFailure && plainTextRetry.content.trim()) {
          const finalContent = plainTextRetry.content.replace(/^FINAL\s*:\s*/i, '').trim()
          yield { type: 'done', content: finalContent || plainTextRetry.content.trim(), finishReason: plainTextRetry.finishReason, usage: accumulatedUsage, timing: this.buildResponseTiming() }
          return
        }
        const protocolHint = finalResponse.toolCallParseFailure
          ? `（${finalResponse.toolCallParseFailure}）`
          : '（检测到 DSML/XML 工具协议标记，但最终汇总轮未返回可执行调用）'
        yield {
          type: 'error',
          error: `模型在最终汇总阶段返回了未执行的工具协议文本${protocolHint}；之前已执行的工具结果不会被自动标记为最终成功。请重试，或更换兼容工具调用协议的模型。`,
        }
        yield { type: 'done', content: '', timing: this.buildResponseTiming() }
        return
      }
      if (finalResponse.content.trim()) {
        const finalContent = finalResponse.content.replace(/^FINAL\s*:\s*/i, '').trim()
        yield { type: 'done', content: finalContent || finalResponse.content.trim(), finishReason: finalResponse.finishReason, usage: accumulatedUsage, timing: this.buildResponseTiming() }
        return
      }

      // A few OpenAI-compatible gateways (notably DeepSeek-compatible
      // proxies) occasionally close a tool-free synthesis stream with only a
      // finish reason and no visible content. The tool work is already
      // complete at this point, so treat this as a transient synthesis
      // failure and give the model a bounded, plain-text retry. Previously we
      // surfaced the generic error immediately, making a successful 13-tool
      // run look as if it had failed and leaving the user with no answer.
      for (let emptyRetry = 0; emptyRetry < 2; emptyRetry += 1) {
        synthesisMessages.push({
          role: 'user',
          content: 'Your previous final synthesis was empty. Reply now with a concise plain-text answer based only on the completed tool results above. If the evidence is incomplete, state that limitation explicitly. Do not call tools, emit DSML/XML/JSON envelopes, or return an empty response.',
        })
        yield { type: 'thinking', content: '最终汇总为空，正在重试纯文本回复。' }
        // The failed synthesis was empty because the route spent its budget on
        // hidden reasoning; repeating the same request would reproduce it, so
        // the retry asks the provider to stop thinking and answer directly.
        const retryResponse = yield* this.executeLLMCall(synthesisMessages, [], { disableReasoning: true })
        accumulatedUsage = this.recordModelCallUsage(accumulatedUsage, retryResponse.usage)
        if (!retryResponse.protocolTextDetected && !retryResponse.toolCallParseFailure && retryResponse.content.trim()) {
          const finalContent = retryResponse.content.replace(/^FINAL\s*:\s*/i, '').trim()
          yield { type: 'done', content: finalContent || retryResponse.content.trim(), finishReason: retryResponse.finishReason, usage: accumulatedUsage, timing: this.buildResponseTiming() }
          return
        }
        if (retryResponse.protocolTextDetected || retryResponse.toolCallParseFailure) break
      }

      yield { type: 'error', error: '工具已执行完成，但模型没有依据现有结果给出最终答案。已获得的证据仍保留在活动记录中，请重试本轮。' }
      yield { type: 'done', content: '', timing: this.buildResponseTiming() }
    } catch (err: any) {
      if (this.abortController?.signal.aborted) {
        await this.config.eventStore?.appendLifecycle(this.currentRunId, this.currentTurnId, 'turn_interrupted', {
          id: randomUUID(), kind: 'system', status: 'cancelled', content: 'Execution was interrupted before the current model or tool action completed.',
        }).catch(() => undefined)
        yield { type: 'done', content: '', timing: this.buildResponseTiming() }
      } else {
        const errorMsg = formatProviderRequestFailure(
          err,
          this.config.provider,
          this.config.agentConfig.model,
          this.config.requestSource || 'chat',
        )
        yield { type: 'error', error: errorMsg }
        await this.config.eventStore?.appendLifecycle(this.currentRunId, this.currentTurnId, 'run_failed', {
          id: randomUUID(), kind: 'system', status: 'failed', error: errorMsg.slice(0, 1000),
        }).catch(() => undefined)
        if (!(err instanceof InvalidRequestError)) yield { type: 'done', content: '', timing: this.buildResponseTiming() }
      }
    } finally {
      this.isRunning = false
      this.abortController = null
      // Release only this run's sandbox scope so a concurrent run keeps its own.
      closeSandboxScope(sandboxScopeToken)
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

  private buildResponseTiming(): ResponseTiming {
    const modelCalls = this.modelCallTimings.map((timing) => ({ ...timing }))
    const toolCalls = this.toolCallTimings.map((timing) => ({ ...timing }))
    return {
      contextBuildMs: this.contextBuildMs,
      modelDurationMs: modelCalls.reduce((total, timing) => total + timing.durationMs, 0),
      ...(modelCalls[0]?.timeToFirstResponseMs !== undefined
        ? { timeToFirstResponseMs: modelCalls[0].timeToFirstResponseMs }
        : {}),
      toolExecutionMs: toolCalls.reduce((total, timing) => total + timing.durationMs, 0),
      totalMs: Math.max(0, Date.now() - this.runStartedAt),
      modelCalls,
      toolCalls,
    }
  }

  /**
   * Execute a single LLM call with streaming.
   *
   * - Yields `AgentEvent { type: 'text', content: delta }` for each text chunk.
   * - Accumulates tool_call fragments (OpenAI sends arguments as partial JSON strings).
   * - Returns the full accumulated content, completed tool_calls, and finish reason.
   */
  private async *executeLLMCall(
    messages: ChatMessageInput[],
    tools: ToolDefinition[],
    options?: { disableReasoning?: boolean }
  ): AsyncGenerator<AgentEvent, { content: string; reasoningContent?: string; toolCalls: CompletedToolCall[]; finishReason: string; rawFinishReason?: string; reasoningCharacters: number; usage?: ChatUsage; toolCallParseFailure?: string; textToolCallEnvelope?: boolean; protocolTextDetected?: boolean }> {
    const { agentConfig, provider } = this.config
    const signal = this.abortController?.signal
    // Tool output can grow on every ReAct cycle. Refit immediately before the
    // provider call, including the serialized tool definitions that providers
    // count as input tokens.
    const modelCapabilities = this.config.providerRegistry?.getModelCapabilities(this.config.provider.id, agentConfig.model)
      || inferModelCapabilities(this.config.provider.type, agentConfig.model)
    const modelInputBudget = getModelInputBudgetTokens(agentConfig.model, modelCapabilities.contextWindowTokens)
    const fittedMessages = this.config.contextManager.fitMessages(
      messages,
      modelInputBudget,
      tools,
    )

    const modelCallStartedAt = Date.now()
    let firstResponseMs: number | undefined

    let content = ''
    let reasoningContent = ''
    // Characters of provider reasoning, counted even when the user does not
    // display it: a route that spends its whole output budget on hidden
    // reasoning is the main way to get an empty answer from a long request.
    let reasoningCharacters = 0
    let finishReason = ''
    let rawFinishReason = ''
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
    const modelItemId = randomUUID()

    try {
      await this.config.eventStore?.appendLifecycle(this.currentRunId, this.currentTurnId, 'model_call_started', { id: modelItemId, kind: 'model_call', status: 'started', name: provider.name })
      const stream: AsyncIterable<ChatChunk> = provider.chat(
        {
          model: agentConfig.model,
          messages: fittedMessages,
          tools: tools.length > 0 ? tools : undefined,
          temperature: agentConfig.temperature,
          maxTokens: provider.supportsReasoning(agentConfig.model)
            ? REASONING_AGENT_RESPONSE_TOKENS
            : DEFAULT_AGENT_RESPONSE_TOKENS,
          stream: true,
          reasoning: options?.disableReasoning
            ? { enabled: false }
            : this.shouldRequestProviderReasoning(agentConfig) && provider.supportsReasoning(agentConfig.model)
              ? { enabled: true, budgetTokens: 1024 }
              : undefined,
        },
        signal
      )
      for await (const chunk of stream) {
        // Check abort between chunks
        if (signal?.aborted) break
        if (firstResponseMs === undefined && (chunk.content || chunk.reasoningContent || chunk.toolCalls?.length || chunk.finishReason)) {
          firstResponseMs = Date.now() - modelCallStartedAt
        }
        // A streaming request is still one model call. OpenAI-compatible
        // gateways commonly repeat a cumulative usage snapshot on every text
        // chunk, so adding it here inflates tokens and calls by chunk count.
        usage = this.selectUsageSnapshot(usage, this.toChatUsage(chunk.usage))
        if (chunk.toolCallParseFailure) toolCallParseFailure = chunk.toolCallParseFailure
        if (chunk.textToolCallEnvelope) textToolCallEnvelope = true

        if (chunk.reasoningContent) {
          reasoningCharacters += chunk.reasoningContent.length
          if (this.shouldRequestProviderReasoning(agentConfig)) {
            reasoningContent += chunk.reasoningContent
            yield { type: 'reasoning', content: chunk.reasoningContent }
          }
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

        if (chunk.rawFinishReason) rawFinishReason = chunk.rawFinishReason
        if (chunk.finishReason) {
          finishReason = chunk.finishReason
        }
      }
    } catch (error) {
      await this.config.eventStore?.appendLifecycle(this.currentRunId, this.currentTurnId, 'model_call_completed', { id: modelItemId, kind: 'model_call', status: 'failed', name: provider.name, error: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000) }).catch(() => undefined)
      const classified = classifyError(error, provider.id)
      Object.assign(classified, { phase: 'stream' })
      throw classified
    } finally {
      this.modelCallTimings.push({
        durationMs: Date.now() - modelCallStartedAt,
        ...(firstResponseMs !== undefined ? { timeToFirstResponseMs: firstResponseMs } : {}),
      })
    }

    // Covers final synthesis and checkpoints as well as the main tool loop.
    if (isGatewayInstructionLeak(content)) {
      yield { type: 'text_reset', discardProvisionalText: true, reason: 'provider-error' }
      throw new InvalidRequestError(
        '模型服务拒绝了请求并返回客户端提示，未将其作为回答展示。请检查供应商的模型名称与接口兼容性；本轮不会自动重试。',
        provider.id,
      )
    }
    // Record how the stream ended alongside its content. Without the finish
    // reason and reasoning size, an empty model response is indistinguishable
    // from a clean stop in the run journal.
    await this.config.eventStore?.appendLifecycle(this.currentRunId, this.currentTurnId, 'model_call_completed', {
      id: modelItemId, kind: 'model_call', status: 'completed', name: provider.name, content: content.slice(0, 1000),
    }, {
      finishReason: finishReason || null,
      rawFinishReason: rawFinishReason || null,
      reasoningCharacters,
      completionTokens: usage?.completionTokens ?? null,
      contentCharacters: content.length,
    }).catch(() => undefined)

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
      ...(rawFinishReason ? { rawFinishReason } : {}),
      reasoningCharacters,
      usage: usage ? { ...usage, ...(contextDiagnostics ? { contextDiagnostics } : {}) } : usage,
      toolCallParseFailure,
      textToolCallEnvelope,
      protocolTextDetected,
    }
  }

  /**
   * Detailed process output is deliberately separate from provider CoT.
   * Tests and legacy callers without a process mode may still opt into the
   * old reasoning stream explicitly; persisted UI modes never do so.
   */
  private shouldRequestProviderReasoning(agentConfig: AgentConfig): boolean {
    return Boolean(agentConfig.showThinking && !agentConfig.processOutput)
  }

  private buildModelCapabilityPolicy(profile: ReturnType<typeof inferModelCapabilities>, hasTools: boolean): string {
    if (!hasTools) return ''
    const lines = ['\n\n--- Model capability profile ---', `Detected ${describeModelCapabilityProfile(profile)}.`]
    if (profile.protocol === 'deepseek-dsml') {
      lines.push('This is a DeepSeek-compatible route. Prefer the native structured tool_calls interface supplied by Eva. Never emit DSML/XML/tool-call markup as ordinary text; Eva only executes strictly validated parsed envelopes.')
    } else if (profile.protocol === 'unknown') {
      lines.push('The model protocol is unknown. Use only the structured tools supplied by Eva and do not claim a tool ran unless a tool result is returned.')
    }
    if (profile.supportsTools === undefined) {
      lines.push('Tool support is not confirmed for this custom connection. Attempt the supplied structured interface once; if the provider rejects it, report the provider limitation instead of retrying the same call or using protocol text.')
    }
    return lines.join('\n')
  }

  /**
   * Explain an empty model response in terms the user can act on. Every empty
   * answer used to read as the same opaque failure, even though the causes
   * differ: a route that spent its output budget on hidden reasoning, a
   * gateway-specific stop, or an unsupported image input. The finish reason and
   * reasoning size are carried into the message so the cause is visible.
   */
  private describeEmptyResponse(
    response: { finishReason: string; rawFinishReason?: string; reasoningCharacters: number; usage?: ChatUsage },
    model: string,
    hasImageInput: boolean,
  ): string {
    const details = [`finish reason=${response.rawFinishReason || response.finishReason || '未知'}`]
    if (typeof response.usage?.completionTokens === 'number') {
      details.push(`输出 ${response.usage.completionTokens} tokens`)
    }
    if (response.reasoningCharacters > 0) {
      details.push(`${response.reasoningCharacters} 字符为隐藏思考`)
    }

    let advice = '供应商本次响应没有返回任何可见正文。请重试本轮，仍未产出答案时更换连接。'
    if (response.finishReason === 'length') {
      advice = '输出上限在产生正文之前就用完了，生成的内容全部留在内部。请重试本轮，或为该模型提高输出上限。'
    } else if (response.reasoningCharacters > 0) {
      advice = '模型把输出全部用在内部推理上，没有写出可见答案。请重试本轮，或关闭慢思考后重试。'
    } else if (hasImageInput) {
      advice = '所选模型可能不接受图片输入。请移除图片附件后重试，或改用支持视觉的模型。'
    }
    return `模型 ${model} 未返回可见答案（${details.join('；')}）。${advice}`
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
    const startedAt = Date.now()
    const itemId = randomUUID()
    await this.config.eventStore?.appendLifecycle(this.currentRunId, this.currentTurnId, 'tool_started', { id: itemId, kind: 'tool_call', status: 'started', name: toolCall.name })
    let result: CompletedToolResult | undefined
    try {
      result = await this.executeToolInternal(toolCall, toolContext)
      await this.config.eventStore?.appendLifecycle(
        this.currentRunId,
        this.currentTurnId,
        'tool_completed',
        { id: itemId, kind: 'tool_call', status: result.isError ? 'failed' : 'completed', name: toolCall.name, content: result.result.slice(0, 1000) },
        {
          operationId: result.protocol?.operationId || null,
          protocolStatus: result.protocol?.status || null,
          durationMs: result.protocol?.durationMs || null,
        },
      ).catch(() => undefined)
      return result
    } finally {
      this.toolCallTimings.push({
        name: toolCall.name,
        durationMs: Date.now() - startedAt,
        isError: result?.isError ?? true,
      })
    }
  }

  private async executeToolInternal(
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

    return this.toolDispatcher.dispatch({
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
      context: toolContext,
    })
  }

  /**
   * Append assistant's tool_call message and tool result messages to history.
   * The assistant message carries all tool_calls from one LLM response;
   * each tool gets its own tool-role message with the corresponding toolCallId.
   */
  private appendToolMessages(
    messages: ChatMessageInput[],
    toolCalls: CompletedToolCall[],
    toolResults: Map<string, CompletedToolResult>,
    reasoningContent?: string,
  ): ChatMessageInput[] {
    const updated = [...messages]

    // Assistant message that issued the tool calls
    updated.push({
      role: 'assistant',
      content: '',
      ...(reasoningContent?.trim() ? { reasoningContent } : {}),
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

  /**
   * Build a provider-agnostic, tool-free context for final synthesis.
   *
   * Native assistant/tool message pairs are required while executing tools,
   * but a number of compatible gateways are brittle when those pairs are sent
   * again with tools omitted. Flattening the completed results also gives the
   * final model a smaller, explicit evidence block instead of making it infer
   * the answer from a long protocol transcript.
   */
  private buildFinalSynthesisMessages(messages: ChatMessageInput[]): ChatMessageInput[] {
    const toolNames = new Map<string, string>()
    for (const message of messages) {
      if (message.role !== 'assistant' || !message.toolCalls?.length) continue
      for (const toolCall of message.toolCalls) toolNames.set(toolCall.id, toolCall.name)
    }

    const baseMessages = messages.filter((message) => {
      if (message.role === 'tool') return false
      return !(message.role === 'assistant' && message.toolCalls?.length)
    })
    const toolResults = messages.filter((message) => message.role === 'tool' && message.content?.trim())
    if (toolResults.length === 0) return baseMessages

    const maxEvidenceChars = 36_000
    let evidence = ''
    for (const result of toolResults) {
      const label = toolNames.get(result.toolCallId || '') || 'tool'
      const remaining = maxEvidenceChars - evidence.length
      if (remaining <= 0) break
      const body = result.content.trim()
      const prefix = `${label}: `
      evidence += `${evidence ? '\n\n' : ''}${prefix}${body.slice(0, Math.max(0, remaining - prefix.length - 32))}`
      if (body.length > remaining - prefix.length - 32) evidence += '\n[remaining output omitted; use the verified portion above]'
    }

    return [
      ...baseMessages,
      {
        role: 'user',
        content: `Completed tool evidence (authoritative; do not claim anything not supported here):\n${evidence}`,
      },
    ]
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
