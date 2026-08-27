import type { LLMProvider } from '../providers/base-provider'
import { classifyError } from '../providers/errors'
import type { ToolRegistry, FileService, TerminalService } from '../tools/index'
import type { AgentConfig, AgentEvent } from '../../shared/types/agent'
import { markGoalProgressCancelled, type GoalConfig, type GoalStep, type GoalProgress, type TaskStatus, type GoalStepHandoff, type GoalStepAttempt } from '../../shared/types/task'
import type { ToolCall } from '../../shared/types/conversation'
import type { ChatMessageInput } from '../../shared/types/provider'
import type { ChatMessage } from '../../shared/types/conversation'
import { goalStepHandoffPrompt } from '../../shared/goal-step-handoff'
import { AgentRunner } from './agent-runner'
import { ContextManager } from './context'
import type { FileAccessGrant } from '../../shared/types/file-access'
import type { ModelPool } from '../../shared/types/model-pool'
import type { ProviderRegistry } from '../providers'
import { formatProviderRequestFailure } from '../services/provider-request-diagnostics'

const GOAL_ABSOLUTE_MAX_ITERATIONS = 100
export const GOAL_STEP_MAX_ATTEMPTS = 2
const MAX_HANDOFF_CONTEXT_CHARS = 5_000
const MAX_HANDOFF_RESULT_CHARS = 2_000
const MAX_HANDOFF_ITEMS = 8
const MAX_HANDOFF_GUIDANCE_CHARS = 1_200

export function shouldRetryGoalStepError(error: string, providerId: string): boolean {
  return classifyError(new Error(error), providerId).retryable
}

export function goalStepRetryDelayMs(failedAttempt: number): number {
  return Math.min(5_000, 1_000 * Math.pow(2, Math.max(0, failedAttempt - 1)))
}

function compactHandoffResult(value: string, maxChars = 6_000): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  const head = Math.floor(maxChars * 0.68)
  return `${normalized.slice(0, head)} ... [handoff middle omitted] ... ${normalized.slice(-(maxChars - head - 38))}`
}

function compactHandoffItems(values: string[]): string[] {
  return values
    .slice(-MAX_HANDOFF_ITEMS)
    .map((value) => compactHandoffResult(value, MAX_HANDOFF_GUIDANCE_CHARS))
}

export interface GoalStepIterationBudget {
  initialIterations: number
  extensionIterations: number
  maxIterations: number
}

/**
 * Assign an initial execution budget without lowering the Agent's configured
 * ceiling. Repair work commonly needs several inspect-edit-test passes, while
 * read-only investigation usually reaches a useful conclusion sooner.
 */
export function goalStepIterationBudget(step: Pick<GoalStep, 'description'>, agentMaximum: number): GoalStepIterationBudget {
  const description = step.description.toLowerCase()
  const maximum = Math.max(1, Math.min(GOAL_ABSOLUTE_MAX_ITERATIONS, agentMaximum || GOAL_ABSOLUTE_MAX_ITERATIONS))
  const repairWork = /\b(fix|repair|debug|compile|build|test|verify|failure|error)\b|修复|调试|编译|构建|测试|验证|报错/.test(description)
  const investigation = /\b(read|inspect|analyze|analyse|research|search|review|explore)\b|阅读|查看|分析|调研|搜索|审查|探索/.test(description)
  const initialIterations = repairWork ? 36 : investigation ? 16 : 20
  const extensionIterations = repairWork ? 16 : 12
  return {
    initialIterations: Math.min(maximum, initialIterations),
    extensionIterations: Math.min(maximum, extensionIterations),
    maxIterations: maximum,
  }
}

