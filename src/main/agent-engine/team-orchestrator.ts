import type { LLMProvider } from '../providers/base-provider'
import type { ToolRegistry, FileService, TerminalService } from '../tools/index'
import type { AgentConfig } from '../../shared/types/agent'
import type { TaskPlan, SubTask, TeamEvent, TaskStatus } from '../../shared/types/task'
import type { ChatMessage } from '../../shared/types/conversation'
import type { ChatMessageInput } from '../../shared/types/provider'
import { AgentRunner } from './agent-runner'
import { ContextManager } from './context'
import { v4 as uuidv4 } from 'uuid'
import type { FileAccessGrant } from '../../shared/types/file-access'

export interface TeamOrchestratorConfig {
  leader: AgentConfig
  workers: AgentConfig[]
  provider: LLMProvider
  toolRegistry: ToolRegistry
  contextManager: ContextManager
  workspacePath: string
  fileAccessGrants?: FileAccessGrant[]
  fullFilesystemAccess?: boolean
  fileService: FileService
  terminalService: TerminalService
  maxSubtasks?: number
}

export interface TeamRunParams {
  goal: string
  messages?: ChatMessage[]
}

export class TeamOrchestrator {
  private config: TeamOrchestratorConfig
  private abortController: AbortController | null = null
  private isRunning = false
  private currentRunners: Map<string, AgentRunner> = new Map()

  constructor(config: TeamOrchestratorConfig) {
    this.config = config
  }

  /**
   * Execute expert team mode:
   * 1. Leader creates task plan
   * 2. Assign workers to subtasks
   * 3. Execute subtasks (sequentially for safety)
   * 4. Leader summarizes results
   */
  async *run(params: TeamRunParams): AsyncGenerator<TeamEvent> {
    if (this.isRunning) {
      yield { type: 'error', error: 'TeamOrchestrator is already running' }
      return
    }

    this.isRunning = true
    this.abortController = new AbortController()
    const signal = this.abortController.signal

    try {
      // Step 1: Leader creates task plan
      yield { type: 'task_created', subtaskId: '' }

      const plan = await this.createTaskPlan(params.goal, params.messages)
      if (signal.aborted) {
        yield { type: 'done' }
        return
      }

      yield { type: 'plan_created', plan }

      // Step 2: Assign workers & execute
      const completedResults = new Map<string, string>()

      // Get execution order (batches based on dependencies)
      const batches = this.getExecutionOrder(plan.subtasks)

      for (const batch of batches) {
        if (signal.aborted) break

        // Assign workers for this batch
        for (const subtask of batch) {
          const worker = this.assignWorker(subtask)
          subtask.assignedAgentId = worker.id
          subtask.assignedAgentName = worker.name
          subtask.status = 'pending'

          yield {
            type: 'task_assigned',
            subtaskId: subtask.id,
            subtask: { ...subtask },
            agentId: worker.id,
            agentName: worker.name,
          }
        }

        // Execute batch subtasks sequentially (to avoid file conflicts)
        for (const subtask of batch) {
          if (signal.aborted) break

          subtask.status = 'in_progress'
          subtask.startedAt = Date.now()
          yield {
            type: 'task_progress',
            subtaskId: subtask.id,
            subtask: { ...subtask },
            progress: `Starting: ${subtask.title}`,
          }

          // Update plan status
          plan.subtasks = plan.subtasks.map((st) =>
            st.id === subtask.id ? { ...subtask } : st
          )

          const worker = this.config.workers.find(
            (w) => w.id === subtask.assignedAgentId
          ) || this.assignWorker(subtask)

          try {
            const events = this.executeSubtask(
              subtask,
              worker,
              plan,
              completedResults
            )

            for await (const evt of events) {
              if (signal.aborted) break
              yield evt
            }

            if ((subtask.status as TaskStatus) === 'completed') {
              completedResults.set(subtask.id, subtask.result || '')
            }
          } catch (err: any) {
            subtask.status = 'failed'
            subtask.result = err?.message ?? String(err)
            subtask.completedAt = Date.now()
            yield {
              type: 'task_failed',
              subtaskId: subtask.id,
              subtask: { ...subtask },
              error: subtask.result,
            }
          }

          // Update plan
          plan.subtasks = plan.subtasks.map((st) =>
            st.id === subtask.id ? { ...subtask } : st
          )
        }
      }

      if (signal.aborted) {
        yield { type: 'done' }
        return
      }

      // Step 3: Leader summarizes
      const summary = await this.summarizeResults(plan, completedResults)
      if (signal.aborted) {
        yield { type: 'done' }
        return
      }

      plan.status = 'completed'
      yield { type: 'summary', summary, plan }
      yield { type: 'done' }
    } catch (err: any) {
      if (signal.aborted) {
        yield { type: 'done' }
      } else {
        yield { type: 'error', error: err?.message ?? String(err) }
        yield { type: 'done' }
      }
    } finally {
      this.isRunning = false
      this.abortController = null
      this.currentRunners.clear()
    }
  }

