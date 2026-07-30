import fs from 'fs'
import path from 'path'
import type { TaskRunSnapshot } from '../../shared/types/task'

interface TaskRunIndex {
  snapshots: Record<string, TaskRunSnapshot>
}

/** Durable checkpoints for long-running Goal and Team work. */
export class TaskRunStore {
  private readonly filePath: string
  private writeLock: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'task-runs.json')
  }

  async get(conversationId: string): Promise<TaskRunSnapshot | null> {
    return this.enqueue(() => this.read().snapshots[conversationId] || null)
  }

  async list(): Promise<TaskRunSnapshot[]> {
    return this.enqueue(() => Object.values(this.read().snapshots).sort((a, b) => b.updatedAt - a.updatedAt))
  }

  async save(snapshot: Omit<TaskRunSnapshot, 'updatedAt'> | TaskRunSnapshot): Promise<TaskRunSnapshot> {
    return this.enqueue(() => {
      const index = this.read()
      const existing = index.snapshots[snapshot.conversationId]
      // IPC event handlers update only the parts of a snapshot they own. Keep
      // scheduler metadata and the original request intact between events.
      const next: TaskRunSnapshot = {
        ...existing,
        ...snapshot,
        execution: snapshot.execution ?? existing?.execution,
        goal: snapshot.goal ?? existing?.goal,
        agentId: snapshot.agentId ?? existing?.agentId,
        updatedAt: Date.now(),
      }
      index.snapshots[next.conversationId] = next
      this.write(index)
      return next
    })
  }

  async markRunningAsInterrupted(): Promise<void> {
    return this.enqueue(() => {
      const index = this.read()
      let changed = false
      for (const snapshot of Object.values(index.snapshots)) {
        if (snapshot.status !== 'running' && snapshot.status !== 'paused') continue
        snapshot.status = 'interrupted'
        snapshot.error = snapshot.error || 'Eva was closed before this task finished. Review the completed steps, then start a new run for the remaining work.'
        snapshot.updatedAt = Date.now()
        changed = true
      }
      if (changed) this.write(index)
    })
  }

  private read(): TaskRunIndex {
    try {
      if (!fs.existsSync(this.filePath)) return { snapshots: {} }
      return JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as TaskRunIndex
    } catch {
      return { snapshots: {} }
    }
  }

  private write(index: TaskRunIndex): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(index, null, 2), 'utf-8')
  }

  private enqueue<T>(work: () => T): Promise<T> {
    const run = async (): Promise<T> => {
      await this.writeLock
      return work()
    }
    const result = run()
    this.writeLock = result.then(() => undefined, () => undefined)
    return result
  }
}
