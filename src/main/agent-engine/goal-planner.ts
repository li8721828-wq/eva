import type { LLMProvider } from '../providers/base-provider'
import type { ToolRegistry, FileService, TerminalService } from '../tools/index'
import type { AgentConfig, AgentEvent } from '../../shared/types/agent'
import type { GoalConfig, GoalStep, GoalProgress, TaskStatus } from '../../shared/types/task'
import type { ChatMessageInput } from '../../shared/types/provider'
import { AgentRunner } from './agent-runner'
import { ContextManager } from './context'
import type { FileAccessGrant } from '../../shared/types/file-access'

export type GoalEvent =
  | { type: 'plan_created'; steps: GoalStep[] }
  | { type: 'step_started'; stepId: string; stepIndex: number }
  | { type: 'step_progress'; stepId: string; content: string }
  | { type: 'step_completed'; stepId: string; result: string }
  | { type: 'step_failed'; stepId: string; error: string }
  | { type: 'plan_adjusted'; steps: GoalStep[]; reason: string }
  | { type: 'summary'; content: string }
  | { type: 'done'; progress: GoalProgress }
  | { type: 'error'; error: string }

export interface GoalPlannerConfig {
  agentConfig: AgentConfig
  provider: LLMProvider
  toolRegistry: ToolRegistry
  contextManager: ContextManager
  workspacePath: string
  fileAccessGrants?: FileAccessGrant[]
  fullFilesystemAccess?: boolean
  fileService: FileService
  terminalService: TerminalService
  maxSteps?: number
  timeout?: number
}

export class GoalPlanner {
  private config: GoalPlannerConfig
  private abortController: AbortController | null = null
  private isRunning: boolean = false
  private currentRunner: AgentRunner | null = null
  private isPaused: boolean = false

  constructor(config: GoalPlannerConfig) {
    this.config = config
  }