  abort(): void {
    if (this.abortController && !this.abortController.signal.aborted) {
      this.abortController.abort()
    }
    // Abort all running subtask runners
    for (const [, runner] of this.currentRunners) {
      runner.abort()
    }
  }

  get running(): boolean {
    return this.isRunning
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  /**
   * Leader analyzes the goal and generates a TaskPlan via LLM.
   */
  private async createTaskPlan(
    goal: string,
    messages?: ChatMessage[]
  ): Promise<TaskPlan> {
    const { leader, provider } = this.config
    const maxSubtasks = this.config.maxSubtasks ?? 10

    const planningPrompt = `You are a team leader. Analyze the following goal and create a task plan.

Goal: ${goal}

${messages && messages.length > 0 ? `Recent conversation context:\n${messages.slice(-4).map((m) => `${m.role}: ${m.content.slice(0, 500)}`).join('\n')}\n` : ''}

Create a JSON plan with the following structure:
{
  "subtasks": [
    {
      "id": "task-1",
      "title": "Brief title",
      "description": "Detailed description of what needs to be done",
      "dependencies": [],
      "assignedRole": "researcher|coder|reviewer|tester"
    }
  ]
}

Rules:
- Break the goal into 2-8 concrete subtasks
- Each subtask should be independently executable
- Set dependencies correctly (e.g., review depends on implementation)
- Assign appropriate roles (researcher, coder, reviewer, tester)
- Maximum ${maxSubtasks} subtasks
- Output ONLY the JSON, no other text`

    const messages_: ChatMessageInput[] = [
      { role: 'system', content: leader.systemPrompt },
      { role: 'user', content: planningPrompt },
    ]

    const response = await provider.chatComplete(
      {
        model: leader.model,
        messages: messages_,
        temperature: leader.temperature,
      },
      this.abortController?.signal
    )

    // Parse the plan from LLM response
    let parsedSubtasks: Array<{
      id: string
      title: string
      description: string
      dependencies: string[]
      assignedRole: string
    }> = []

    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        parsedSubtasks = parsed.subtasks || []
      }
    } catch {
      // If JSON parsing fails, create a single subtask
      parsedSubtasks = [
        {
          id: 'task-1',
          title: 'Execute goal',
          description: goal,
          dependencies: [],
          assignedRole: 'coder',
        },
      ]
    }

    const planId = uuidv4()
    const now = Date.now()

    const subtasks: SubTask[] = parsedSubtasks.slice(0, maxSubtasks).map((st) => ({
      id: st.id || `task-${uuidv4().slice(0, 8)}`,
      planId,
      title: st.title || 'Untitled task',
      description: st.description || '',
      status: 'pending' as TaskStatus,
      dependencies: Array.isArray(st.dependencies) ? st.dependencies : [],
    }))

    // If no subtasks were parsed, create a fallback
    if (subtasks.length === 0) {
      subtasks.push({
        id: 'task-1',
        planId,
        title: 'Execute goal',
        description: goal,
        status: 'pending',
        dependencies: [],
      })
    }

    const plan: TaskPlan = {
      id: planId,
      goal,
      subtasks,
      createdAt: now,
      status: 'in_progress',
    }

