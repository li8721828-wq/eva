export type TaskQueueState = 'queued' | 'running' | 'retrying' | 'completed' | 'failed' | 'cancelled'

export interface TaskQueueResult {
  status: 'completed' | 'failed' | 'cancelled'
  error?: string
  /** Defaults to true for failed runs. Set false for configuration errors. */
  retryable?: boolean
}

export interface TaskQueueUpdate {
  conversationId: string
  kind: 'expert' | 'goal'
  state: TaskQueueState
  attempt: number
  maxAttempts: number
  queuedAt: number
  startedAt?: number
  nextRetryAt?: number
  error?: string
  resourceKey?: string
}

export interface TaskQueueJob {
  conversationId: string
  kind: 'expert' | 'goal'
  run: (attempt: number) => Promise<TaskQueueResult>
  maxAttempts?: number
  /** Jobs sharing a resource key never execute concurrently. */
  resourceKey?: string
  onUpdate?: (update: TaskQueueUpdate) => void | Promise<void>
}

interface PendingTaskJob extends TaskQueueJob {
  id: string
  attempt: number
  queuedAt: number
}

/**
 * A small, process-local scheduler for durable Goal and Team runs. Persistence
 * is delegated to the caller so it can live beside plans and checkpoints.
 */
export class TaskExecutionQueue {
  private readonly pending: PendingTaskJob[] = []
  private readonly running = new Map<string, PendingTaskJob>()
  private readonly retryTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; job: PendingTaskJob }>()
  private readonly cancellationRequested = new Set<string>()
  private readonly activeResources = new Set<string>()
  private readonly reservedResources = new Set<string>()

  constructor(
    private readonly maxConcurrent = 2,
    private readonly retryDelayMs: (attempt: number) => number = (attempt) => Math.min(15_000, attempt * 2_000),
  ) {}

  enqueue(job: TaskQueueJob): boolean {
    const id = this.idFor(job)
    if (this.hasConversation(job.conversationId)) return false

    const pending: PendingTaskJob = {
      ...job,
      id,
      attempt: 0,
      queuedAt: Date.now(),
    }
    this.pending.push(pending)
    this.drain()
    return true
  }

  has(conversationId: string, kind: TaskQueueJob['kind']): boolean {
    const id = this.idFor({ conversationId, kind })
    return this.running.has(id) || this.pending.some((item) => item.id === id) || this.retryTimers.has(id)
  }

  hasConversation(conversationId: string): boolean {
    return Array.from(this.running.values()).some((job) => job.conversationId === conversationId)
      || this.pending.some((job) => job.conversationId === conversationId)
      || Array.from(this.retryTimers.values()).some(({ job }) => job.conversationId === conversationId)
  }

  reserveResource(resourceKey: string): boolean {
    if (!resourceKey || this.activeResources.has(resourceKey) || this.reservedResources.has(resourceKey)) return false
    this.reservedResources.add(resourceKey)
    return true
  }

  releaseResource(resourceKey: string): void {
    if (this.reservedResources.delete(resourceKey)) this.drain()
  }

  cancel(conversationId: string, kind?: TaskQueueJob['kind']): boolean {
    let cancelled = false

    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const job = this.pending[index]
      if (job.conversationId === conversationId && (!kind || job.kind === kind)) {
        this.pending.splice(index, 1)
        void this.notify(job, 'cancelled')
        cancelled = true
      }
    }
    for (const [timerId, entry] of this.retryTimers) {
      if (entry.job.conversationId === conversationId && (!kind || entry.job.kind === kind)) {
        clearTimeout(entry.timer)
        this.retryTimers.delete(timerId)
        void this.notify(entry.job, 'cancelled')
        cancelled = true
      }
    }
    for (const [runningId, job] of this.running) {
      if (job.conversationId === conversationId && (!kind || job.kind === kind)) {
        // The task owner is responsible for aborting its planner. Keeping this
        // marker prevents a late successful return from reviving a task the
        // user has explicitly stopped.
        this.cancellationRequested.add(runningId)
        cancelled = true
      }
    }
    return cancelled
  }

  get activeCount(): number {
    return this.running.size
  }

  get queuedCount(): number {
    return this.pending.length + this.retryTimers.size
  }

  private drain(): void {
    while (this.running.size < this.maxConcurrent && this.pending.length > 0) {
      // Do not let a blocked same-workspace task prevent a ready task from a
      // different workspace from using an available global execution slot.
      const index = this.pending.findIndex((job) => !job.resourceKey || (!this.activeResources.has(job.resourceKey) && !this.reservedResources.has(job.resourceKey)))
      if (index < 0) return
      const [job] = this.pending.splice(index, 1)
      if (job) void this.execute(job)
    }
  }

  private async execute(job: PendingTaskJob): Promise<void> {
    this.running.set(job.id, job)
    if (job.resourceKey) this.activeResources.add(job.resourceKey)
    job.attempt += 1
    let result: TaskQueueResult
    try {
      await this.notify(job, 'running')
      result = await job.run(job.attempt)
    } catch (error) {
      result = { status: 'failed', error: error instanceof Error ? error.message : String(error) }
    } finally {
      this.running.delete(job.id)
      if (job.resourceKey) this.activeResources.delete(job.resourceKey)
    }

    if (this.cancellationRequested.delete(job.id)) {
      result = { status: 'cancelled' }
    }

    if (result.status === 'failed' && result.retryable !== false && job.attempt < (job.maxAttempts ?? 2)) {
      const delay = this.retryDelayMs(job.attempt)
      const nextRetryAt = Date.now() + delay
      await this.notify(job, 'retrying', { nextRetryAt, error: result.error })
      const timer = setTimeout(() => {
        this.retryTimers.delete(job.id)
        void this.requeue(job)
      }, delay)
      this.retryTimers.set(job.id, { timer, job })
    } else {
      await this.notify(job, result.status, { error: result.error })
    }
    this.drain()
  }

  private async notify(job: PendingTaskJob, state: TaskQueueState, extra: Pick<TaskQueueUpdate, 'nextRetryAt' | 'error'> = {}): Promise<void> {
    try {
      await job.onUpdate?.({
        conversationId: job.conversationId,
        kind: job.kind,
        state,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts ?? 2,
        queuedAt: job.queuedAt,
        startedAt: state === 'running' ? Date.now() : undefined,
        resourceKey: job.resourceKey,
        ...extra,
      })
    } catch (error) {
      console.warn(`Task queue status notification failed for ${job.conversationId}/${job.kind}:`, error)
    }
  }

  private idFor(job: Pick<TaskQueueJob, 'conversationId' | 'kind'>): string {
    return `${job.conversationId}:${job.kind}`
  }

  private async requeue(job: PendingTaskJob): Promise<void> {
    await this.notify(job, 'queued')
    this.pending.push(job)
    this.drain()
  }
}
