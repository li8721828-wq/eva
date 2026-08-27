import type { AgentConfig } from '../../shared/types/agent'
import type { ActivityLogEntry } from '../../shared/types/activity'
import type { ModelPool } from '../../shared/types/model-pool'
import type { InstalledPlugin } from '../../shared/types/plugin'
import type { ProviderConfigEntry, ToolDefinition } from '../../shared/types/provider'

export type RuntimeDiagnosticFocus = 'all' | 'errors' | 'permissions' | 'routing'
export type RuntimeFindingSeverity = 'info' | 'warning' | 'error'

export interface RuntimeFinding {
  id: string
  severity: RuntimeFindingSeverity
  title: string
  evidence: string[]
  impact: string
  recommendation: string
}

export interface RuntimeDiagnosticInput {
  agents: AgentConfig[]
  tools: ToolDefinition[]
  plugins: InstalledPlugin[]
  providers: ProviderConfigEntry[]
  modelPools: ModelPool[]
  activity: ActivityLogEntry[]
}

export interface RuntimeDiagnosticReport {
  generatedAt: string
  focus: RuntimeDiagnosticFocus
  status: 'healthy' | 'attention'
  summary: string
  findings: RuntimeFinding[]
  constraints: string[]
}

export function diagnoseRuntime(input: RuntimeDiagnosticInput, focus: RuntimeDiagnosticFocus = 'all'): RuntimeDiagnosticReport {
  const findings: RuntimeFinding[] = []
  const include = (area: Exclude<RuntimeDiagnosticFocus, 'all'>) => focus === 'all' || focus === area

  if (include('errors')) {
    const errors = input.activity.filter((entry) => entry.status === 'error')
    if (errors.length) {
      const byAction = errors.reduce<Record<string, number>>((counts, entry) => ({ ...counts, [entry.action]: (counts[entry.action] || 0) + 1 }), {})
      findings.push({
        id: 'recent-runtime-errors', severity: 'error', title: 'Recent runtime errors need investigation',
        evidence: Object.entries(byAction).sort(([, left], [, right]) => right - left).slice(0, 5).map(([action, count]) => `${action}: ${count} error event${count === 1 ? '' : 's'}`),
        impact: 'Affected tasks may stop early or return incomplete results.',
        recommendation: 'Inspect the newest matching activity records, then reproduce the failure in an isolated task before changing configuration or code.',
      })
    }
  }

  if (include('routing')) {
    const enabledProviders = new Set(input.providers.filter((provider) => provider.isEnabled).map((provider) => provider.id))
    const configuredProviders = new Set(input.providers.map((provider) => provider.id))
    const poolsById = new Set(input.modelPools.map((pool) => pool.id))
    const routes = input.modelPools.flatMap((pool) => pool.entries)
    const unavailableRoutes = routes.filter((route) => route.enabled && !configuredProviders.has(route.providerId))
    const hiddenRoutes = routes.filter((route) => route.enabled && configuredProviders.has(route.providerId) && !enabledProviders.has(route.providerId))
    const missingAgentPools = input.agents.flatMap((agent) => (agent.modelPoolIds || []).filter((poolId) => !poolsById.has(poolId)).map((poolId) => `${agent.name}: ${poolId}`))

    if (unavailableRoutes.length) findings.push({
      id: 'missing-route-provider', severity: 'error', title: 'Enabled model routes reference missing providers',
      evidence: unavailableRoutes.map((route) => `${route.name} -> ${route.providerId} / ${route.model}`),
      impact: 'Delegated model-pool calls on these routes will fail.',
      recommendation: 'Restore the referenced connection or disable/remove the stale route, then test a bounded delegation.',
    })
    if (hiddenRoutes.length) findings.push({
      id: 'hidden-route-provider', severity: 'warning', title: 'Enabled model routes use connections hidden from the chat picker',
      evidence: hiddenRoutes.map((route) => `${route.name} -> ${route.providerId} / ${route.model}`),
      impact: 'The route remains usable by Agents, but its availability is less visible to operators.',
      recommendation: 'Keep this only when intentional; otherwise expose the connection in the chat picker or document the routing policy.',
    })
    if (missingAgentPools.length) findings.push({
      id: 'missing-agent-model-pool', severity: 'error', title: 'Agents reference unavailable model pools',
      evidence: missingAgentPools,
      impact: 'The affected Agents cannot delegate through their configured model pools.',
      recommendation: 'Assign an existing pool or remove the stale pool reference from the affected Agent.',
    })
    if (input.providers.length > 0 && routes.length === 0) findings.push({
      id: 'no-model-pool-routes', severity: 'info', title: 'No model-pool routes are configured',
      evidence: [`${input.providers.length} model connection${input.providers.length === 1 ? '' : 's'} configured; 0 model-pool routes.`],
      impact: 'Agents can use their primary models but cannot delegate capability-specific subtasks through model pools.',
      recommendation: 'Configure a model pool only if cross-model delegation is needed.',
    })
  }

  if (include('permissions')) {
    const registered = new Set(input.tools.map((tool) => tool.name))
    const staleAgentTools = input.agents.flatMap((agent) => agent.tools.filter((tool) => !registered.has(tool)).map((tool) => `${agent.name}: ${tool}`))
    const privilegedPlugins = input.plugins.filter((plugin) => plugin.enabled && plugin.permissions.some((permission) => permission === 'network' || permission === 'filesystem-read' || permission === 'filesystem-write' || permission === 'terminal'))
    if (staleAgentTools.length) findings.push({
      id: 'stale-agent-tools', severity: 'error', title: 'Agents reference tools that are not registered',
      evidence: staleAgentTools,
      impact: 'A model may attempt a permitted tool call that fails at runtime.',
      recommendation: 'Update the Agent tool grants or restore the missing tool registration.',
    })
    if (privilegedPlugins.length) findings.push({
      id: 'privileged-plugin-review', severity: 'warning', title: 'Enabled plugins have elevated permissions',
      evidence: privilegedPlugins.map((plugin) => `${plugin.name}: ${plugin.permissions.filter((permission) => permission === 'network' || permission === 'filesystem-read' || permission === 'filesystem-write' || permission === 'terminal').join(', ')}`),
      impact: 'These plugins can access resources beyond ordinary UI configuration.',
      recommendation: 'Review each plugin source and keep only permissions required for its active workflow.',
    })
  }

  const status = findings.some((finding) => finding.severity === 'error') ? 'attention' : 'healthy'
  return {
    generatedAt: new Date().toISOString(), focus, status,
    summary: findings.length ? `${findings.length} runtime finding${findings.length === 1 ? '' : 's'} detected.` : 'No diagnostic findings were detected in the available runtime snapshot.',
    findings,
    constraints: ['Read-only diagnosis: no configuration, code, plugin, or model route was changed.', 'Activity evidence is limited to the current conversation when one is available.', 'Findings are recommendations, not proof of root cause; validate in an isolated task before applying changes.'],
  }
}
