import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import type { AgentConfig } from '../../shared/types/agent'
import { BUILT_IN_AGENTS } from '../../shared/constants'
import { TOOL_CATALOG_VERSION } from '../../shared/tool-catalog'

export class AgentStore {
  private dataDir: string
  private filePath: string

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.filePath = path.join(dataDir, 'agents.json')
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private ensureDir(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true })
    }
  }

  private readAgents(): AgentConfig[] {
    try {
      if (!fs.existsSync(this.filePath)) return []
      const raw = fs.readFileSync(this.filePath, 'utf-8')
      return JSON.parse(raw) as AgentConfig[]
    } catch {
      return []
    }
  }

  private writeAgents(agents: AgentConfig[]): void {
    this.ensureDir()
    fs.writeFileSync(this.filePath, JSON.stringify(agents, null, 2), 'utf-8')
  }

  // ─── CRUD ──────────────────────────────────────────────────────────────────

  async listAgents(): Promise<AgentConfig[]> {
    return this.readAgents()
  }

  async getAgent(id: string): Promise<AgentConfig | null> {
    const agents = this.readAgents()
    return agents.find((a) => a.id === id) ?? null
  }

  async createAgent(
    config: Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<AgentConfig> {
    const agents = this.readAgents()
    const now = Date.now()
    const agent: AgentConfig = {
      ...config,
      id: uuidv4(),
      createdAt: now,
      updatedAt: now,
    }
    agents.push(agent)
    this.writeAgents(agents)
    return agent
  }

  async updateAgent(
    id: string,
    updates: Partial<Omit<AgentConfig, 'id' | 'createdAt'>>
  ): Promise<AgentConfig> {
    const agents = this.readAgents()
    const index = agents.findIndex((a) => a.id === id)
    if (index < 0) throw new Error(`Agent ${id} not found`)

    agents[index] = {
      ...agents[index],
      ...updates,
      updatedAt: Date.now(),
    }
    this.writeAgents(agents)
    return agents[index]
  }

  async deleteAgent(id: string): Promise<void> {
    const agents = this.readAgents()
    const target = agents.find((a) => a.id === id)
    if (!target) return
    if (target.isBuiltIn) throw new Error('Cannot delete built-in agent')

    const filtered = agents.filter((a) => a.id !== id)
    this.writeAgents(filtered)
  }

  // ─── Built-in Agents ───────────────────────────────────────────────────────

  async initializeBuiltInAgents(): Promise<void> {
    const existing = this.readAgents()
    const now = Date.now()
    const newAgents: AgentConfig[] = [...existing]

    for (const builtIn of BUILT_IN_AGENTS) {
      const existingBuiltIn = newAgents.find((agent) => agent.isBuiltIn && agent.name === builtIn.name)
      if (!existingBuiltIn) {
        newAgents.push({
          ...builtIn,
          id: uuidv4(),
          createdAt: now,
          updatedAt: now,
        })
      } else if (existingBuiltIn.systemPrompt !== builtIn.systemPrompt) {
        // Built-in agents are read-only in the UI, so keep their shipped safety
        // instructions current for users who already have a persisted config.
        existingBuiltIn.systemPrompt = builtIn.systemPrompt
        existingBuiltIn.updatedAt = now
      }

      if (existingBuiltIn && existingBuiltIn.toolCatalogVersion !== TOOL_CATALOG_VERSION) {
        existingBuiltIn.tools = [...new Set([...existingBuiltIn.tools, ...builtIn.tools])]
        existingBuiltIn.toolCatalogVersion = TOOL_CATALOG_VERSION
        existingBuiltIn.updatedAt = now
      }
    }

    this.writeAgents(newAgents)
  }

  // ─── Query ─────────────────────────────────────────────────────────────────

  async getAgentsByRole(role: string): Promise<AgentConfig[]> {
    const agents = this.readAgents()
    return agents.filter((a) => a.role === role)
  }
}