  async *run(goalConfig: GoalConfig): AsyncGenerator<GoalEvent> {
    this.isRunning = true
    this.abortController = new AbortController()
    this.isPaused = false

    const maxSteps = this.config.maxSteps ?? 15
    const timeout = this.config.timeout ?? 10 * 60 * 1000
    const startTime = Date.now()

    const progress: GoalProgress = {
      goal: goalConfig.goal,
      steps: [],
      currentStepIndex: 0,
      totalSteps: 0,
      status: 'in_progress',
      startedAt: startTime,
    }

    try {
      // 1. Generate execution plan
      let steps: GoalStep[]
      try {
        steps = await this.createPlan(goalConfig.goal)
      } catch (err) {
        yield { type: 'error', error: `Failed to create plan: ${(err as Error).message}` }
        progress.status = 'failed'
        progress.completedAt = Date.now()
        yield { type: 'done', progress }
        return
      }

      if (steps.length > maxSteps) {
        steps = steps.slice(0, maxSteps)
      }

      progress.steps = steps
      progress.totalSteps = steps.length
      yield { type: 'plan_created', steps }

      // 2. Execute steps sequentially
      const completedSteps: GoalStep[] = []

      for (let i = 0; i < steps.length; i++) {
        // Check abort
        if (this.abortController?.signal.aborted) {
          progress.status = 'cancelled'
          progress.completedAt = Date.now()
          yield { type: 'done', progress }
          return
        }

        // Wait while paused
        while (this.isPaused && !this.abortController?.signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 200))
        }

        if (this.abortController?.signal.aborted) {
          progress.status = 'cancelled'
          progress.completedAt = Date.now()
          yield { type: 'done', progress }
          return
        }

        // Check timeout
        if (Date.now() - startTime > timeout) {
          progress.status = 'failed'
          progress.completedAt = Date.now()
          yield { type: 'error', error: 'Goal execution timed out' }
          yield { type: 'done', progress }
          return
        }

        const step = steps[i]
        progress.currentStepIndex = i
        step.status = 'in_progress'
        step.startedAt = Date.now()

        yield { type: 'step_started', stepId: step.id, stepIndex: i }

        let stepResult = ''
        let stepFailed = false

        try {
          for await (const event of this.executeStep(step, completedSteps)) {
            yield event
            if (event.type === 'step_completed') {
              stepResult = event.result
            } else if (event.type === 'step_failed') {
              stepResult = event.error
              stepFailed = true
            }
          }
        } catch (err) {
          stepResult = (err as Error).message
          stepFailed = true
        }

        step.status = stepFailed ? 'failed' : 'completed'
        step.result = stepResult
        step.completedAt = Date.now()

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
      progress.status = 'completed'
      progress.completedAt = Date.now()
      const summary = await this.generateSummary(goalConfig.goal, completedSteps)
      progress.summary = summary
      yield { type: 'summary', content: summary }
      yield { type: 'done', progress }
    } catch (err) {
      if (this.abortController?.signal.aborted) {
        progress.status = 'cancelled'
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

  get running(): boolean {
    return this.isRunning
  }

  get paused(): boolean {
    return this.isPaused
  }

  // === Internal Methods ===

  private async createPlan(goal: string): Promise<GoalStep[]> {
    const messages: ChatMessageInput[] = [
      {
        role: 'system',
        content: 'You are an AI agent planning assistant. Analyze goals and create structured execution plans. Output only valid JSON.',
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

    const response = await this.config.provider.chatComplete(
      {
        model: this.config.agentConfig.model,
        messages,
        temperature: 0.3,
        maxTokens: 4096,
      },
      this.abortController?.signal
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
    previousResults: GoalStep[]
  ): AsyncGenerator<GoalEvent> {
    const runner = new AgentRunner({
      agentConfig: this.config.agentConfig,
      provider: this.config.provider,
      toolRegistry: this.config.toolRegistry,
      contextManager: this.config.contextManager,
      workspacePath: this.config.workspacePath,
      fileAccessGrants: this.config.fileAccessGrants,
      fullFilesystemAccess: this.config.fullFilesystemAccess,
      fileService: this.config.fileService,
      terminalService: this.config.terminalService,
    })
    this.currentRunner = runner

    // Build step context message
    let contextMsg = `[Goal Step ${step.index + 1}] ${step.description}`
    if (previousResults.length > 0) {
      contextMsg += '\n\nPrevious steps completed:\n'
      for (const prev of previousResults) {
        contextMsg += `- Step ${prev.index + 1} (${prev.status}): ${prev.description}\n  Result: ${prev.result || 'N/A'}\n`
      }
    }

    let lastContent = ''

    try {
      for await (const event of runner.run({ messages: [], newMessage: contextMsg })) {
        if (event.type === 'text' && event.content) {
          lastContent += event.content
          yield { type: 'step_progress', stepId: step.id, content: event.content }
        } else if (event.type === 'tool_call' && event.toolCall) {
          const toolInfo = `\n[Tool: ${event.toolCall.name}]\n`
          lastContent += toolInfo
          yield { type: 'step_progress', stepId: step.id, content: toolInfo }
        } else if (event.type === 'tool_result' && event.toolResult) {
          const resultSnippet = event.toolResult.result.slice(0, 500)
          const resultInfo = `\n[Result: ${resultSnippet}]\n`
          lastContent += resultInfo
          yield { type: 'step_progress', stepId: step.id, content: resultInfo }
        } else if (event.type === 'done') {
          yield { type: 'step_completed', stepId: step.id, result: lastContent || 'Step completed successfully' }
          return
        } else if (event.type === 'error' && event.error) {
          yield { type: 'step_failed', stepId: step.id, error: event.error }
          return
        }
      }

      // If no done event received
      yield { type: 'step_completed', stepId: step.id, result: lastContent || 'Step completed' }
    } catch (err) {
      if (this.abortController?.signal.aborted) {
        yield { type: 'step_failed', stepId: step.id, error: 'Aborted' }
      } else {
        yield { type: 'step_failed', stepId: step.id, error: (err as Error).message }
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
      const response = await this.config.provider.chatComplete(
        {
          model: this.config.agentConfig.model,
          messages,
          temperature: 0.2,
          maxTokens: 4096,
        },
        this.abortController?.signal
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
      const response = await this.config.provider.chatComplete(
        {
          model: this.config.agentConfig.model,
          messages,
          temperature: 0.3,
          maxTokens: 2048,
        },
        this.abortController?.signal
      )

      return response.content
    } catch {
      const completed = steps.filter((s) => s.status === 'completed').length
      const failed = steps.filter((s) => s.status === 'failed').length
      return `Goal execution finished. ${completed} steps completed, ${failed} steps failed out of ${steps.length} total steps.`
    }
  }
}
