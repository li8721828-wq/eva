import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { CallToolResult, Transport } from '@modelcontextprotocol/client'
import type { McpServerConfig, McpServerState } from '../../shared/types/mcp'
import type { ToolDefinition } from '../../shared/types/provider'
import type { ToolExecutor, ToolRegistry } from '../tools'
import type { McpServerStore } from '../storage/mcp-server-store'

interface ActiveConnection {
  config: McpServerConfig
  client: Client
  transport: Transport
  toolNames: string[]
}

export function mcpToolName(serverId: string, toolName: string): string {
  const normalize = (value: string) => value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'tool'
  return `mcp__${normalize(serverId)}__${normalize(toolName)}`
}

export class McpClientManager {
  private readonly connections = new Map<string, ActiveConnection>()
  private readonly states = new Map<string, McpServerState>()
  private registry?: ToolRegistry

  constructor(private readonly store: McpServerStore) {}

  async start(registry: ToolRegistry): Promise<void> {
    this.registry = registry
    await this.reconcile()
  }

  async reconcile(): Promise<McpServerState[]> {
    const configs = this.store.list()
    const knownIds = new Set(configs.map((config) => config.id))
    for (const [id, connection] of this.connections) {
      const nextConfig = configs.find((config) => config.id === id)
      if (!nextConfig || !nextConfig.enabled || JSON.stringify(nextConfig) !== JSON.stringify(connection.config)) {
        await this.disconnect(id, connection)
      }
    }
    await Promise.all(configs.map(async (config) => {
      if (!config.enabled) {
        this.states.set(config.id, { ...config, status: 'disabled', toolCount: 0, tools: [] })
        return
      }
      if (!this.connections.has(config.id)) await this.connect(config)
    }))
    return this.listStates()
  }

  listStates(): McpServerState[] {
    return this.store.list().map((config) => this.states.get(config.id) || { ...config, status: config.enabled ? 'error' : 'disabled', toolCount: 0, tools: [], error: config.enabled ? 'Not connected.' : undefined })
  }

  async reconnect(id?: string): Promise<McpServerState[]> {
    if (id) {
      const connection = this.connections.get(id)
      if (connection) await this.disconnect(id, connection)
      const config = this.store.get(id)
      if (config?.enabled) await this.connect(config)
    } else {
      for (const [connectionId, connection] of this.connections) await this.disconnect(connectionId, connection)
      await this.reconcile()
    }
    return this.listStates()
  }

  async dispose(): Promise<void> {
    for (const [id, connection] of this.connections) await this.disconnect(id, connection)
    this.connections.clear()
  }

  private async connect(config: McpServerConfig): Promise<void> {
    this.states.set(config.id, { ...config, status: 'connecting', toolCount: 0, tools: [] })
    try {
      const transport = this.createTransport(config)
      const client = new Client({ name: 'Eva', version: '0.1.134' })
      await client.connect(transport)
      const listed = await client.listTools()
      const allowed = config.toolAllowlist?.length ? new Set(config.toolAllowlist) : undefined
      const tools = listed.tools.filter((tool) => !allowed || allowed.has(tool.name))
      const toolNames = tools.map((tool) => mcpToolName(config.id, tool.name))
      const connection: ActiveConnection = { config, client, transport, toolNames }
      this.connections.set(config.id, connection)
      for (const tool of tools) this.registry?.register(this.wrapTool(config, client, tool))
      this.states.set(config.id, { ...config, status: 'connected', toolCount: tools.length, tools: toolNames, connectedAt: new Date().toISOString() })
    } catch (error) {
      this.states.set(config.id, { ...config, status: 'error', toolCount: 0, tools: [], error: error instanceof Error ? error.message : String(error) })
    }
  }

  private createTransport(config: McpServerConfig): Transport {
    if (config.transport === 'stdio') {
      return new StdioClientTransport({ command: config.command!, args: config.args, cwd: config.cwd, env: config.env })
    }
    const headers = config.headers && Object.keys(config.headers).length ? { requestInit: { headers: config.headers } } : undefined
    return new StreamableHTTPClientTransport(new URL(config.url!), headers)
  }

  private wrapTool(config: McpServerConfig, client: Client, tool: { name: string; description?: string; inputSchema?: unknown }): ToolExecutor {
    const definition: ToolDefinition = {
      name: mcpToolName(config.id, tool.name),
      description: `[MCP ${config.name}] ${tool.description || `Invoke ${tool.name}.`}`,
      parameters: (tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} }) as Record<string, unknown>,
    }
    return {
      definition,
      execute: async (params) => this.formatResult(await client.callTool({ name: tool.name, arguments: params })),
    }
  }

  private formatResult(result: CallToolResult): string {
    const text = result.content.map((item) => {
      if (item.type === 'text') return item.text
      if (item.type === 'resource') return JSON.stringify(item.resource)
      return JSON.stringify(item)
    }).filter(Boolean).join('\n')
    const structured = result.structuredContent ? `\n${JSON.stringify(result.structuredContent)}` : ''
    return `${result.isError ? 'MCP tool error: ' : ''}${text || structured || '(MCP tool returned no content)'}`
  }

  private async disconnect(id: string, connection: ActiveConnection): Promise<void> {
    this.registry?.unregisterByPrefix(`mcp__${id.replace(/[^a-zA-Z0-9_-]+/g, '_')}__`)
    this.connections.delete(id)
    try { await connection.client.close() } catch { /* connection may already be closed */ }
    this.states.delete(id)
  }
}
