import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { AgentConfig } from '../../shared/types/agent'
import type { AgentTokenEstimate } from '../../shared/types/agent-token-estimate'
import { getStorage } from '../storage'
import { recordActivity } from '../services/activity-log'
import type { ToolRegistry } from '../tools'
import { ContextManager } from '../agent-engine/context'
import { TOOL_CATALOG } from '../../shared/tool-catalog'
import { buildSharedEnvironmentPrompt, normalizeEnvironmentRules } from '../services/environment-profile-service'

function estimateStaticAgentTokens(agent: AgentConfig, toolRegistry?: ToolRegistry): AgentTokenEstimate {
  const definitions = toolRegistry?.getDefinitionsByNames(agent.tools) || []
  const contextManager = new ContextManager()
  const workspacePath = '(workspace selected by the conversation)'
  const defaultConfiguredAgent: AgentConfig = {
    ...agent,
    systemPrompt: '',
    providerId: '',
    model: '',
    modelCandidates: [],
    outputFormat: 'default',
    outputFormatInstructions: '',
  }
  const genericPrompt = contextManager.buildSystemPrompt(defaultConfiguredAgent, workspacePath, undefined, false, [])
  const promptWithoutTools = contextManager.buildSystemPrompt(agent, workspacePath, undefined, false, [])
  const fullPrompt = contextManager.buildSystemPrompt(agent, workspacePath, undefined, false, definitions)
  const sharedEnvironmentPrompt = buildSharedEnvironmentPrompt(normalizeEnvironmentRules(getStorage().config.get('environmentRules')))
  const systemPromptTokens = contextManager.estimateTokens(`${agent.systemPrompt || ''}\n${sharedEnvironmentPrompt}`)
  const genericRuleTokens = contextManager.estimateTokens(genericPrompt)
  const basePromptTokens = contextManager.estimateTokens(promptWithoutTools)
  const fullPromptTokens = contextManager.estimateTokens(fullPrompt)
  const toolInstructionTokens = Math.max(0, fullPromptTokens - basePromptTokens)
  const toolSchemaTokens = contextManager.estimateTokens(JSON.stringify(definitions))
  // genericPrompt already contains the shared environment rules. Subtract the
  // agent-only prompt here so the shared segment is counted exactly once under
  // system_prompt rather than being removed a second time from agent context.
  const agentOnlyPromptTokens = contextManager.estimateTokens(agent.systemPrompt || '')
  const agentContextTokens = Math.max(0, basePromptTokens - agentOnlyPromptTokens - genericRuleTokens)
  const evaRuleTokens = Math.max(0, basePromptTokens - systemPromptTokens - agentContextTokens)

  return {
    totalTokens: fullPromptTokens + toolSchemaTokens,
    evaRulesPreview: genericPrompt,
    sharedEnvironmentPrompt,
    toolInstructionsPreview: definitions.map((definition) => `- ${definition.name}: ${definition.description}`).join('\n'),
    parts: [
      { kind: 'system_prompt', tokens: systemPromptTokens },
      { kind: 'eva_rules', tokens: evaRuleTokens },
      { kind: 'agent_context', tokens: agentContextTokens },
      { kind: 'tool_instructions', tokens: toolInstructionTokens },
      { kind: 'tool_schema', tokens: toolSchemaTokens },
    ],
    tools: definitions.map((definition) => ({
      id: definition.name,
      label: TOOL_CATALOG.find((tool) => tool.id === definition.name)?.label || definition.name,
      tokens: contextManager.estimateTokens(JSON.stringify(definition)),
      schema: JSON.stringify(definition, null, 2),
    })).sort((left, right) => right.tokens - left.tokens),
  }
}

export function registerAgentHandlers(toolRegistry?: ToolRegistry): void {
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

  ipcMain.handle(IPC.AGENT_TOKEN_ESTIMATE, async (_event, id: string): Promise<AgentTokenEstimate> => {
    const agent = await getStorage().agents.getAgent(id)
    if (!agent) throw new Error(`Agent ${id} not found`)
    return estimateStaticAgentTokens(agent, toolRegistry)
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
    if (getStorage().config.get('primaryChatAgentId') === id) {
      const fallbackAgent = (await getStorage().agents.listAgents())[0]
      getStorage().config.set('primaryChatAgentId', fallbackAgent?.id || null)
    }
    if (agent) void recordActivity({ category: 'system', action: 'agent.deleted', status: 'info', summary: `Deleted Agent "${agent.name}".` })
  })
}