export type GoalEvent =
  | { type: 'goal_started'; goal: string }
  | { type: 'plan_created'; steps: GoalStep[] }
  | { type: 'step_started'; stepId: string; stepIndex: number; agentConversationId?: string; attempt: number; maxAttempts: number; attempts: GoalStepAttempt[] }
  | { type: 'step_conversation'; stepId: string; agentConversationId: string; handoff: GoalStepHandoff }
  | { type: 'step_progress'; stepId: string; content: string }
  | { type: 'step_tool_call'; stepId: string; toolCall: ToolCall }
  | { type: 'step_tool_result'; stepId: string; toolCallId: string; result: string; isError: boolean }
  | { type: 'step_retrying'; stepId: string; attempt: number; maxAttempts: number; attempts: GoalStepAttempt[]; error: string; delayMs: number }
  | { type: 'step_completed'; stepId: string; result: string; attempts?: GoalStepAttempt[] }
  | { type: 'step_failed'; stepId: string; error: string; attempts?: GoalStepAttempt[] }
  | { type: 'plan_adjusted'; steps: GoalStep[]; reason: string }
  | { type: 'summary'; content: string }
  | { type: 'done'; progress: GoalProgress }
  | { type: 'error'; error: string }

export interface GoalPlannerConfig {
  conversationId?: string
  agentConfig: AgentConfig
  provider: LLMProvider
  toolRegistry: ToolRegistry
  contextManager: ContextManager
  workspacePath: string
  fileAccessGrants?: FileAccessGrant[]
  fullFilesystemAccess?: boolean
  fileService: FileService
  terminalService: TerminalService
  modelPools?: ModelPool[]
  providerRegistry?: ProviderRegistry
  maxSteps?: number
  timeout?: number
  /** Creates a hidden, durable child conversation for each Goal step. */
  prepareStepConversation?: (input: { step: GoalStep; handoff: GoalStepHandoff; continuation: boolean }) => Promise<{ conversationId: string; messages: ChatMessage[]; message: ChatMessage }>
  /** Persists the step's execution trace into its hidden child conversation. */
  persistStepEvent?: (input: { step: GoalStep; conversationId: string; event: Extract<GoalEvent, { type: 'step_progress' | 'step_tool_call' | 'step_tool_result' | 'step_completed' | 'step_failed' }> }) => Promise<void>
}

export class GoalPlanner {
  private config: GoalPlannerConfig
  private abortController: AbortController | null = null
  private isRunning: boolean = false
  private currentRunner: AgentRunner | null = null
  private isPaused: boolean = false
  private feedback: Array<{ content: string; createdAt: number }> = []

  constructor(config: GoalPlannerConfig) {
    this.config = config
  }

