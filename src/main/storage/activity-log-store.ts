import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import type { ActivityLogEntry, ActivityLogFilter, CreateActivityLogEntry } from '../../shared/types/activity'

const MAX_ENTRIES = 1000

export class ActivityLogStore {
  private readonly filePath: string
  private writeLock: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'activity-log.json')
  }

  private read(): ActivityLogEntry[] {
    try {
      if (!fs.existsSync(this.filePath)) return []
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
      return Array.isArray(data) ? data : []
    } catch {
      return []
    }
  }

  private write(entries: ActivityLogEntry[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(entries, null, 2), 'utf-8')
  }

  private enqueue<T>(operation: () => T): Promise<T> {
    const run = async (): Promise<T> => {
      await this.writeLock
      return operation()
    }
    const pending = run()
    this.writeLock = pending.then(() => undefined, () => undefined)
    return pending
  }

  async append(input: CreateActivityLogEntry): Promise<ActivityLogEntry> {
    return this.enqueue(() => {
      const entry: ActivityLogEntry = {
        id: uuidv4(),
        timestamp: input.timestamp ?? Date.now(),
        category: input.category,
        action: input.action,
        status: input.status,
        summary: input.summary,
        conversationId: input.conversationId,
        workspaceId: input.workspaceId,
      }
      const entries = [entry, ...this.read()].slice(0, MAX_ENTRIES)
      this.write(entries)
      return entry
    })
  }

  async list(filter: ActivityLogFilter = {}): Promise<ActivityLogEntry[]> {
    return this.enqueue(() => {
      const limit = Math.min(Math.max(filter.limit ?? 250, 1), MAX_ENTRIES)
      return this.read()
        .filter((entry) => !filter.conversationId || entry.conversationId === filter.conversationId)
        .filter((entry) => !filter.workspaceId || entry.workspaceId === filter.workspaceId)
        .slice(0, limit)
    })
  }
}
