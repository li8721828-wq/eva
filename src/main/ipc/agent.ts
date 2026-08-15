import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { AgentConfig } from '../../shared/types/agent'
import { getStorage } from '../storage'
import { recordActivity } from '../services/activity-log'

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
      const agent = await getStorage().agents.createAgent({
        name: data.name || 'New Agent',
        description: data.description || '',
        role: data.role || 'custom',
        systemPrompt: data.systemPrompt || '',
        outputFormat: data.outputFormat || 'default',
        outputFormatInstructions: data.outputFormat === 'custom' ? data.outputFormatInstructions?.trim() || '' : '',
        outputStyle: data.outputStyle || 'balanced',
        outputFont: data.outputFont || 'system',
        outputColor: data.outputColor || 'slate',
        outputFontSize: data.outputFontSize || 'medium',
        outputTextEffect: data.outputTextEffect || 'none',
        markdownRenderer: data.markdownRenderer === 'classic' || data.markdownRenderer === 'streamdown' ? data.markdownRenderer : 'enhanced',
        showThinking: Boolean(data.showThinking),
        model: data.model || 'gpt-4o',
        providerId: data.providerId || 'openai',
        modelCandidates: data.modelCandidates || [],
        tools: data.tools || [],
        maxIterations: data.maxIterations || 100,
        temperature: data.temperature ?? 0.7,
        isBuiltIn: false,
      })
      void recordActivity({ category: 'system', action: 'agent.created', status: 'success', summary: `Created Agent "${agent.name}".` })
      return agent
    }
  )

  ipcMain.handle(
    IPC.AGENT_UPDATE,
    async (_event, id: string, data: Partial<AgentConfig>): Promise<AgentConfig> => {
      const agent = await getStorage().agents.updateAgent(id, data)
      void recordActivity({ category: 'system', action: 'agent.updated', status: 'success', summary: `Updated Agent "${agent.name}".` })
      return agent
    }
  )

  ipcMain.handle(IPC.AGENT_DELETE, async (_event, id: string): Promise<void> => {
    const agent = await getStorage().agents.getAgent(id)
    await getStorage().agents.deleteAgent(id)
    if (agent) void recordActivity({ category: 'system', action: 'agent.deleted', status: 'info', summary: `Deleted Agent "${agent.name}".` })
  })
}