  async *run(goalConfig: GoalConfig, resumeProgress?: GoalProgress): AsyncGenerator<GoalEvent> {
    this.isRunning = true
    this.abortController = new AbortController()
    this.isPaused = false

    const maxSteps = this.config.maxSteps ?? 15
    const timeout = this.config.timeout ?? 10 * 60 * 1000
    const startTime = Date.now()
    // A long-running goal should not fail merely because its total elapsed time
    // exceeds the configured budget. The budget guards against a goal making no
    // measurable progress between steps instead.
    let lastProgressAt = startTime

    let progress: GoalProgress = resumeProgress
      ? {
          ...resumeProgress,
          steps: resumeProgress.steps.map((step) => ({ ...step, toolCalls: step.toolCalls ? [...step.toolCalls] : undefined })),
          status: 'in_progress',
          completedAt: undefined,
        }
      : {
          goal: goalConfig.goal,
          steps: [],
          currentStepIndex: 0,
          totalSteps: 0,
          status: 'in_progress',
          startedAt: startTime,
        }

    try {
      yield { type: 'goal_started', goal: goalConfig.goal }
      // 1. Generate execution plan
      let steps: GoalStep[] = progress.steps
      if (!resumeProgress || steps.length === 0) {
        try {
          steps = await this.createPlan(goalConfig.goal)
        } catch (err) {
          yield { type: 'error', error: `Failed to create plan: ${(err as Error).message}` }
          progress.status = 'failed'
          progress.completedAt = Date.now()
          yield { type: 'done', progress }
          return
        }
      }

      if (steps.length > maxSteps) {
        steps = steps.slice(0, maxSteps)
      }

      progress.steps = steps
      progress.totalSteps = steps.length
      lastProgressAt = Date.now()
      yield { type: 'plan_created', steps }

      // 2. Execute steps sequentially
      const completedSteps: GoalStep[] = steps.filter((step) => step.status === 'completed')

      for (let i = 0; i < steps.length; i++) {
        // Check abort
        if (this.abortController?.signal.aborted) {
          progress = markGoalProgressCancelled(progress)
          yield { type: 'done', progress }
          return
        }

        // Wait while paused
        while (this.isPaused && !this.abortController?.signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 200))
        }

        if (this.abortController?.signal.aborted) {
          progress = markGoalProgressCancelled(progress)
          yield { type: 'done', progress }
          return
        }

        // Check for an inactive goal rather than a long but productive one.
        if (Date.now() - lastProgressAt > timeout) {
          progress.status = 'failed'
          progress.completedAt = Date.now()
          yield { type: 'error', error: `Goal execution stalled: no step finished for ${Math.ceil(timeout / 60_000)} minutes` }
          yield { type: 'done', progress }
          return
        }

        const step = steps[i]
        if (step.status === 'completed') continue
        if (step.status === 'failed' || step.status === 'cancelled') step.status = 'pending'
        progress.currentStepIndex = i
        step.status = 'in_progress'
        step.maxAttempts = GOAL_STEP_MAX_ATTEMPTS
        step.attempt = 1
        step.startedAt = Date.now()
        step.attempts = [{ attempt: 1, status: 'in_progress', startedAt: step.startedAt }]

        yield {
          type: 'step_started',
          stepId: step.id,
          stepIndex: i,
          agentConversationId: step.agentConversationId,
          attempt: step.attempt,
          maxAttempts: step.maxAttempts,
          attempts: step.attempts,
        }

        let stepResult = ''
        let stepFailed = false

        for (let attempt = 1; attempt <= GOAL_STEP_MAX_ATTEMPTS; attempt += 1) {
          step.attempt = attempt
          const attemptStartedAt = Date.now()
          step.startedAt = attemptStartedAt
          if (attempt > 1) {
            step.attempts = (step.attempts || []).some((entry) => entry.attempt === attempt)
              ? (step.attempts || []).map((entry) => entry.attempt === attempt ? { ...entry, startedAt: attemptStartedAt } : entry)
              : [...(step.attempts || []), { attempt, status: 'in_progress', startedAt: attemptStartedAt }]
          }

          let attemptFailed = false
          try {
            for await (const event of this.executeStep(step, completedSteps, goalConfig.goal)) {
              if (event.type === 'step_completed') {
                stepResult = event.result
              } else if (event.type === 'step_failed') {
                stepResult = event.error
                attemptFailed = true
              } else {
                yield event
              }
            }
          } catch (err) {
            stepResult = (err as Error).message
            attemptFailed = true
          }

          const completedAt = Date.now()
          if (!attemptFailed) {
            step.attempts = (step.attempts || []).map((entry) => entry.attempt === attempt
              ? { ...entry, status: 'completed', completedAt }
              : entry)
            stepFailed = false
            break
          }

          step.attempts = (step.attempts || []).map((entry) => entry.attempt === attempt
            ? { ...entry, status: 'failed', completedAt, error: stepResult }
            : entry)
          const retryable = shouldRetryGoalStepError(stepResult, this.config.provider.id)
          if (!retryable || attempt === GOAL_STEP_MAX_ATTEMPTS) {
            stepFailed = true
            break
          }

          const delayMs = goalStepRetryDelayMs(attempt)
          step.attempts = [...(step.attempts || []), {
            attempt: attempt + 1,
            status: 'in_progress',
            startedAt: Date.now() + delayMs,
          }]
          yield {
            type: 'step_retrying',
            stepId: step.id,
            attempt: attempt + 1,
            maxAttempts: GOAL_STEP_MAX_ATTEMPTS,
            attempts: step.attempts,
            error: stepResult,
            delayMs,
          }
          await new Promise((resolve) => setTimeout(resolve, delayMs))
          if (this.abortController?.signal.aborted) break
        }

        if (this.abortController?.signal.aborted) {
          progress = markGoalProgressCancelled(progress)
          yield { type: 'done', progress }
          return
        }

        step.status = stepFailed ? 'failed' : 'completed'
        step.result = stepResult
        step.completedAt = Date.now()
        lastProgressAt = step.completedAt

        yield stepFailed
          ? { type: 'step_failed', stepId: step.id, error: stepResult, attempts: step.attempts || [] }
          : { type: 'step_completed', stepId: step.id, result: stepResult, attempts: step.attempts || [] }

        completedSteps.push(step)

        // Evaluate progress every 3 steps
        if ((i + 1) % 3 === 0 && i < steps.length - 1 && goalConfig.autoAdjust !== false) {
          const evaluation = await this.evaluateAndAdjust(goalConfig.goal, steps, i + 1)
          if (evaluation.adjusted) {
            const completed = steps.slice(0, i + 1)
            steps = [...completed, ...evaluation.steps]
            progress.steps = steps
            progress.totalSteps = steps.length
            yield { type: 'plan_adjusted', steps: evaluation.steps, reason: evaluation.reason || 'Progress evaluation' }
          }
        }
      }

