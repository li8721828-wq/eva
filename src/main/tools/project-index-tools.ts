import type { ProjectIndexService } from '../services/project-index-service'
import type { ToolExecutor, ToolContext } from './index'
import type { ProjectIndexScope } from '../../shared/types/project-index'
import { getStorage } from '../storage'

export function createProjectIndexTools(projectIndexService: ProjectIndexService): ToolExecutor[] {
  return [projectSearchTool(projectIndexService), projectIndexStatusTool(projectIndexService)]
}

function projectSearchTool(projectIndexService: ProjectIndexService): ToolExecutor {
  return {
    definition: {
      name: 'project_search',
      description: 'Search persisted, source-derived project metadata. Returns candidate file paths and indexed symbols, imports, terms, API, data, or configuration entries. It does not read source bodies or infer conclusions.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Literal file path, symbol, class, function, import, term, or facet name to locate.' },
          maxResults: { type: 'number', description: 'Maximum results to return (default 12).' },
          scope: { type: 'string', enum: ['all', 'structure', 'business', 'api', 'data', 'configuration'], description: 'Metadata dimension to query (default all).' },
        },
        required: ['query'],
      },
    },
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
      if (!context.workspacePath) return 'Project navigation requires a project workspace.'
      const scope = toSearchScope(params.scope)
      const status = await projectIndexService.getStatusForWorkspacePath(context.workspacePath)
      if (!status) return 'This conversation is not assigned to a saved project workspace.'
      const multiDimensionalEnabled = await getMultiDimensionalIndexEnabled(context.conversationId)
      if (!multiDimensionalEnabled && !['all', 'structure'].includes(scope)) {
        return 'Multi-dimensional project navigation is disabled. Use structure scope or enable it from the Code view.'
      }
      const results = await projectIndexService.searchWorkspacePath(
        context.workspacePath,
        String(params.query || ''),
        Number(params.maxResults) || 12,
        multiDimensionalEnabled ? scope : 'structure'
      )
      if (!results.length) return `No indexed metadata matched "${String(params.query || '')}".`
      return results.map((result) => {
        const symbols = result.symbols.length
          ? `\n  Symbols: ${result.symbols.map((symbol) => `${symbol.kind} ${symbol.name}:${symbol.line}`).join(', ')}`
          : ''
        const dependencies = result.dependencies.length
          ? `\n  Imports: ${result.dependencies.map((dependency) => `${dependency.specifier}:${dependency.line}`).join(', ')}`
          : ''
        const facets = result.facets.length
          ? `\n  Navigation: ${result.facets.map((facet) => `${facet.kind} ${facet.name}${facet.detail ? ` (${facet.detail})` : ''}:${facet.line}`).join(', ')}`
          : ''
        const dimensions = result.matchedScopes.length ? ` [${result.matchedScopes.join(', ')}]` : ''
        return `${result.relativePath} (${result.language})${dimensions}${symbols}${dependencies}${facets}`
      }).join('\n\n')
    },
  }
}

function projectIndexStatusTool(projectIndexService: ProjectIndexService): ToolExecutor {
  return {
    definition: {
      name: 'project_index_status',
      description: 'Report coverage and synchronization details for the persisted project metadata index. Does not inspect source contents.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    async execute(_params: Record<string, unknown>, context: ToolContext): Promise<string> {
      if (!context.workspacePath) return 'Project navigation requires a project workspace.'
      const status = await projectIndexService.getStatusForWorkspacePath(context.workspacePath)
      if (!status) return 'This conversation is not assigned to a saved project workspace.'
      const dimensions = await getMultiDimensionalIndexEnabled(context.conversationId)
        ? `${status.indexedApiEndpoints} API clues, ${status.indexedDataEntities} data clues, ${status.indexedConfigKeys} configuration keys, and ${status.indexedBusinessTerms} business terms`
        : 'multi-dimensional navigation disabled'
      return `Project index: ${status.indexedFiles} files, ${status.indexedSymbols} symbols, ${status.indexedDependencies} import links, ${dimensions}. ${status.watching ? 'Watching for changes' : 'Not watching'}, last synchronized ${status.indexedAt ? new Date(status.indexedAt).toLocaleString() : 'never'}.`
    },
  }
}

async function getMultiDimensionalIndexEnabled(conversationId?: string): Promise<boolean> {
  if (!conversationId) return true
  const conversation = await getStorage().conversations.getConversation(conversationId)
  return conversation?.multiDimensionalIndexEnabled !== false
}

function toSearchScope(value: unknown): ProjectIndexScope {
  const scopes: ProjectIndexScope[] = ['all', 'structure', 'business', 'api', 'data', 'configuration']
  return typeof value === 'string' && scopes.includes(value as ProjectIndexScope)
    ? value as ProjectIndexScope
    : 'all'
}
