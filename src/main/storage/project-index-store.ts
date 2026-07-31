import fs from 'fs'
import path from 'path'
import type { ProjectIndexSnapshot } from '../../shared/types/project-index'

interface ProjectIndexFile {
  snapshots: Record<string, ProjectIndexSnapshot>
}

/** Stores code-navigation metadata, never a duplicate of workspace file contents. */
export class ProjectIndexStore {
  private readonly filePath: string
  private writeLock: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'project-indexes.json')
  }

  async get(workspaceId: string): Promise<ProjectIndexSnapshot | null> {
    return this.enqueue(() => this.read().snapshots[workspaceId] || null)
  }

  async save(snapshot: ProjectIndexSnapshot): Promise<ProjectIndexSnapshot> {
    return this.enqueue(() => {
      const index = this.read()
      index.snapshots[snapshot.workspaceId] = snapshot
      this.write(index)
      return snapshot
    })
  }

  async delete(workspaceId: string): Promise<void> {
    return this.enqueue(() => {
      const index = this.read()
      if (!index.snapshots[workspaceId]) return
      delete index.snapshots[workspaceId]
      this.write(index)
    })
  }

  private read(): ProjectIndexFile {
    try {
      if (!fs.existsSync(this.filePath)) return { snapshots: {} }
      return JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as ProjectIndexFile
    } catch {
      return { snapshots: {} }
    }
  }

  private write(index: ProjectIndexFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(index), 'utf-8')
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