      // 3. Generate summary
      while (this.isPaused && !this.abortController?.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      if (this.abortController?.signal.aborted) {
        progress = markGoalProgressCancelled(progress)
        yield { type: 'done', progress }
        return
      }
      progress.status = 'completed'
      progress.completedAt = Date.now()
      const summary = await this.generateSummary(goalConfig.goal, completedSteps)
      progress.summary = summary
      yield { type: 'summary', content: summary }
      yield { type: 'done', progress }
    } catch (err) {
      if (this.abortController?.signal.aborted) {
        progress = markGoalProgressCancelled(progress)
      } else {
        progress.status = 'failed'
        yield { type: 'error', error: (err as Error).message }
      }
      progress.completedAt = Date.now()
      yield { type: 'done', progress }
    } finally {
      this.isRunning = false
      this.currentRunner = null
      this.abortController = null
    }
  }

  abort(): void {
    this.abortController?.abort()
    this.currentRunner?.abort()
    this.isPaused = false
  }

  pause(): void {
    this.isPaused = true
  }

  resume(): void {
    this.isPaused = false
  }

  /** User guidance is preserved and supplied to every remaining goal step. */
  addFeedback(content: string): void {
    const trimmed = content.trim()
    if (!trimmed) return
    this.feedback = [...this.feedback.slice(-7), { content: trimmed, createdAt: Date.now() }]
  }

  get running(): boolean {
    return this.isRunning
  }

  get paused(): boolean {
    return this.isPaused
  }

  // === Internal Methods ===

  /**
   * Planning and review calls do not stream, so a provider stall would otherwise
   * leave the whole Goal looking alive with no observable progress. Bound each
   * request independently and retry one transient failure; the Goal itself can
   * still run for much longer as long as it continues completing steps.
   */
  private async completeWithResilience(
    params: Parameters<LLMProvider['chatComplete']>[0],
    label: string,
  ): Promise<Awaited<ReturnType<LLMProvider['chatComplete']>>> {
    const goalTimeout = this.config.timeout ?? 30 * 60 * 1000
    const requestTimeout = Math.max(30_000, Math.min(3 * 60 * 1000, Math.floor(goalTimeout / 4)))
    let lastError: unknown

    for (let attempt = 1; attempt <= 2; attempt++) {
      if (this.abortController?.signal.aborted) throw new Error('Goal execution cancelled')

      const controller = new AbortController()
      const abortFromGoal = () => controller.abort()
      this.abortController?.signal.addEventListener('abort', abortFromGoal, { once: true })

      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          this.config.provider.chatComplete(params, controller.signal),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort()
              reject(new Error(`${label} did not respond within ${Math.ceil(requestTimeout / 60_000)} minutes.`))
            }, requestTimeout)
          }),
        ])
      } catch (error) {
        lastError = error
        if (this.abortController?.signal.aborted) throw new Error('Goal execution cancelled')
        const message = error instanceof Error ? error.message : String(error)
        const retryable = /timeout|timed out|rate.?limit|too many|429|network|fetch failed|econn/i.test(message)
        if (!retryable || attempt === 2) break
        await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt))
      } finally {
        if (timer) clearTimeout(timer)
        this.abortController?.signal.removeEventListener('abort', abortFromGoal)
      }
    }

    throw new Error(formatProviderRequestFailure(
      lastError,
      this.config.provider,
      params.model || this.config.agentConfig.model,
      'goal-plan',
    ))
  }

  private async createPlan(goal: string): Promise<GoalStep[]> {
    const durableMemory = this.config.contextManager.getDurableMemory()
    const messages: ChatMessageInput[] = [
      {
        role: 'system',
        content: `You are an AI agent planning assistant. Analyze goals and create structured execution plans. Output only valid JSON.${durableMemory ? `\n\n${durableMemory}` : ''}`,
      },
      {
        role: 'user',
        content: `You are an AI agent working towards a goal. Analyze the goal and create a step-by-step execution plan.

Goal: ${goal}
Workspace: ${this.config.workspacePath}

Create a JSON plan:
{
  "steps": [
    {
      "id": "step-1",
      "index": 0,
      "description": "Detailed description of what to do in this step"
    }
  ]
}

Rules:
- Create 3-10 concrete, actionable steps
- Order steps logically (dependencies first)
- Each step should be specific enough to execute independently
- Include verification steps where appropriate
- Output ONLY the JSON`,
      },
    ]

    const response = await this.completeWithResilience(
      {
        model: this.config.agentConfig.model,
        messages,
        temperature: 0.3,
        maxTokens: 4096,
      },
      'Goal planning request'
    )

    const content = response.content
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      throw new Error('Failed to parse plan JSON from LLM response')
    }

    const parsed = JSON.parse(jsonMatch[0])
    const steps: GoalStep[] = (parsed.steps || []).map((s: any, i: number) => ({
      id: s.id || `step-${i + 1}`,
      index: i,
      description: s.description || s.title || `Step ${i + 1}`,
      status: 'pending' as TaskStatus,
      result: undefined,
    }))

    if (steps.length === 0) {
      throw new Error('No steps generated in plan')
    }

    return steps
  }

  private async *executeStep(
    step: GoalStep,
    previousResults: GoalStep[],
    goal: string,
  ): AsyncGenerator<GoalEvent> {
    const adaptiveToolBudget = goalStepIterationBudget(step, this.config.agentConfig.maxIterations)
    const dependencyResults = previousResults
      .filter((previous) => previous.status === 'completed')
      .slice(-MAX_HANDOFF_ITEMS)
      .map((previous) => ({ stepId: previous.id, description: previous.description, result: compactHandoffResult(previous.result || 'No structured result was recorded.', MAX_HANDOFF_RESULT_CHARS) }))
    const upstreamIssues = previousResults
      .filter((previous): previous is GoalStep & { status: 'failed' | 'cancelled' } => previous.status === 'failed' || previous.status === 'cancelled')
      .slice(-MAX_HANDOFF_ITEMS)
      .map((previous) => ({
        stepId: previous.id,
        description: previous.description,
        status: previous.status,
        detail: compactHandoffResult(previous.result || 'No detailed failure result was recorded.', MAX_HANDOFF_RESULT_CHARS),
      }))
    const handoff: GoalStepHandoff = {
      goal,
      step: step.description,
      acceptanceCriteria: ['Complete the assigned step.', 'Report changed files, verification, and unresolved risks explicitly.'],
      workspacePath: this.config.workspacePath || undefined,
      parentContext: compactHandoffResult(this.config.contextManager.getDurableMemory(), MAX_HANDOFF_CONTEXT_CHARS) || undefined,
      userGuidance: compactHandoffItems(this.feedback.map((feedback) => feedback.content)),
      dependencyResults,
      upstreamIssues,
    }
    step.handoff = handoff
    let stepConversationId = step.agentConversationId
    let stepMessages: ChatMessage[] = []
    let stepMessage: ChatMessage
    if (this.config.prepareStepConversation) {
      const prepared = await this.config.prepareStepConversation({ step, handoff, continuation: Boolean(stepConversationId) })
      stepConversationId = prepared.conversationId
      step.agentConversationId = prepared.conversationId
      stepMessages = prepared.messages
      stepMessage = prepared.message
      yield { type: 'step_conversation', stepId: step.id, agentConversationId: prepared.conversationId, handoff }
    } else {
      stepMessage = {
        id: `goal-step-${step.id}-${Date.now()}`,
        conversationId: '',
        role: 'user',
        content: goalStepHandoffPrompt(handoff),
        timestamp: Date.now(),
      }
    }

    const runner = new AgentRunner({
      conversationId: this.config.conversationId,
      agentConfig: this.config.agentConfig,
      provider: this.config.provider,
      toolRegistry: this.config.toolRegistry,
      // Each step gets a fresh transcript. The explicit handoff is the only
      // task context that crosses the boundary, while machine policy remains.
      contextManager: this.config.contextManager.createStepContext(),
      workspacePath: this.config.workspacePath,
      fileAccessGrants: this.config.fileAccessGrants,
      fullFilesystemAccess: this.config.fullFilesystemAccess,
      fileService: this.config.fileService,
      terminalService: this.config.terminalService,
      modelPools: this.config.modelPools,
      providerRegistry: this.config.providerRegistry,
      adaptiveToolBudget,
      requestSource: 'goal-step',
    })
    this.currentRunner = runner

    let lastContent = ''

    try {
      for await (const event of runner.run({ messages: stepMessages, newMessage: stepMessage })) {
        if (event.type === 'text' && event.content) {
          lastContent += event.content
          const stepEvent: GoalEvent = { type: 'step_progress', stepId: step.id, content: event.content }
          if (stepConversationId && this.config.persistStepEvent) await this.config.persistStepEvent({ step, conversationId: stepConversationId, event: stepEvent })
          yield stepEvent
        } else if (event.type === 'tool_call' && event.toolCall) {
          const toolCall: ToolCall = {
            id: event.toolCall.id,
            name: event.toolCall.name,
            arguments: event.toolCall.arguments,
          }
          step.toolCalls = [...(step.toolCalls || []), toolCall]
          const stepEvent: GoalEvent = { type: 'step_tool_call', stepId: step.id, toolCall }
          if (stepConversationId && this.config.persistStepEvent) await this.config.persistStepEvent({ step, conversationId: stepConversationId, event: stepEvent })
          yield stepEvent
        } else if (event.type === 'tool_result' && event.toolResult) {
          step.toolCalls = (step.toolCalls || []).map((toolCall) =>
            toolCall.id === event.toolResult!.toolCallId
              ? { ...toolCall, result: event.toolResult!.result, isError: event.toolResult!.isError }
              : toolCall
          )
          const stepEvent: GoalEvent = {
            type: 'step_tool_result',
            stepId: step.id,
            toolCallId: event.toolResult.toolCallId,
            result: event.toolResult.result,
            isError: event.toolResult.isError,
          }
          if (stepConversationId && this.config.persistStepEvent) await this.config.persistStepEvent({ step, conversationId: stepConversationId, event: stepEvent })
          yield stepEvent
        } else if (event.type === 'done') {
          const stepEvent: GoalEvent = { type: 'step_completed', stepId: step.id, result: lastContent || 'Step completed successfully' }
          if (stepConversationId && this.config.persistStepEvent) await this.config.persistStepEvent({ step, conversationId: stepConversationId, event: stepEvent })
          yield stepEvent
          return
        } else if (event.type === 'error' && event.error) {
          const stepEvent: GoalEvent = { type: 'step_failed', stepId: step.id, error: event.error }
          if (stepConversationId && this.config.persistStepEvent) await this.config.persistStepEvent({ step, conversationId: stepConversationId, event: stepEvent })
          yield stepEvent
          return
        }
      }

      // If no done event received
      const stepEvent: GoalEvent = { type: 'step_completed', stepId: step.id, result: lastContent || 'Step completed' }
      if (stepConversationId && this.config.persistStepEvent) await this.config.persistStepEvent({ step, conversationId: stepConversationId, event: stepEvent })
      yield stepEvent
    } catch (err) {
      if (this.abortController?.signal.aborted) {
        const stepEvent: GoalEvent = { type: 'step_failed', stepId: step.id, error: 'Aborted' }
        if (stepConversationId && this.config.persistStepEvent) await this.config.persistStepEvent({ step, conversationId: stepConversationId, event: stepEvent })
        yield stepEvent
      } else {
        const stepEvent: GoalEvent = { type: 'step_failed', stepId: step.id, error: (err as Error).message }
        if (stepConversationId && this.config.persistStepEvent) await this.config.persistStepEvent({ step, conversationId: stepConversationId, event: stepEvent })
        yield stepEvent
      }
    } finally {
      this.currentRunner = null
    }
  }

  private async evaluateAndAdjust(
    goal: string,
    steps: GoalStep[],
    currentIndex: number
  ): Promise<{ adjusted: boolean; steps: GoalStep[]; reason?: string }> {
    const completed = steps.slice(0, currentIndex)
    const remaining = steps.slice(currentIndex)

    const completedInfo = completed
      .map((s) => `Step ${s.index + 1} (${s.status}): ${s.description}\n  Result: ${s.result || 'N/A'}`)
      .join('\n')

    const remainingInfo = remaining
      .map((s) => `Step ${s.index + 1}: ${s.description}`)
      .join('\n')

    const messages: ChatMessageInput[] = [
      {
        role: 'system',
        content: 'You are evaluating progress on a goal. Determine if remaining steps need adjustment. Output only valid JSON.',
      },
      {
        role: 'user',
        content: `You are working towards this goal: ${goal}

Completed steps and their results:
${completedInfo}

Remaining steps:
${remainingInfo}

Evaluate the progress. Do the remaining steps still make sense? Should any steps be added, removed, or modified?

Respond with JSON:
{
  "adjusted": true/false,
  "reason": "Why adjustment is needed (if adjusted)",
  "steps": [updated remaining steps with id, index (starting from ${currentIndex}), description]
}`,
      },
    ]

    try {
      const response = await this.completeWithResilience(
        {
          model: this.config.agentConfig.model,
          messages,
          temperature: 0.2,
          maxTokens: 4096,
        },
        'Goal plan review request'
      )

      const content = response.content
      const jsonMatch = content.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        return { adjusted: false, steps: remaining }
      }

      const parsed = JSON.parse(jsonMatch[0])
      if (!parsed.adjusted) {
        return { adjusted: false, steps: remaining }
      }

      const adjustedSteps: GoalStep[] = (parsed.steps || []).map((s: any, i: number) => ({
        id: s.id || `step-adj-${currentIndex + i + 1}`,
        index: currentIndex + i,
        description: s.description || s.title || `Adjusted step ${currentIndex + i + 1}`,
        status: 'pending' as TaskStatus,
        result: undefined,
      }))

      return { adjusted: true, steps: adjustedSteps, reason: parsed.reason || 'Progress evaluation' }
    } catch {
      return { adjusted: false, steps: remaining }
    }
  }

  private async generateSummary(goal: string, steps: GoalStep[]): Promise<string> {
    const stepsInfo = steps
      .map((s) => `Step ${s.index + 1} (${s.status}): ${s.description}\n  Result: ${s.result || 'N/A'}`)
      .join('\n\n')

    const messages: ChatMessageInput[] = [
      {
        role: 'system',
        content: 'You are summarizing the completion of a goal. Provide a clear, concise summary.',
      },
      {
        role: 'user',
        content: `Goal: ${goal}

Execution steps and results:
${stepsInfo}

Please provide a summary of what was accomplished, any issues encountered, and any recommended next steps.`,
      },
    ]

    try {
      const response = await this.completeWithResilience(
        {
          model: this.config.agentConfig.model,
          messages,
          temperature: 0.3,
          maxTokens: 2048,
        },
        'Goal summary request'
      )

      return response.content
    } catch {
      const completed = steps.filter((s) => s.status === 'completed').length
      const failed = steps.filter((s) => s.status === 'failed').length
      return `Goal execution finished. ${completed} steps completed, ${failed} steps failed out of ${steps.length} total steps.`
    }
  }
}
