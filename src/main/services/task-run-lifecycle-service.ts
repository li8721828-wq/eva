import type { TaskRunSnapshot } from '../../shared/types/task'
import type { TaskQueueUpdate } from './task-execution-queue'
import type { StorageManager } from '../storage'

export class TaskRunLifecycleService {
  constructor(private readonly storage: StorageManager) {}

  async resolveRuntimeScope(conversationId: string): Promise<{ workspaceId?: string; resourceKey: string }> {
    const conversation = await this.storage.conversations.getConversation(conversationId)
    if (conversation?.workspaceId) return { workspaceId: conversation.workspaceId, resourceKey: `workspace:${conversation.workspaceId}` }
    if (conversation?.workspacePath?.trim()) return { resourceKey: `workspace-path:${conversation.workspacePath.trim().toLowerCase()}` }
    return { resourceKey: `conversation:${conversationId}` }
  }

  async syncActivePlan(conversationId: string): Promise<void> {
    const [conversation, snapshot] = await Promise.all([
      this.storage.conversations.getConversation(conversationId),
      this.storage.taskRuns.get(conversationId),
    ])
    if (!conversation || !snapshot) return
    const goal = snapshot.goal || snapshot.plan?.goal || snapshot.progress?.goal
    if (!goal) return
    await this.storage.activePlans.syncTask({
      conversationId,
      workspaceId: conversation.workspaceId,
      workspacePath: conversation.workspacePath,
      kind: snapshot.kind,
      status: snapshot.status,
      goal,
      plan: snapshot.plan,
      progress: snapshot.progress,
    })
  }

  async persistQueueUpdate(update: TaskQueueUpdate): Promise<void> {
    const snapshot = await this.storage.taskRuns.get(update.conversationId)
    if (!snapshot) return
    const status = this.statusForQueueUpdate(update)
    const error = update.state === 'retrying'
      ? `${update.error || 'Task failed'} Retrying automatically.`
      : update.state === 'queued' || update.state === 'running'
        ? undefined
        : update.state === 'failed'
          ? update.error || snapshot.error
          : undefined

    await this.storage.taskRuns.save({
      ...snapshot,
      status,
      error,
      execution: {
        state: update.state,
        attempt: update.attempt,
        maxAttempts: update.maxAttempts,
        queuedAt: update.queuedAt,
        startedAt: update.startedAt || snapshot.execution?.startedAt,
        lastActivityAt: Date.now(),
        nextRetryAt: update.nextRetryAt,
      },
    })
    await this.storage.conversations.updateConversation(update.conversationId, {
      executionStatus: status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : status === 'failed' ? 'failed' : 'running',
      executionUpdatedAt: Date.now(),
    })
  }

  private statusForQueueUpdate(update: TaskQueueUpdate): TaskRunSnapshot['status'] {
    if (update.state === 'queued' || update.state === 'retrying') return 'queued'
    if (update.state === 'running') return 'running'
    if (update.state === 'completed') return 'completed'
    if (update.state === 'failed') return 'failed'
    return 'cancelled'
  }
}
