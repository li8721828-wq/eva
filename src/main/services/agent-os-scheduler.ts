import type { RuntimeKernelProcess, RuntimeProcessKind, RuntimeProcessStatus } from '../../shared/types/runtime-kernel'
import type { RuntimeRunDescriptor, RuntimeRunPayload } from '../../shared/types/runtime-run'
import { getStorage } from '../storage'
import { RuntimeKernelStore } from '../storage/runtime-kernel-store'
import { RuntimeRunStore } from '../storage/runtime-run-store'
import { TaskExecutionQueue, type TaskQueueJob, type TaskQueueResult, type TaskQueueUpdate } from './task-execution-queue'

type TaskKind = TaskQueueJob['kind']

export interface AgentOsTaskInput {
  conversationId: string
  kind: TaskKind
  runtimeKind: Extract<RuntimeProcessKind, 'goal' | 'team'>
  agentId?: string
  workspaceId?: string
  resourceKey: string
  summary: string
  maxAttempts?: number
  recoveryPayload?: RuntimeRunPayload
  run: (attempt: number) => Promise<TaskQueueResult>
  onUpdate?: (update: TaskQueueUpdate) => void | Promise<void>
}

export interface AgentOsInteractiveInput {
  conversationId: string
  agentId?: string
  workspaceId?: string
  summary: string
  /** Normal chats are serialized only with the same conversation. */
  resourceKey?: string
  recoveryPayload?: RuntimeRunPayload
}

interface InteractiveRun {
  processId: string
  abort?: () => void
}

type RecoveryHandler = (run: RuntimeRunDescriptor, context: unknown) => Promise<boolean>

/**
 * Process-local execution admission for Agent OS. The durable RuntimeKernel is
 * the source of truth for lifecycle state; this service owns live abort handles
 * and the resource-aware queue needed to execute that state.
 */
export class AgentOsScheduler {
  private readonly taskQueue: TaskExecutionQueue
  private readonly interactiveRuns = new Map<string, InteractiveRun>()
  private readonly taskProcesses = new Map<string, { processId: string; kind: Extract<RuntimeProcessKind, 'goal' | 'team'> }>()
  private readonly recoveryHandlers = new Map<RuntimeProcessKind, RecoveryHandler>()

  constructor(
    private readonly runtimeKernel: RuntimeKernelStore,
    maxConcurrentTasks = 2,
    private readonly runtimeRuns?: RuntimeRunStore,
  ) {
    this.taskQueue = new TaskExecutionQueue(maxConcurrentTasks)
  }

  hasTask(conversationId: string, kind: TaskKind): boolean {
    return this.taskQueue.has(conversationId, kind)
  }

  async scheduleTask(input: AgentOsTaskInput): Promise<boolean> {
    if (this.taskQueue.has(input.conversationId, input.kind)) return false

    const process = await this.runtimeKernel.start({
      conversationId: input.conversationId,
      kind: input.runtimeKind,
      status: 'queued',
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      resourceKeys: [input.resourceKey],
      summary: input.summary,
    })
    this.taskProcesses.set(input.conversationId, { processId: process.id, kind: input.runtimeKind })
    await this.persistRun(process, 'queued', 'auto-queued', input.recoveryPayload)

    const accepted = this.taskQueue.enqueue({
      conversationId: input.conversationId,
      kind: input.kind,
      resourceKey: input.resourceKey,
      maxAttempts: input.maxAttempts,
      run: input.run,
      onUpdate: async (update) => {
        await input.onUpdate?.(update)
        await this.runtimeKernel.transition(process.id, this.toRuntimeStatus(update.state), this.detailForUpdate(update))
        await this.runtimeRuns?.transition(process.id, this.toRuntimeStatus(update.state), this.detailForUpdate(update))
        if (this.isTerminal(update.state) && this.taskProcesses.get(input.conversationId)?.processId === process.id) {
          this.taskProcesses.delete(input.conversationId)
        }
      },
    })

    if (!accepted) {
      this.taskProcesses.delete(input.conversationId)
      await this.runtimeKernel.transition(process.id, 'cancelled', 'A task is already scheduled for this conversation.')
      await this.runtimeRuns?.transition(process.id, 'cancelled', 'A task is already scheduled for this conversation.')
    }
    return accepted
  }

  async startInteractive(input: AgentOsInteractiveInput): Promise<RuntimeKernelProcess> {
    await this.cancelInteractive(input.conversationId, 'Superseded by a newer chat request.')
    const process = await this.runtimeKernel.start({
      conversationId: input.conversationId,
      kind: 'agent',
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      resourceKeys: input.resourceKey ? [input.resourceKey] : undefined,
      summary: input.summary,
    })
    this.interactiveRuns.set(input.conversationId, { processId: process.id })
    await this.persistRun(process, 'running', 'checkpointed-manual', input.recoveryPayload)
    return process
  }

  attachInteractiveAbort(conversationId: string, processId: string, abort: () => void): void {
    const active = this.interactiveRuns.get(conversationId)
    if (active?.processId === processId) active.abort = abort
  }

  async finishInteractive(processId: string, status: Extract<RuntimeProcessStatus, 'completed' | 'failed' | 'cancelled'>, detail?: string): Promise<void> {
    await this.runtimeKernel.transition(processId, status, detail)
    await this.runtimeRuns?.transition(processId, status, detail)
    for (const [conversationId, run] of this.interactiveRuns) {
      if (run.processId === processId) this.interactiveRuns.delete(conversationId)
    }
  }