    return plan
  }

  /**
   * Assign a worker based on the subtask's content.
   */
  private assignWorker(subtask: SubTask): AgentConfig {
    const text = `${subtask.title} ${subtask.description}`.toLowerCase()
    const workers = this.config.workers

    if (workers.length === 0) {
      // Fallback to leader if no workers available
      return this.config.leader
    }

    // Role-based matching
    const rolePatterns: Array<{ pattern: RegExp; role: string }> = [
      { pattern: /research|analyz|explor|investigat|understand/, role: 'researcher' },
      { pattern: /code|implement|write|fix|build|creat|develop|refactor/, role: 'coder' },
      { pattern: /review|check|audit|inspect|examine/, role: 'reviewer' },
      { pattern: /test|verify|validat|assert/, role: 'tester' },
    ]

    for (const { pattern, role } of rolePatterns) {
      if (pattern.test(text)) {
        const match = workers.find((w) => w.role === role)
        if (match) return match
      }
    }

    // Default: coder (or first available worker)
    return workers.find((w) => w.role === 'coder') || workers[0]
  }

  /**
   * Execute a single subtask using an AgentRunner.
   */
  private async *executeSubtask(
    subtask: SubTask,
    worker: AgentConfig,
    plan: TaskPlan,
    completedResults: Map<string, string>
  ): AsyncGenerator<TeamEvent> {
    const runner = new AgentRunner({
      agentConfig: worker,
      provider: this.config.provider,
      toolRegistry: this.config.toolRegistry,
      contextManager: this.config.contextManager,
      workspacePath: this.config.workspacePath,
      fileAccessGrants: this.config.fileAccessGrants,
      fullFilesystemAccess: this.config.fullFilesystemAccess,
      fileService: this.config.fileService,
      terminalService: this.config.terminalService,
    })

    this.currentRunners.set(subtask.id, runner)

    // Build a contextual prompt for the worker
    const dependencyContext = subtask.dependencies
      .map((depId) => {
        const result = completedResults.get(depId)
        const depTask = plan.subtasks.find((s) => s.id === depId)
        if (result && depTask) {
          return `Dependency "${depTask.title}" completed with result:\n${result.slice(0, 1000)}`
        }
        return null
      })
      .filter(Boolean)
      .join('\n\n')

    const workerPrompt = `You are working on a subtask as part of a team plan.

**Your Task:** ${subtask.title}

**Description:** ${subtask.description}

**Overall Goal:** ${plan.goal}

${dependencyContext ? `**Dependency Results:**\n${dependencyContext}` : ''}

Please complete this task. Use the available tools as needed. When done, provide a clear summary of what was accomplished.

**Important:** Focus only on this task. Do not modify files that are not related to this task.`

    let result = ''
    let lastTextContent = ''

    try {
      for await (const event of runner.run({
        messages: [],
        newMessage: workerPrompt,
      })) {
        if (event.type === 'text' && event.content) {
          lastTextContent = event.content
        }
        if (event.type === 'done' && event.content) {
          result = event.content
        }
        if (event.type === 'error' && event.error) {
          // Yield progress but don't fail yet
          yield {
            type: 'task_progress',
            subtaskId: subtask.id,
            progress: `Warning: ${event.error}`,
          }
        }
      }

      // Use the last text content if no 'done' content
      if (!result && lastTextContent) {
        result = lastTextContent
      }

      subtask.status = 'completed'
      subtask.result = result || 'Task completed successfully.'
      subtask.completedAt = Date.now()

      yield {
        type: 'task_completed',
        subtaskId: subtask.id,
        subtask: { ...subtask },
        result: subtask.result,
      }
    } catch (err: any) {
      subtask.status = 'failed'
      subtask.result = err?.message ?? String(err)
      subtask.completedAt = Date.now()

      yield {
        type: 'task_failed',
        subtaskId: subtask.id,
        subtask: { ...subtask },
        error: subtask.result,
      }
    } finally {
      this.currentRunners.delete(subtask.id)
    }
  }

  /**
   * Leader summarizes all completed subtask results.
   */
  private async summarizeResults(
    plan: TaskPlan,
    results: Map<string, string>
  ): Promise<string> {
    const { leader, provider } = this.config

    const taskSummaries = plan.subtasks
      .map((st) => {
        const status = st.status === 'completed' ? '✓' : st.status === 'failed' ? '✗' : '○'
        return `${status} ${st.title} (${st.status}):\n${(st.result || 'No result').slice(0, 500)}`
      })
      .join('\n\n')

    const summaryPrompt = `You are the team leader. Summarize the results of the following team plan.

**Goal:** ${plan.goal}

**Subtask Results:**
${taskSummaries}

Provide a concise but comprehensive summary of what was accomplished, any issues encountered, and next steps if applicable. Focus on the key outcomes.`

    const messages: ChatMessageInput[] = [
      { role: 'system', content: leader.systemPrompt },
      { role: 'user', content: summaryPrompt },
    ]

    try {
      const response = await provider.chatComplete(
        {
          model: leader.model,
          messages,
          temperature: leader.temperature,
        },
        this.abortController?.signal
      )
      return response.content
    } catch {
      // Fallback summary if LLM call fails
      return `Team plan completed.\n\nGoal: ${plan.goal}\n\n${plan.subtasks.length} subtasks processed:\n- ${plan.subtasks.filter((s) => s.status === 'completed').length} completed\n- ${plan.subtasks.filter((s) => s.status === 'failed').length} failed`
    }
  }

  /**
   * Topological sort: returns batches of subtasks that can run in parallel.
   * Each batch must wait for the previous batch to complete.
   */
  private getExecutionOrder(subtasks: SubTask[]): SubTask[][] {
    const subtaskMap = new Map(subtasks.map((s) => [s.id, s]))
    const visited = new Set<string>()
    const batches: SubTask[][] = []

    while (visited.size < subtasks.length) {
      const batch: SubTask[] = []

      for (const subtask of subtasks) {
        if (visited.has(subtask.id)) continue

        // Check if all dependencies are visited
        const depsReady = subtask.dependencies.every((dep) => visited.has(dep))
        if (depsReady) {
          batch.push(subtask)
        }
      }

      if (batch.length === 0) {
        // Remaining subtasks have circular or missing dependencies; force them
        const remaining = subtasks.filter((s) => !visited.has(s.id))
        batches.push(remaining)
        break
      }

      batches.push(batch)
      for (const s of batch) {
        visited.add(s.id)
      }
    }

    return batches
  }
}
