import type { AgentConfig } from '../../shared/types/agent'
import type { ActivityLogEntry } from '../../shared/types/activity'
import type { ModelPool } from '../../shared/types/model-pool'
import type { InstalledPlugin } from '../../shared/types/plugin'
import type { ProviderConfigEntry, ToolDefinition } from '../../shared/types/provider'
import { getStorage } from '../storage'
import type { ToolContext, ToolExecutor, ToolRegistry } from './index'

type InspectionScope = 'overview' | 'agents' | 'tools' | 'plugins' | 'models' | 'activity' | 'all'

export interface RuntimeInspectionSource {
  listAgents(): Promise<AgentConfig[]>
  listPlugins(): InstalledPlugin[]
  listProviders(): ProviderConfigEntry[]
  listModelPools(): ModelPool[]
  listTools(): ToolDefinition[]
  listActivity(conversationId: string, limit: number): Promise<ActivityLogEntry[]>
}

const SCOPES: InspectionScope[] = ['overview', 'agents', 'tools', 'plugins', 'models', 'activity', 'all']

export function createRuntimeInspectionTools(registry: ToolRegistry, source: RuntimeInspectionSource = createRuntimeInspectionSource(registry)): ToolExecutor[] {
  return [{
    definition: {
      name: 'inspect_runtime',
      description: 'Read a redacted Eva runtime snapshot. It reports configured Agents, registered tools, plugins, model routes, and recent activity for this conversation. It never returns API keys, plugin secrets, system prompts, conversation messages, file contents, or credentials.',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: SCOPES, description: 'Which runtime area to inspect. Defaults to overview.' },
          activityLimit: { type: 'number', minimum: 1, maximum: 50, description: 'Maximum recent activity records when scope is activity or all. Defaults to 20.' },
        },
      },
    },
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
      const requestedScope = typeof params.scope === 'string' ? params.scope : 'overview'
      if (!SCOPES.includes(requestedScope as InspectionScope)) {
        return `Unknown inspection scope "${requestedScope}". Use: ${SCOPES.join(', ')}.`
      }
      const requestedLimit = typeof params.activityLimit === 'number' ? params.activityLimit : 20
      const activityLimit = Math.min(Math.max(Math.floor(requestedLimit), 1), 50)
      const snapshot = await buildRuntimeSnapshot(source, requestedScope as InspectionScope, context.conversationId, activityLimit)
      return JSON.stringify(snapshot, null, 2)
    },
  }]
}

export async function buildRuntimeSnapshot(source: RuntimeInspectionSource, scope: InspectionScope, conversationId?: string, activityLimit = 20): Promise<Record<string, unknown>> {
  const includes = (section: Exclude<InspectionScope, 'overview' | 'all'>) => scope === 'all' || scope === section
  const [agents, plugins, providers, pools, tools] = await Promise.all([
    source.listAgents(),
    Promise.resolve(source.listPlugins()),
    Promise.resolve(source.listProviders()),
    Promise.resolve(source.listModelPools()),
    Promise.resolve(source.listTools()),
  ])

  const enabledPlugins = plugins.filter((plugin) => plugin.enabled)
  const enabledRoutes = pools.flatMap((pool) => pool.entries.filter((entry) => entry.enabled))
  const snapshot: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    scope,
    redaction: 'Secrets, API keys, system prompts, conversation content, file content, and plugin settings are excluded.',
    overview: {
      agents: agents.length,
      enabledPlugins: enabledPlugins.length,
      registeredTools: tools.length,
      configuredProviders: providers.length,
      enabledProviders: providers.filter((provider) => provider.isEnabled).length,
      modelPools: pools.length,
      enabledModelRoutes: enabledRoutes.length,
    },
  }

  if (includes('agents')) {
    snapshot.agents = agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      builtIn: agent.isBuiltIn,
      taskScoped: Boolean(agent.taskScoped),
      model: { providerId: agent.providerId, model: agent.model, candidates: agent.modelCandidates?.length || 0, pools: agent.modelPoolIds?.length || 0 },
      tools: [...agent.tools],
      limits: { maxIterations: agent.maxIterations, temperature: agent.temperature },
    }))
  }

  if (includes('tools')) {
    snapshot.tools = tools.map((tool) => ({ name: tool.name, description: tool.description }))
  }

  if (includes('plugins')) {
    snapshot.plugins = plugins.map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      enabled: plugin.enabled,
      category: plugin.category,
      permissions: [...plugin.permissions],
      source: plugin.source,
    }))
  }

  if (includes('models')) {
    snapshot.providers = providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      type: provider.type,
      enabled: provider.isEnabled,
      apiKeyConfigured: Boolean(provider.apiKey),
      models: (provider.models || []).map((model) => model.id),
      defaultModel: provider.defaultModel || null,
    }))
    snapshot.modelPools = pools.map((pool) => ({
      id: pool.id,
      name: pool.name,
      routes: pool.entries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        providerId: entry.providerId,
        model: entry.model,
        capabilities: entry.capabilities,
        priority: entry.priority,
        enabled: entry.enabled,
      })),
    }))
  }

  if (includes('activity')) {
    snapshot.activity = conversationId
      ? (await source.listActivity(conversationId, activityLimit)).map((entry) => ({
        timestamp: entry.timestamp,
        category: entry.category,
        action: entry.action,
        status: entry.status,
        summary: entry.summary,
      }))
      : []
    snapshot.activityNote = conversationId
      ? 'Activity is limited to the current conversation.'
      : 'No conversation scope is available, so no activity records were returned.'
  }

  return snapshot
}

export function createRuntimeInspectionSource(registry: ToolRegistry): RuntimeInspectionSource {
  return {
    listAgents: () => getStorage().agents.listAgents(),
    listPlugins: () => getStorage().plugins.list(),
    listProviders: () => getStorage().config.getProviders(),
    listModelPools: () => getStorage().config.get('modelPools'),
    listTools: () => registry.getDefinitions(),
    listActivity: (conversationId, limit) => getStorage().activity.list({ conversationId, limit }),
  }
}
