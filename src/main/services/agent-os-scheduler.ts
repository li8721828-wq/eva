import type { RuntimeKernelProcess, RuntimeProcessKind, RuntimeProcessStatus } from '../../shared/types/runtime-kernel'
import type { RuntimeRunDescriptor, RuntimeRunPayload } from '../../shared/types/runtime-run'
import { getStorage } from '../storage'
import { RuntimeKernelStore } from '../storage/runtime-kernel-store'
import { RuntimeRunStore } from '../storage/runtime-run-store'
import { TaskExecutionQueue, type TaskQueueJob, type TaskQueueResult, type TaskQueueUpdate } from './task-execution-queue'
import { activeRunRegistry, type ActiveRunStatus } from './run-registry'

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
  idempotencyKey?: string
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
  private readonly interactiveRuns = activeRunRegistry.forKind<InteractiveRun>('scheduler-interactive')
  private readonly taskProcesses = activeRunRegistry.forKind<{ processId: string; kind: Extract<RuntimeProcessKind, 'goal' | 'team'> }>('scheduler-task')
  private readonly childResources = new Map<string, string>()
  private readonly recoveryHandlers = new Map<RuntimeProcessKind, RecoveryHandler>()
  private readonly recoveringRuns = new Set<string>()
  private readonly activeIdempotencyKeys = new Set<string>()

  constructor(
    private readonly runtimeKernel: RuntimeKernelStore,
    maxConcurrentTasks = 2,
    private readonly runtimeRuns?: RuntimeRunStore,
  ) {
    this.taskQueue = new TaskExecutionQueue(maxConcurrentTasks)
  }

  hasTask(conversationId: string, kind: TaskKind): boolean {
    // Goal and Team runs share one conversation execution context.
    return this.taskQueue.hasConversation(conversationId)
  }

  async scheduleTask(input: AgentOsTaskInput): Promise<boolean> {
    if (this.taskQueue.hasConversation(input.conversationId)) return false
    const idempotencyKey = input.idempotencyKey?.trim()
    if (idempotencyKey && this.activeIdempotencyKeys.has(idempotencyKey)) return false

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
    activeRunRegistry.transition('scheduler-task', input.conversationId, 'queued')
    try {
      await this.persistRun(process, 'queued', 'auto-queued', input.recoveryPayload)
    } catch (error) {
      this.taskProcesses.delete(input.conversationId)
      await this.transitionStores(process.id, 'failed', `Could not persist the queued Agent OS run: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }

    const accepted = this.taskQueue.enqueue({
      conversationId: input.conversationId,
      kind: input.kind,
      resourceKey: input.resourceKey,
      maxAttempts: input.maxAttempts,
      run: input.run,
      onUpdate: async (update) => {
        activeRunRegistry.transition('scheduler-task', input.conversationId, this.toRegistryStatus(update.state), this.detailForUpdate(update))
        await input.onUpdate?.(update)
        await this.transitionStores(process.id, this.toRuntimeStatus(update.state), this.detailForUpdate(update))
        if (this.isTerminal(update.state) && this.taskProcesses.get(input.conversationId)?.processId === process.id) {
          this.taskProcesses.delete(input.conversationId)
          if (idempotencyKey) this.activeIdempotencyKeys.delete(idempotencyKey)
        }
      },
    })

    if (!accepted) {
      this.taskProcesses.delete(input.conversationId)
      await this.transitionStores(process.id, 'cancelled', 'A task is already scheduled for this conversation.')
    } else if (idempotencyKey) {
      this.activeIdempotencyKeys.add(idempotencyKey)
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
    try {
      await this.persistRun(process, 'running', 'checkpointed-manual', input.recoveryPayload)
    } catch (error) {
      this.interactiveRuns.delete(input.conversationId)
      await this.transitionStores(process.id, 'failed', `Could not persist the Agent OS chat run: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
    return process
  }

  attachInteractiveAbort(conversationId: string, processId: string, abort: () => void): void {
    const active = this.interactiveRuns.get(conversationId)
    if (active?.processId === processId) active.abort = abort
  }

  async finishInteractive(processId: string, status: Extract<RuntimeProcessStatus, 'completed' | 'failed' | 'cancelled'>, detail?: string): Promise<void> {
    await this.transitionStores(processId, status, detail)
    this.interactiveRuns.forEach((run, conversationId) => {
      if (run.processId === processId) activeRunRegistry.transition('scheduler-interactive', conversationId, status, detail)
    })
    this.interactiveRuns.forEach((run, conversationId) => {
      if (run.processId === processId) this.interactiveRuns.delete(conversationId)
    })
  }

  async cancelInteractive(conversationId: string, detail = 'Stopped by the user.'): Promise<boolean> {
    const run = this.interactiveRuns.get(conversationId)
    if (!run) return false
    run.abort?.()
    activeRunRegistry.transition('scheduler-interactive', conversationId, 'cancelling', detail)
    this.interactiveRuns.delete(conversationId)
    await this.transitionStores(run.processId, 'cancelled', detail)
    return true
  }

  async cancelTask(conversationId: string, kind?: TaskKind, detail = 'Stopped by the user.'): Promise<boolean> {
    const cancelled = this.taskQueue.cancel(conversationId, kind)
    activeRunRegistry.transition('scheduler-task', conversationId, 'cancelling', detail)
    const process = this.taskProcesses.get(conversationId)
    const runtimeKind = kind === 'expert' ? 'team' : kind === 'goal' ? 'goal' : undefined
    const processMatches = Boolean(process && (!runtimeKind || process.kind === runtimeKind))
    if (processMatches && process) {
      await this.transitionStores(process.processId, 'cancelled', detail)
      this.taskProcesses.delete(conversationId)
    }
    return cancelled || processMatches
  }

  async transitionTask(
    conversationId: string,
    kind: Extract<RuntimeProcessKind, 'goal' | 'team'>,
    status: RuntimeProcessStatus,
    detail?: string,
  ): Promise<void> {
    const process = this.taskProcesses.get(conversationId)
    if (process && process.kind === kind) {
      await this.transitionStores(process.processId, status, detail)
      if (!['queued', 'running', 'paused'].includes(status)) this.taskProcesses.delete(conversationId)
      return
    }
    const transitioned = await this.runtimeKernel.transitionConversation(conversationId, kind, status, detail)
    if (transitioned) await this.transitionStores(transitioned.id, status, detail)
  }

  async startChild(input: AgentOsInteractiveInput & { kind: Extract<RuntimeProcessKind, 'goal' | 'team'> }): Promise<RuntimeKernelProcess> {
    const resourceKey = input.resourceKey?.trim()
    if (resourceKey && !this.taskQueue.reserveResource(resourceKey)) {
      throw new Error(`Resource ${resourceKey} is already in use by another Agent OS run.`)
    }
    try {
      const process = await this.runtimeKernel.start({
        conversationId: input.conversationId,
        kind: input.kind,
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        resourceKeys: resourceKey ? [resourceKey] : undefined,
        summary: input.summary,
        supersede: false,
      })
      if (resourceKey) this.childResources.set(process.id, resourceKey)
      await this.persistRun(process, 'running', 'checkpointed-manual')
      return process
    } catch (error) {
      if (resourceKey) this.taskQueue.releaseResource(resourceKey)
      throw error
    }
  }

  async finishProcess(processId: string, status: Extract<RuntimeProcessStatus, 'completed' | 'failed' | 'cancelled'>, detail?: string): Promise<void> {
    await this.transitionStores(processId, status, detail)
    this.releaseChildResource(processId)
  }

  async transitionConversation(
    conversationId: string,
    kind: RuntimeProcessKind,
    status: RuntimeProcessStatus,
    detail?: string,
  ): Promise<void> {
    const process = await this.runtimeKernel.transitionConversation(conversationId, kind, status, detail)
    if (process) {
      await this.transitionStores(process.id, status, detail)
      if (this.isTerminal(status)) this.releaseChildResource(process.id)
    }
  }

  private releaseChildResource(processId: string): void {
    const resourceKey = this.childResources.get(processId)
    if (!resourceKey) return
    this.childResources.delete(processId)
    this.taskQueue.releaseResource(resourceKey)
  }

  private async transitionStores(processId: string, status: RuntimeProcessStatus, detail?: string): Promise<void> {
    const results = await Promise.allSettled([
      this.runtimeKernel.transition(processId, status, detail),
      this.runtimeRuns?.transition(processId, status, detail),
    ])
    for (const result of results) {
      if (result.status === 'rejected') console.error(`Agent OS state transition failed for ${processId}:`, result.reason)
    }
  }

  registerRecoveryHandler(kind: RuntimeProcessKind, handler: RecoveryHandler): void {
    this.recoveryHandlers.set(kind, handler)
  }

  async recoverQueued(context: unknown): Promise<string[]> {
    if (!this.runtimeRuns) return []
    const recovered: string[] = []
    for (const run of await this.runtimeRuns.listRecoverable()) {
      if (this.recoveringRuns.has(run.id)) continue
      const handler = this.recoveryHandlers.get(run.kind)
      if (!handler) continue
      let accepted = false
      this.recoveringRuns.add(run.id)
      try {
        accepted = await handler(run, context)
      } catch (error) {
        await this.runtimeRuns.save({
          ...run,
          status: 'failed',
          detail: `Recovery failed: ${error instanceof Error ? error.message : String(error)}`,
        })
        this.recoveringRuns.delete(run.id)
        continue
      }
      this.recoveringRuns.delete(run.id)
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
      idempotencyKey: payload?.idempotencyKey || process.id,
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

  private toRegistryStatus(state: TaskQueueUpdate['state']): ActiveRunStatus {
    if (state === 'retrying') return 'queued'
    return this.toRuntimeStatus(state)
  }

  private detailForUpdate(update: TaskQueueUpdate): string | undefined {
    if (update.state === 'running') return 'Agent OS scheduler admitted this run for execution.'
    if (update.state === 'retrying') return update.error || 'Execution will retry automatically.'
    if (update.state === 'failed') return update.error || 'Execution failed.'
    if (update.state === 'cancelled') return 'Execution was cancelled.'
    return undefined
  }

  private isTerminal(state: TaskQueueUpdate['state'] | RuntimeProcessStatus): boolean {
    return state === 'completed' || state === 'failed' || state === 'cancelled'
  }
}

let scheduler: AgentOsScheduler | undefined

export function getAgentOsScheduler(): AgentOsScheduler {
  if (!scheduler) scheduler = new AgentOsScheduler(getStorage().runtimeKernel, 2, getStorage().runtimeRuns)
  return scheduler
}
