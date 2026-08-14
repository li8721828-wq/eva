import { diagnoseRuntime, type RuntimeDiagnosticFocus } from '../services/runtime-diagnostics'
import { createRuntimeInspectionSource, type RuntimeInspectionSource } from './runtime-inspection-tools'
import type { ToolContext, ToolExecutor, ToolRegistry } from './index'

const FOCUSES: RuntimeDiagnosticFocus[] = ['all', 'errors', 'permissions', 'routing']

export function createRuntimeDiagnosticTools(registry: ToolRegistry, source: RuntimeInspectionSource = createRuntimeInspectionSource(registry)): ToolExecutor[] {
  return [{
    definition: {
      name: 'diagnose_runtime',
      description: 'Analyze a redacted Eva runtime snapshot and return evidence-backed findings about recent errors, tool grants, plugins, model routes, and Agent pool references. This tool is strictly read-only and never changes configuration or code.',
      parameters: {
        type: 'object',
        properties: {
          focus: { type: 'string', enum: FOCUSES, description: 'Diagnostic area. Defaults to all.' },
        },
      },
    },
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
      const focus = typeof params.focus === 'string' ? params.focus as RuntimeDiagnosticFocus : 'all'
      if (!FOCUSES.includes(focus)) return `Unknown diagnostic focus "${String(params.focus)}". Use: ${FOCUSES.join(', ')}.`
      const [agents, plugins, providers, modelPools, tools, activity] = await Promise.all([
        source.listAgents(), Promise.resolve(source.listPlugins()), Promise.resolve(source.listProviders()), Promise.resolve(source.listModelPools()), Promise.resolve(source.listTools()),
        context.conversationId ? source.listActivity(context.conversationId, 100) : Promise.resolve([]),
      ])
      return JSON.stringify(diagnoseRuntime({ agents, plugins, providers, modelPools, tools, activity }, focus), null, 2)
    },
  }]
}
