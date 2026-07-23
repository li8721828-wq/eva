import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { AgentConfig } from '../../shared/types/agent'
import { getStorage } from '../storage'

export function registerAgentHandlers(): void {
  ipcMain.handle(IPC.AGENT_LIST, async (): Promise<AgentConfig[]> => {
    return getStorage().agents.listAgents()
  })

  ipcMain.handle(IPC.AGENT_GET, async (_event, id: string): Promise<AgentConfig> => {
    const agent = await getStorage().agents.getAgent(id)
    if (!agent) {
      throw new Error(`Agent ${id} not found`)
    }
    return agent
  })

  ipcMain.handle(
    IPC.AGENT_CREATE,
    async (_event, data: Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>): Promise<AgentConfig> => {
      return getStorage().agents.createAgent({
        name: data.name || 'New Agent',
        description: data.description || '',
        role: data.role || 'custom',
        systemPrompt: data.systemPrompt || '',
        model: data.model || 'gpt-4o',
        providerId: data.providerId || 'openai',
        tools: data.tools || [],
        maxIterations: data.maxIterations || 20,
        temperature: data.temperature ?? 0.7,
        isBuiltIn: false,
      })
    }
  )

  ipcMain.handle(
    IPC.AGENT_UPDATE,
    async (_event, id: string, data: Partial<AgentConfig>): Promise<AgentConfig> => {
      return getStorage().agents.updateAgent(id, data)
    }
  )

  ipcMain.handle(IPC.AGENT_DELETE, async (_event, id: string): Promise<void> => {
    await getStorage().agents.deleteAgent(id)
  })
}