  async cancelInteractive(conversationId: string, detail = 'Stopped by the user.'): Promise<boolean> {
    const run = this.interactiveRuns.get(conversationId)
    if (!run) return false
    run.abort?.()
    this.interactiveRuns.delete(conversationId)
    await this.runtimeKernel.transition(run.processId, 'cancelled', detail)
    await this.runtimeRuns?.transition(run.processId, 'cancelled', detail)
    return true
  }

  async cancelTask(conversationId: string, kind?: TaskKind, detail = 'Stopped by the user.'): Promise<boolean> {
    const cancelled = this.taskQueue.cancel(conversationId, kind)
    const process = this.taskProcesses.get(conversationId)
    if (process) {
      await this.runtimeKernel.transition(process.processId, 'cancelled', detail)
      await this.runtimeRuns?.transition(process.processId, 'cancelled', detail)
      this.taskProcesses.delete(conversationId)
    }
    return cancelled || Boolean(process)
  }

  async transitionTask(
    conversationId: string,
    kind: Extract<RuntimeProcessKind, 'goal' | 'team'>,
    status: RuntimeProcessStatus,
    detail?: string,
  ): Promise<void> {
    const process = this.taskProcesses.get(conversationId)
    if (process && process.kind === kind) {
      await this.runtimeKernel.transition(process.processId, status, detail)
      await this.runtimeRuns?.transition(process.processId, status, detail)
      if (!['queued', 'running', 'paused'].includes(status)) this.taskProcesses.delete(conversationId)
      return
    }
    await this.runtimeKernel.transitionConversation(conversationId, kind, status, detail)
  }

  async startChild(input: Omit<AgentOsInteractiveInput, 'resourceKey'> & { kind: Extract<RuntimeProcessKind, 'goal' | 'team'> }): Promise<RuntimeKernelProcess> {
    const process = await this.runtimeKernel.start({
      conversationId: input.conversationId,
      kind: input.kind,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      summary: input.summary,
      supersede: false,
    })
    await this.persistRun(process, 'running', 'checkpointed-manual')
    return process
  }

  async finishProcess(processId: string, status: Extract<RuntimeProcessStatus, 'completed' | 'failed' | 'cancelled'>, detail?: string): Promise<void> {
    await this.runtimeKernel.transition(processId, status, detail)
    await this.runtimeRuns?.transition(processId, status, detail)
  }

  async transitionConversation(
    conversationId: string,
    kind: RuntimeProcessKind,
    status: RuntimeProcessStatus,
    detail?: string,
  ): Promise<void> {
    await this.runtimeKernel.transitionConversation(conversationId, kind, status, detail)
  }

  registerRecoveryHandler(kind: RuntimeProcessKind, handler: RecoveryHandler): void {
    this.recoveryHandlers.set(kind, handler)
  }

  async recoverQueued(context: unknown): Promise<string[]> {
    if (!this.runtimeRuns) return []
    const recovered: string[] = []
    for (const run of await this.runtimeRuns.listRecoverable()) {
      const handler = this.recoveryHandlers.get(run.kind)
      if (!handler) continue
      const accepted = await handler(run, context)
      if (!accepted) continue
      await this.runtimeRuns.save({
        ...run,
        status: 'replayed',
        recoveryCount: run.recoveryCount + 1,
        lastRecoveryAt: Date.now(),
        detail: 'Replayed into a new Agent OS run after application restart.',
      })
      recovered.push(run.conversationId)
    }
    return recovered
  }

  private async persistRun(
    process: RuntimeKernelProcess,
    status: RuntimeRunDescriptor['status'],
    recoveryMode: RuntimeRunDescriptor['recoveryMode'],
    payload?: RuntimeRunPayload,
  ): Promise<void> {
    await this.runtimeRuns?.save({
      id: process.id,
      conversationId: process.conversationId,
      kind: process.kind,
      status,
      workspaceId: process.workspaceId,
      resourceKeys: process.resourceKeys || [],
      payload,
      recoveryMode,
      idempotencyKey: process.id,
      createdAt: process.startedAt,
      updatedAt: process.updatedAt,
      recoveryCount: 0,
      detail: process.summary,
    })
  }

  private toRuntimeStatus(state: TaskQueueUpdate['state']): Extract<RuntimeProcessStatus, 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'> {
    if (state === 'running') return 'running'
    if (state === 'completed') return 'completed'
    if (state === 'failed') return 'failed'
    if (state === 'cancelled') return 'cancelled'
    return 'queued'
  }

  private detailForUpdate(update: TaskQueueUpdate): string | undefined {
    if (update.state === 'running') return 'Agent OS scheduler admitted this run for execution.'
    if (update.state === 'retrying') return update.error || 'Execution will retry automatically.'
    if (update.state === 'failed') return update.error || 'Execution failed.'
    if (update.state === 'cancelled') return 'Execution was cancelled.'
    return undefined
  }

  private isTerminal(state: TaskQueueUpdate['state']): boolean {
    return state === 'completed' || state === 'failed' || state === 'cancelled'
  }
}

let scheduler: AgentOsScheduler | undefined

export function getAgentOsScheduler(): AgentOsScheduler {
  if (!scheduler) scheduler = new AgentOsScheduler(getStorage().runtimeKernel, 2, getStorage().runtimeRuns)
  return scheduler
}
