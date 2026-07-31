import type { LLMProvider } from '../providers/base-provider'
import type { ToolRegistry, FileService, TerminalService } from '../tools/index'
import type { AgentConfig, AgentModelCandidate, AgentModelPreference } from '../../shared/types/agent'
import type { DynamicAgentProfile, TaskPlan, SubTask, TeamEvent, TaskStatus } from '../../shared/types/task'
import type { ChatMessage } from '../../shared/types/conversation'
import type { ChatMessageInput } from '../../shared/types/provider'
import { AgentRunner } from './agent-runner'
import { ContextManager } from './context'
import { v4 as uuidv4 } from 'uuid'
import type { FileAccessGrant } from '../../shared/types/file-access'

export interface TeamOrchestratorConfig {
  conversationId?: string
  leader: AgentConfig
  workers: AgentConfig[]
  /** Resolves each agent's saved model connection at execution time. */
  providerForAgent: (agent: AgentConfig) => LLMProvider | undefined
  /** Active chat model used as a fallback for built-in agents without assigned candidates. */
  fallbackModel?: AgentModelCandidate
  toolRegistry: ToolRegistry
  contextManager: ContextManager
  workspacePath: string
  fileAccessGrants?: FileAccessGrant[]
  fullFilesystemAccess?: boolean
  fileService: FileService
  terminalService: TerminalService
  /** Creates a persisted, isolated conversation for an assigned worker. */
  createWorkerConversation?: (subtask: SubTask, worker: AgentConfig) => Promise<string>
  /** Receives worker events for persistence without exposing the worker's context to other agents. */
  onWorkerEvent?: (subtask: SubTask, worker: AgentConfig, event: import('../../shared/types/agent').AgentEvent) => Promise<void>
  maxSubtasks?: number
}

export interface TeamRunParams {
  goal: string
  messages?: ChatMessage[]
  /** Reuse the persisted plan so completed subtasks are never run again. */
  plan?: TaskPlan
}

export class TeamOrchestrator {
  private config: TeamOrchestratorConfig
  private abortController: AbortController | null = null
  private isRunning = false
  private currentRunners: Map<string, AgentRunner> = new Map()
  private assignmentCursor: Map<string, number> = new Map()
  private dynamicWorkers: Map<string, AgentConfig> = new Map()
  private feedback: Array<{ content: string; createdAt: number }> = []
  private isPaused = false

  private static readonly MUTATING_TOOLS = new Set([
    'write_file',
    'execute_command',
    'blender_run_script',
    'blender_model_from_reference',
    'blender_render_review',
    'blender_open_gui',
  ])

  constructor(config: TeamOrchestratorConfig) {
    this.config = config
  }

