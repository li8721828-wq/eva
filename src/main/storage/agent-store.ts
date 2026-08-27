import fs from 'fs'
import fsPromises from 'fs/promises'
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
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed) ? parsed.map((value) => normalizeAgent(value)) : []
    } catch {
      return []
    }
  }

  private async writeAgents(agents: AgentConfig[]): Promise<void> {
    this.ensureDir()
    const tmpPath = this.filePath + '.tmp'
    const data = JSON.stringify(agents, null, 2)
    await fsPromises.writeFile(tmpPath, data, 'utf-8')
    await fsPromises.rename(tmpPath, this.filePath)
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
    await this.writeAgents(agents)
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
    await this.writeAgents(agents)
    return agents[index]
  }

  async deleteAgent(id: string): Promise<void> {
    const agents = this.readAgents()
    const target = agents.find((a) => a.id === id)
    if (!target) return
    if (target.isBuiltIn) throw new Error('Cannot delete built-in agent')

    const filtered = agents.filter((a) => a.id !== id)
    await this.writeAgents(filtered)
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
      } else if (!existingBuiltIn.systemPromptCustomized && existingBuiltIn.systemPrompt !== builtIn.systemPrompt) {
        // Built-in agents are read-only in the UI, so keep their shipped safety
        // instructions current for users who already have a persisted config.
        existingBuiltIn.systemPrompt = builtIn.systemPrompt
        existingBuiltIn.updatedAt = now
      }

      if (existingBuiltIn && existingBuiltIn.maxIterations !== builtIn.maxIterations) {
        existingBuiltIn.maxIterations = builtIn.maxIterations
        existingBuiltIn.updatedAt = now
      }

      if (existingBuiltIn && existingBuiltIn.toolCatalogVersion !== TOOL_CATALOG_VERSION) {
        existingBuiltIn.tools = [...new Set([...existingBuiltIn.tools, ...builtIn.tools])]
        existingBuiltIn.toolCatalogVersion = TOOL_CATALOG_VERSION
        existingBuiltIn.updatedAt = now
      }
    }

    await this.writeAgents(newAgents)
  }

  // ─── Query ─────────────────────────────────────────────────────────────────

  async getAgentsByRole(role: string): Promise<AgentConfig[]> {
    const agents = this.readAgents()
    return agents.filter((a) => a.role === role)
  }
}

/** Backfill fields introduced after older Agent configurations were persisted. */
function normalizeAgent(value: unknown): AgentConfig {
  const raw = value && typeof value === 'object' ? value as Partial<AgentConfig> : {}
  return {
    id: typeof raw.id === 'string' ? raw.id : uuidv4(),
    name: typeof raw.name === 'string' ? raw.name : 'Unnamed Agent',
    description: typeof raw.description === 'string' ? raw.description : '',
    role: raw.role || 'custom',
    systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt : '',
    systemPromptCustomized: Boolean(raw.systemPromptCustomized),
    platformPromptTemplate: typeof raw.platformPromptTemplate === 'string' ? raw.platformPromptTemplate : undefined,
    outputFormat: raw.outputFormat || 'default',
    outputFormatInstructions: typeof raw.outputFormatInstructions === 'string' ? raw.outputFormatInstructions : '',
    outputStyle: raw.outputStyle || 'balanced',
    outputFont: raw.outputFont || 'system',
    outputColor: raw.outputColor || 'slate',
    outputFontSize: raw.outputFontSize || 'medium',
    outputTextEffect: raw.outputTextEffect || 'none',
    markdownRenderer: raw.markdownRenderer === 'classic' || raw.markdownRenderer === 'streamdown' ? raw.markdownRenderer : 'enhanced',
    processOutput: raw.processOutput === 'off' || raw.processOutput === 'compact' || raw.processOutput === 'detailed'
      ? raw.processOutput
      : raw.showThinking ? 'detailed' : 'compact',
    showThinking: raw.processOutput === 'detailed' || (!raw.processOutput && Boolean(raw.showThinking)),
    model: typeof raw.model === 'string' ? raw.model : 'gpt-4o',
    providerId: typeof raw.providerId === 'string' ? raw.providerId : 'openai',
    modelCandidates: Array.isArray(raw.modelCandidates) ? raw.modelCandidates : [],
    modelPreference: raw.modelPreference,
    modelPoolIds: Array.isArray(raw.modelPoolIds) ? raw.modelPoolIds : [],
    tools: Array.isArray(raw.tools) ? raw.tools.filter((tool): tool is string => typeof tool === 'string') : [],
    toolCatalogVersion: raw.toolCatalogVersion,
    maxIterations: typeof raw.maxIterations === 'number' && raw.maxIterations > 0 ? raw.maxIterations : 100,
    temperature: typeof raw.temperature === 'number' ? raw.temperature : 0.7,
    isBuiltIn: Boolean(raw.isBuiltIn),
    taskScoped: Boolean(raw.taskScoped),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  }
}
