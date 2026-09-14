import type { RuntimeProcessStatus } from '../../shared/types/runtime-kernel'
import type { RuntimeRunMetrics } from '../../shared/types/runtime-run'
import { ConversationStore } from '../storage/conversation-store'
import { RuntimeKernelStore } from '../storage/runtime-kernel-store'
import { RuntimeRunStore } from '../storage/runtime-run-store'

/** Coordinates the durable mirrors of one Agent execution lifecycle change. */
export class RunLifecycleCoordinator {
  constructor(
    private readonly runtimeKernel: RuntimeKernelStore,
    private readonly runtimeRuns: RuntimeRunStore | undefined,
    private readonly conversations?: ConversationStore,
  ) {}

  async transition(
    processId: string,
    status: RuntimeProcessStatus,
    detail?: string,
    metrics?: RuntimeRunMetrics,
  ): Promise<void> {
    const process = await this.runtimeKernel.transition(processId, status, detail)
    if (!process) return

    const results = await Promise.allSettled([
      this.runtimeRuns?.transition(processId, status, detail, metrics),
      this.conversations?.updateConversation(process.conversationId, {
        executionStatus: status === 'interrupted' ? 'failed' : status === 'queued' ? 'running' : status === 'paused' ? 'paused' : status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed',
        executionUpdatedAt: Date.now(),
      }),
    ])
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length) {
      throw new AggregateError(failures.map((failure) => failure.reason), `Run ${processId} state mirrors were not fully persisted.`)
    }
  }
}
