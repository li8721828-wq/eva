/**
 * Canonical in-process ownership for work that belongs to a conversation.
 * Durable progress remains in storage; this registry only owns cancellable
 * process-local handles and must therefore be cleared when a run finishes.
 */
export type ActiveRunKind =
  | 'chat'
  | 'chat-task'
  | 'background-goal'
  | 'delegated-team'
  | 'symposium-runners'
  | 'symposium-aborter'
  | 'task-team'
  | 'task-goal'
  | 'scheduler-interactive'
  | 'scheduler-task'
  | 'requirement'

export type ActiveRunStatus = 'queued' | 'running' | 'paused' | 'cancelling' | 'completed' | 'failed' | 'cancelled'

export interface ActiveRunEntry<T = unknown> {
  kind: ActiveRunKind
  conversationId: string
  handle: T
  startedAt: number
  updatedAt: number
  status: ActiveRunStatus
  detail?: string
}

export interface ActiveRunMap<T> {
  readonly size: number
  get(conversationId: string): T | undefined
  set(conversationId: string, handle: T): ActiveRunMap<T>
  has(conversationId: string): boolean
  delete(conversationId: string): boolean
  forEach(callback: (handle: T, conversationId: string) => void): void
}

export class RunRegistry {
  private readonly entries = new Map<string, ActiveRunEntry>()

  forKind<T>(kind: ActiveRunKind): ActiveRunMap<T> {
    const registry = this
    return {
      get size() {
        return Array.from(registry.entries.values()).filter((entry) => entry.kind === kind).length
      },
      get: (conversationId) => this.get<T>(kind, conversationId),
      set: (conversationId, handle) => {
        this.set(kind, conversationId, handle)
        return this.forKind<T>(kind)
      },
      has: (conversationId) => this.has(kind, conversationId),
      delete: (conversationId) => this.delete(kind, conversationId),
      forEach: (callback) => {
        for (const entry of registry.entries.values()) {
          if (entry.kind === kind) callback(entry.handle as T, entry.conversationId)
        }
      },
    }
  }

  get<T>(kind: ActiveRunKind, conversationId: string): T | undefined {
    return this.entries.get(this.key(kind, conversationId))?.handle as T | undefined
  }

  set<T>(kind: ActiveRunKind, conversationId: string, handle: T): void {
    const now = Date.now()
    this.entries.set(this.key(kind, conversationId), { kind, conversationId, handle, startedAt: now, updatedAt: now, status: 'running' })
  }

  transition(kind: ActiveRunKind, conversationId: string, status: ActiveRunStatus, detail?: string): void {
    const key = this.key(kind, conversationId)
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.set(key, { ...entry, status, detail, updatedAt: Date.now() })
  }

  has(kind: ActiveRunKind, conversationId: string): boolean {
    return this.entries.has(this.key(kind, conversationId))
  }

  delete(kind: ActiveRunKind, conversationId: string): boolean {
    return this.entries.delete(this.key(kind, conversationId))
  }

  list(conversationId?: string): ActiveRunEntry[] {
    return Array.from(this.entries.values()).filter((entry) => !conversationId || entry.conversationId === conversationId)
  }

  clearConversation(conversationId: string): void {
    for (const entry of this.list(conversationId)) this.entries.delete(this.key(entry.kind, conversationId))
  }

  private key(kind: ActiveRunKind, conversationId: string): string {
    return `${kind}:${conversationId}`
  }
}

export const activeRunRegistry = new RunRegistry()
