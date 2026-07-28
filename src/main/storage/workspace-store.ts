import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import type { Workspace } from '../../shared/types/workspace'

export class WorkspaceStore {
  private readonly filePath: string

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'workspaces.json')
  }

  private read(): Workspace[] {
    try {
      if (!fs.existsSync(this.filePath)) return []
      return JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Workspace[]
    } catch {
      return []
    }
  }

  private write(workspaces: Workspace[]): void {
    fs.writeFileSync(this.filePath, JSON.stringify(workspaces, null, 2), 'utf-8')
  }

  async list(): Promise<Workspace[]> {
    return this.read().sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async get(id: string): Promise<Workspace | null> {
    return this.read().find((workspace) => workspace.id === id) || null
  }

  async create(pathValue: string, name?: string): Promise<Workspace> {
    const workspaces = this.read()
    const normalizedPath = path.resolve(pathValue)
    const existing = workspaces.find((workspace) => path.resolve(workspace.path) === normalizedPath)
    if (existing) return existing

    const now = Date.now()
    const workspace: Workspace = {
      id: uuidv4(),
      name: name?.trim() || path.basename(normalizedPath) || normalizedPath,
      path: normalizedPath,
      createdAt: now,
      updatedAt: now,
    }
    workspaces.push(workspace)
    this.write(workspaces)
    return workspace
  }

  async update(
    id: string,
    updates: Partial<Pick<Workspace, 'name'>>
  ): Promise<Workspace> {
    const workspaces = this.read()
    const index = workspaces.findIndex((workspace) => workspace.id === id)
    if (index < 0) throw new Error(`Workspace ${id} not found`)
    workspaces[index] = { ...workspaces[index], ...updates, updatedAt: Date.now() }
    this.write(workspaces)
    return workspaces[index]
  }

  async delete(id: string): Promise<void> {
    this.write(this.read().filter((workspace) => workspace.id !== id))
  }
}
