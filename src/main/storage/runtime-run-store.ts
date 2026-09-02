import fs from 'fs'
import path from 'path'
import type { RuntimeRunDescriptor, RuntimeRunStatus } from '../../shared/types/runtime-run'

const MAX_RUNS = 500
const ACTIVE = new Set<RuntimeRunStatus>(['queued', 'running', 'paused'])

interface RuntimeRunIndex {
  runs: Record<string, RuntimeRunDescriptor>
}

/** Durable recovery catalog for executions admitted by Agent OS. */
export class RuntimeRunStore {
  private readonly filePath: string
  private writeLock: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'runtime-runs.json')
  }

  async save(run: RuntimeRunDescriptor): Promise<RuntimeRunDescriptor> {
    return this.enqueue(() => {
      const index = this.read()
      const existing = index.runs[run.id]
      const next: RuntimeRunDescriptor = {
        ...existing,
        ...run,
        resourceKeys: [...new Set(run.resourceKeys.filter(Boolean))],
        updatedAt: Date.now(),
      }
      index.runs[next.id] = next
      this.write(index)
      return next
    })
  }

  async transition(id: string, status: RuntimeRunStatus, detail?: string): Promise<RuntimeRunDescriptor | null> {
    return this.enqueue(() => {
      const index = this.read()
      const existing = index.runs[id]
      if (!existing) return null
      const next: RuntimeRunDescriptor = { ...existing, status, updatedAt: Date.now(), detail: detail || existing.detail }
      index.runs[id] = next
      this.write(index)
      return next
    })
  }

  async listRecoverable(): Promise<RuntimeRunDescriptor[]> {
    return this.enqueue(() => Object.values(this.read().runs)
      .filter((run) => run.status === 'queued' && run.recoveryMode === 'auto-queued')
      .sort((left, right) => left.createdAt - right.createdAt))
  }

  async markActiveAsInterrupted(): Promise<void> {
    return this.enqueue(() => {
      const index = this.read()
      let changed = false
      for (const run of Object.values(index.runs)) {
        if (run.status === 'queued' || !ACTIVE.has(run.status)) continue
        run.status = 'interrupted'
        run.updatedAt = Date.now()
        run.detail = 'Eva was closed before this run finished. Resume from its saved checkpoint when available.'
        changed = true
      }
      if (changed) this.write(index)
    })
  }

  private read(): RuntimeRunIndex {
    try {
      if (!fs.existsSync(this.filePath)) return { runs: {} }
      const value = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Partial<RuntimeRunIndex>
      return { runs: value.runs && typeof value.runs === 'object' ? value.runs : {} }
    } catch (error) {
      this.backupCorruptFile(error)
      return { runs: {} }
    }
  }

  private write(index: RuntimeRunIndex): void {
    const runs = Object.values(index.runs)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_RUNS)
    index.runs = Object.fromEntries(runs.map((run) => [run.id, run]))
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(index, null, 2), 'utf-8')
  }

  private backupCorruptFile(error: unknown): void {
    console.error(`Could not read Agent OS runtime run state at ${this.filePath}:`, error)
    try {
      if (fs.existsSync(this.filePath)) fs.copyFileSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`)
    } catch (backupError) {
      console.error(`Could not back up the corrupt runtime run state at ${this.filePath}:`, backupError)
    }
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