  /**
   * Execute expert team mode:
   * 1. Leader creates task plan
   * 2. Assign workers to subtasks
   * 3. Execute independent read-only subtasks concurrently. Any worker that can
   *    write files or execute commands stays serialized to protect the workspace.
   * 4. Leader summarizes results
   */
  async *run(params: TeamRunParams): AsyncGenerator<TeamEvent> {
    if (this.isRunning) {
      yield { type: 'error', error: 'TeamOrchestrator is already running' }
      return
    }

    this.isRunning = true
    this.abortController = new AbortController()
    this.assignmentCursor.clear()
    this.dynamicWorkers.clear()
    const signal = this.abortController.signal

    try {
      // Step 1: Leader creates task plan
      yield { type: 'task_created', subtaskId: '' }

      const plan = params.plan
        ? {
            ...params.plan,
            status: 'in_progress' as TaskStatus,
            subtasks: params.plan.subtasks.map((subtask) => ({ ...subtask, toolCalls: subtask.toolCalls ? [...subtask.toolCalls] : undefined })),
          }
        : await this.createTaskPlan(params.goal, params.messages)
      if (signal.aborted) {
        yield { type: 'done', cancelled: true }
        return
      }

      yield { type: 'plan_created', plan }
      this.registerDynamicWorkers(plan.dynamicAgents || [])

      // Step 2: Assign workers & execute
      const completedResults = new Map(
        plan.subtasks
          .filter((subtask) => subtask.status === 'completed' && subtask.result)
          .map((subtask) => [subtask.id, subtask.result!] as const)
      )

      // Get execution order (batches based on dependencies)
      const completedIds = plan.subtasks
        .filter((subtask) => subtask.status === 'completed')
        .map((subtask) => subtask.id)
      const batches = this.getExecutionOrder(
        plan.subtasks.filter((subtask) => subtask.status !== 'completed'),
        completedIds,
      )

      for (const batch of batches) {
        if (signal.aborted) break
        await this.waitForResume(signal)
        if (signal.aborted) break

        // Assign independently named workers and resolve the model that will
        // actually execute each subtask before exposing the assignment.
        const assigned = [] as Array<{ subtask: SubTask; worker: AgentConfig }>
        for (const subtask of batch) {
          const worker = this.selectExecutionAgent(this.assignWorker(subtask), subtask)
          subtask.assignedAgentId = worker.id
          subtask.assignedAgentName = worker.name
          subtask.assignedProviderId = worker.providerId
          subtask.assignedModel = worker.model
          subtask.isDynamicAgent = Boolean(worker.taskScoped)
          if (this.config.createWorkerConversation && !subtask.agentConversationId) {
            subtask.agentConversationId = await this.config.createWorkerConversation(subtask, worker)
          }
          subtask.status = 'pending'
          assigned.push({ subtask, worker })

          yield {
            type: 'task_assigned',
            subtaskId: subtask.id,
            subtask: { ...subtask },
            agentId: worker.id,
            agentName: worker.name,
          }
        }

        const readOnly = assigned.filter(({ worker }) => this.isReadOnlyWorker(worker))
        const mutating = assigned.filter(({ worker }) => !this.isReadOnlyWorker(worker))

        // A batch is already dependency-safe. Merge read-only worker events so
        // research/review work can progress at the same time.
        if (readOnly.length > 1) {
          for await (const event of this.executeConcurrentBatch(readOnly, plan, completedResults)) {
            yield event
          }
        } else if (readOnly.length === 1) {
          for await (const event of this.executeWithRetry(readOnly[0].subtask, readOnly[0].worker, plan, completedResults)) {
            yield event
          }
        }

        // Mutating workers intentionally run one at a time to prevent races.
        for (const { subtask, worker } of mutating) {
          if (signal.aborted) break
          for await (const event of this.executeWithRetry(subtask, worker, plan, completedResults)) {
            yield event
          }
        }
      }

      if (signal.aborted) {
        yield { type: 'done', cancelled: true }
        return
      }

      await this.waitForResume(signal)
      if (signal.aborted) {
        yield { type: 'done', cancelled: true }
        return
      }

      // Step 3: Leader summarizes
      const summary = await this.summarizeResults(plan, completedResults)
      if (signal.aborted) {
        yield { type: 'done', cancelled: true }
        return
      }

      plan.status = 'completed'
      yield { type: 'summary', summary, plan }
      yield { type: 'done' }
    } catch (err: any) {
      if (signal.aborted) {
        yield { type: 'done', cancelled: true }
      } else {
        yield { type: 'error', error: err?.message ?? String(err) }
        yield { type: 'done' }
      }
    } finally {
      this.isRunning = false
      this.isPaused = false
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

  /** Human guidance is shared with work that has not started yet. */
  addFeedback(content: string): void {
    const trimmed = content.trim()
    if (!trimmed) return
    this.feedback = [...this.feedback.slice(-7), { content: trimmed, createdAt: Date.now() }]
  }

  pause(): void {
    this.isPaused = true
  }

  resume(): void {
    this.isPaused = false
  }

  get paused(): boolean {
    return this.isPaused
  }

  private async waitForResume(signal: AbortSignal): Promise<void> {
    while (this.isPaused && !signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  private isReadOnlyWorker(worker: AgentConfig): boolean {
    return !worker.tools.some((tool) => TeamOrchestrator.MUTATING_TOOLS.has(tool))
  }

  private selectExecutionAgent(worker: AgentConfig, subtask?: SubTask): AgentConfig {
    const candidates = [
      ...(worker.modelCandidates || []),
      { providerId: worker.providerId, model: worker.model },
      ...(worker.isBuiltIn && this.config.fallbackModel ? [this.config.fallbackModel] : []),
    ].filter((candidate, index, all) =>
      candidate.providerId && candidate.model
      && all.findIndex((item) => item.providerId === candidate.providerId && item.model === candidate.model) === index
    )

    const available = candidates.filter((candidate) =>
      this.config.providerForAgent({ ...worker, providerId: candidate.providerId, model: candidate.model })
    )
    if (!available.length) return worker

    const role = subtask?.assignedRole || worker.role
    const preference = worker.modelPreference
    const taskText = `${subtask?.title || ''} ${subtask?.description || ''}`.toLowerCase()
    const score = (candidate: typeof available[number]): number => {
      const model = candidate.model.toLowerCase()
      let value = 0
      if (role === 'coder' && /(coder|code|dev|qwen)/.test(model)) value += 6
      if (role === 'researcher' && /(search|research|chat|sonnet|gpt|gemini)/.test(model)) value += 4
      if ((role === 'reviewer' || role === 'tester') && /(reason|r1|sonnet|gpt-4|pro)/.test(model)) value += 5
      if (/(refactor|implement|debug|test)/.test(taskText) && /(code|coder|dev|qwen)/.test(model)) value += 3
      if (/(analy[sz]e|research|document|summari[sz]e)/.test(taskText) && /(chat|sonnet|gpt|gemini)/.test(model)) value += 2
      if (preference === 'coding' && /(coder|code|dev|qwen)/.test(model)) value += 8
      if (preference === 'research' && /(search|research|chat|sonnet|gpt|gemini)/.test(model)) value += 8
      if (preference === 'reasoning' && /(reason|r1|sonnet|gpt-4|pro)/.test(model)) value += 8
      if (preference === 'fast' && /(flash|mini|haiku|lite|turbo)/.test(model)) value += 8
      return value
    }

    const selected = available.reduce((best, candidate) => score(candidate) > score(best) ? candidate : best)
    return { ...worker, providerId: selected.providerId, model: selected.model }
  }

  private async *executeWithRetry(
    subtask: SubTask,
    worker: AgentConfig,
    plan: TaskPlan,
    completedResults: Map<string, string>
  ): AsyncGenerator<TeamEvent> {
    const maxAttempts = 2
    const executionAgent = this.selectExecutionAgent(worker, subtask)

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (this.abortController?.signal.aborted) return

      subtask.status = 'in_progress'
      subtask.startedAt = subtask.startedAt || Date.now()
      subtask.attempt = attempt
      plan.subtasks = plan.subtasks.map((item) => item.id === subtask.id ? { ...subtask } : item)
      yield {
        type: 'task_progress',
        subtaskId: subtask.id,
        subtask: { ...subtask },
        agentId: executionAgent.id,
        agentName: executionAgent.name,
        progress: attempt === 1 ? `Starting: ${subtask.title}` : `Retrying (${attempt}/${maxAttempts}): ${subtask.title}`,
      }

      let failure = ''
      try {
        for await (const event of this.executeSubtask(subtask, executionAgent, plan, completedResults)) {
          if (event.type === 'task_failed') failure = event.error || 'Subtask failed'
          yield { ...event, agentId: event.agentId || executionAgent.id, agentName: event.agentName || executionAgent.name }
        }
      } catch (error: any) {
        failure = error?.message ?? String(error)
      }

      if ((subtask as { status: TaskStatus }).status === 'completed') {
        completedResults.set(subtask.id, subtask.result || '')
        plan.subtasks = plan.subtasks.map((item) => item.id === subtask.id ? { ...subtask } : item)
        return
      }

      if (attempt < maxAttempts) {
        yield {
          type: 'task_progress',
          subtaskId: subtask.id,
          subtask: { ...subtask },
          agentId: executionAgent.id,
          agentName: executionAgent.name,
          progress: `Attempt ${attempt} failed; retrying once. ${failure}`,
        }
      }
    }

    plan.subtasks = plan.subtasks.map((item) => item.id === subtask.id ? { ...subtask } : item)
  }

  private async *executeConcurrentBatch(
    assignments: Array<{ subtask: SubTask; worker: AgentConfig }>,
    plan: TaskPlan,
    completedResults: Map<string, string>
  ): AsyncGenerator<TeamEvent> {
    const queued: TeamEvent[] = []
    let remaining = assignments.length
    let notify: (() => void) | undefined

    const push = (event: TeamEvent): void => {
      queued.push(event)
      notify?.()
      notify = undefined
    }

    const runners = assignments.map(async ({ subtask, worker }) => {
      try {
        for await (const event of this.executeWithRetry(subtask, worker, plan, completedResults)) {
          push(event)
        }
      } finally {
        remaining -= 1
        notify?.()
        notify = undefined
      }
    })

    while (remaining > 0 || queued.length > 0) {
      const event = queued.shift()
      if (event) {
        yield event
        continue
      }
      await new Promise<void>((resolve) => { notify = resolve })
    }

    await Promise.all(runners)
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  /**
   * Leader analyzes the goal and generates a TaskPlan via LLM.
   */
  private async createTaskPlan(
    goal: string,
    messages?: ChatMessage[]
  ): Promise<TaskPlan> {
    const leader = this.selectExecutionAgent(this.config.leader)
    const provider = this.config.providerForAgent(leader)
    if (!provider) {
      throw new Error(`The leader connection for ${leader.name} is unavailable. Configure or enable its model connection.`)
    }
    const maxSubtasks = this.config.maxSubtasks ?? 10
    const teamDirectory = this.config.workers.length
      ? this.config.workers.map((worker) => {
          const candidates = worker.modelCandidates?.length
            ? worker.modelCandidates.map((candidate) => `${candidate.providerId}/${candidate.model}`).join(', ')
            : `${worker.providerId}/${worker.model}`
          return `- ${worker.name} (${worker.role}): ${candidates}`
        }).join('\n')
      : '- No specialist workers are configured; the leader must complete the work directly.'
    const availableToolNames = [...new Set([this.config.leader, ...this.config.workers].flatMap((agent) => agent.tools))]
    const modelDirectory = [...new Set([
      this.config.leader,
      ...this.config.workers,
    ].flatMap((agent) => [
      ...(agent.modelCandidates || []).map((candidate) => `${candidate.providerId}/${candidate.model}`),
      `${agent.providerId}/${agent.model}`,
    ]))].join(', ')

    const planningPrompt = `You are a team leader. Analyze the following goal and create a task plan.

Goal: ${goal}

Available team members and their candidate models:
${teamDirectory}

Tools available for task-scoped members: ${availableToolNames.join(', ') || 'none'}
Configured model connections available for task-scoped members: ${modelDirectory || 'none'}

${messages && messages.length > 0 ? `Recent conversation context:\n${messages.slice(-4).map((m) => `${m.role}: ${m.content.slice(0, 500)}`).join('\n')}\n` : ''}

Create a JSON plan with the following structure:
{
  "subtasks": [
    {
      "id": "task-1",
      "title": "Brief title",
      "description": "Detailed description of what needs to be done",
      "dependencies": [],
      "assignedRole": "researcher|coder|reviewer|tester",
      "assignedAgentProfileId": "optional-custom-agent-id"
    }
  ],
  "agentProfiles": [
    {
      "id": "optional-custom-agent-id",
      "name": "Role Name",
      "description": "A concise responsibility statement",
      "systemPrompt": "Focused operating instructions for this specialist",
      "tools": ["only names from the available tool list"],
      "modelPreference": "reasoning|coding|research|fast"
    }
  ]
}

Rules:
- Break the goal into 2-8 concrete subtasks
- Each subtask should be independently executable
- Set dependencies correctly (e.g., review depends on implementation)
- Assign appropriate roles (researcher, coder, reviewer, tester)
- Only assign a role that exists in the available team directory; otherwise use the closest available role
- If none of the existing members fits a specialized responsibility, define a task-scoped agent in agentProfiles and reference its id from assignedAgentProfileId. Do not create one merely to rename an existing role.
- Task-scoped agents must use only listed tools and configured model connections. They are isolated workers that return a concrete handoff to the leader.
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
      assignedAgentProfileId?: string
    }> = []
    let parsedProfiles: Array<Partial<DynamicAgentProfile>> = []

    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        parsedSubtasks = parsed.subtasks || []
        parsedProfiles = Array.isArray(parsed.agentProfiles) ? parsed.agentProfiles : []
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

    const validRoles = new Set(['researcher', 'coder', 'reviewer', 'tester'])
    const permittedToolSet = new Set([this.config.leader, ...this.config.workers].flatMap((agent) => agent.tools))
    const validPreferences = new Set<AgentModelPreference>(['reasoning', 'coding', 'research', 'fast'])
    const dynamicAgents: DynamicAgentProfile[] = parsedProfiles.slice(0, 4).map((profile, index) => {
      const id = String(profile.id || `specialist-${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48) || `specialist-${index + 1}`
      const name = String(profile.name || `Specialist ${index + 1}`).trim().slice(0, 80) || `Specialist ${index + 1}`
      const tools = Array.isArray(profile.tools)
        ? profile.tools.filter((tool): tool is string => typeof tool === 'string' && permittedToolSet.has(tool)).slice(0, 12)
        : []
      return {
        id,
        name,
        description: String(profile.description || 'Task-scoped specialist').trim().slice(0, 240),
        systemPrompt: String(profile.systemPrompt || profile.description || 'Complete the assigned specialist task and report a concise handoff to the team leader.').trim().slice(0, 2000),
        tools: tools.length ? tools : this.config.leader.tools.filter((tool) => permittedToolSet.has(tool)),
        modelPreference: validPreferences.has(profile.modelPreference as AgentModelPreference)
          ? profile.modelPreference as AgentModelPreference
          : undefined,
      }
    })
    const dynamicProfileIds = new Set(dynamicAgents.map((profile) => profile.id))
    const dynamicProfileIdBySource = new Map(
      parsedProfiles.slice(0, 4).map((profile, index) => [
        String(profile.id || `specialist-${index + 1}`),
        dynamicAgents[index]?.id,
      ] as const).filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
    )
    const subtasks: SubTask[] = parsedSubtasks.slice(0, maxSubtasks).map((st) => ({
      id: st.id || `task-${uuidv4().slice(0, 8)}`,
      planId,
      title: st.title || 'Untitled task',
      description: st.description || '',
      status: 'pending' as TaskStatus,
      dependencies: Array.isArray(st.dependencies) ? st.dependencies : [],
      assignedRole: validRoles.has(st.assignedRole)
        ? st.assignedRole as SubTask['assignedRole']
        : undefined,
      assignedAgentProfileId: dynamicProfileIds.has(dynamicProfileIdBySource.get(st.assignedAgentProfileId || '') || '')
        ? dynamicProfileIdBySource.get(st.assignedAgentProfileId || '')
        : undefined,
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
      dynamicAgents,
    }

    return plan
  }

  /**
   * Assign a worker based on the subtask's content.
   */
  private assignWorker(subtask: SubTask): AgentConfig {
    if (subtask.assignedAgentProfileId) {
      const dynamicWorker = this.dynamicWorkers.get(subtask.assignedAgentProfileId)
      if (dynamicWorker) return dynamicWorker
    }
    const text = `${subtask.title} ${subtask.description}`.toLowerCase()
    const workers = this.config.workers

    if (workers.length === 0) {
      // Fallback to leader if no workers available
      return this.config.leader
    }

    if (subtask.assignedRole) {
      const assignedWorker = this.nextWorkerForRole(subtask.assignedRole)
      if (assignedWorker) return assignedWorker
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
        const match = this.nextWorkerForRole(role)
        if (match) return match
      }
    }

    // Default: coder (or first available worker)
    return this.nextWorkerForRole('coder') || workers[0]
  }

  private nextWorkerForRole(role: string): AgentConfig | undefined {
    const candidates = this.config.workers.filter((worker) => worker.role === role)
    if (!candidates.length) return undefined
    const cursor = this.assignmentCursor.get(role) || 0
    this.assignmentCursor.set(role, cursor + 1)
    return candidates[cursor % candidates.length]
  }

  private registerDynamicWorkers(profiles: DynamicAgentProfile[]): void {
    const candidatePool = [this.config.leader, ...this.config.workers]
      .flatMap((agent) => [
        ...(agent.modelCandidates || []),
        { providerId: agent.providerId, model: agent.model },
      ])
      .filter((candidate, index, all) => candidate.providerId && candidate.model
        && all.findIndex((item) => item.providerId === candidate.providerId && item.model === candidate.model) === index)
    const fallback = this.config.fallbackModel || candidatePool[0] || { providerId: this.config.leader.providerId, model: this.config.leader.model }

    for (const profile of profiles) {
      this.dynamicWorkers.set(profile.id, {
        id: `task-agent-${uuidv4()}`,
        name: profile.name,
        description: profile.description,
        role: 'custom',
        systemPrompt: `You are ${profile.name}, a task-scoped specialist in a coordinated team.\n\n${profile.systemPrompt}\n\nWork only on your assigned subtask. Respect the available tools and permissions. Return concrete findings, artifacts, and risks for the team leader.`,
        providerId: fallback.providerId,
        model: fallback.model,
        modelCandidates: candidatePool,
        modelPreference: profile.modelPreference,
        tools: profile.tools,
        maxIterations: this.config.leader.maxIterations,
        temperature: this.config.leader.temperature,
        isBuiltIn: false,
        taskScoped: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    }
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
    const provider = this.config.providerForAgent(worker)
    if (!provider) {
      throw new Error(`The model connection for ${worker.name} is unavailable. Configure or enable its model connection.`)
    }

    const runner = new AgentRunner({
      conversationId: this.config.conversationId,
      agentConfig: worker,
      provider,
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

${this.feedback.length > 0 ? `**User guidance received after the plan was created:**\n${this.feedback.map((item) => `- ${item.content}`).join('\n')}\nApply it where it affects your assigned work.` : ''}

Please complete this task. Use the available tools as needed. When done, provide a clear summary of what was accomplished.

**Important:** Focus only on this task. Do not modify files that are not related to this task.`

    let result = ''
    let lastTextContent = ''
    let runnerError = ''

    try {
      for await (const event of runner.run({
        messages: [],
        newMessage: {
          id: uuidv4(),
          conversationId: subtask.agentConversationId || '',
          role: 'user',
          content: workerPrompt,
          timestamp: Date.now(),
        },
      })) {
        // Text deltas can arrive hundreds or thousands of times for a long
        // response. Persisting every delta blocks the Electron main process
        // because conversation storage rewrites the complete JSON history.
        // The final `done` event still stores the full worker handoff.
        if (event.type !== 'text' && event.type !== 'thinking') {
          await this.config.onWorkerEvent?.(subtask, worker, event)
        }
        if (event.type === 'text' && event.content) {
          lastTextContent = event.content
        }
        if (event.type === 'done' && event.content) {
          result = event.content
        }
        if (event.type === 'error' && event.error) {
          runnerError = event.error
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

      if (runnerError) {
        throw new Error(runnerError)
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
    const leader = this.selectExecutionAgent(this.config.leader)
    const provider = this.config.providerForAgent(leader)
    if (!provider) {
      return `Team plan finished, but the leader connection is unavailable for a final summary.\n\n${plan.subtasks.map((subtask) => `- ${subtask.title}: ${subtask.status}`).join('\n')}`
    }

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
  private getExecutionOrder(subtasks: SubTask[], completedIds: Iterable<string> = []): SubTask[][] {
    const visited = new Set<string>(completedIds)
    const batches: SubTask[][] = []

    while (subtasks.some((subtask) => !visited.has(subtask.id))) {
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
