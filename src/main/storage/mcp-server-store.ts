import Store from 'electron-store'
import type { McpServerConfig } from '../../shared/types/mcp'

interface McpServerStoreSchema {
  servers: McpServerConfig[]
}

const defaults: McpServerStoreSchema = { servers: [] }

export class McpServerStore {
  private readonly store = new Store<McpServerStoreSchema>({ name: 'mcp-servers', defaults })

  list(): McpServerConfig[] {
    return this.store.get('servers').map((server) => ({ ...server }))
  }

  get(id: string): McpServerConfig | undefined {
    const server = this.store.get('servers').find((entry) => entry.id === id)
    return server ? { ...server } : undefined
  }

  upsert(input: McpServerConfig): McpServerConfig {
    const server = normalizeMcpServer(input)
    const servers = this.store.get('servers')
    const index = servers.findIndex((entry) => entry.id === server.id)
    if (index >= 0) servers[index] = server
    else servers.push(server)
    this.store.set('servers', servers)
    return { ...server }
  }

  remove(id: string): void {
    this.store.set('servers', this.store.get('servers').filter((server) => server.id !== id))
  }

  setEnabled(id: string, enabled: boolean): McpServerConfig {
    const server = this.get(id)
    if (!server) throw new Error('MCP server was not found.')
    return this.upsert({ ...server, enabled })
  }
}

export function normalizeMcpServer(input: McpServerConfig): McpServerConfig {
  const id = String(input.id || '').trim()
  const name = String(input.name || '').trim()
  if (!id || !name) throw new Error('MCP server id and name are required.')
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error('MCP server id may contain only letters, numbers, dot, underscore, and hyphen.')
  if (input.transport !== 'stdio' && input.transport !== 'streamable-http') throw new Error('Unsupported MCP transport.')
  if (input.transport === 'stdio' && !String(input.command || '').trim()) throw new Error('A command is required for stdio MCP servers.')
  if (input.transport === 'streamable-http') {
    if (!String(input.url || '').trim()) throw new Error('A URL is required for Streamable HTTP MCP servers.')
    try {
      const url = new URL(String(input.url))
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
    } catch {
      throw new Error('MCP URL must be a valid http or https address.')
    }
  }
  const env = input.env && typeof input.env === 'object' ? Object.fromEntries(Object.entries(input.env).filter(([key, value]) => key && typeof value === 'string')) : undefined
  const headers = input.headers && typeof input.headers === 'object' ? Object.fromEntries(Object.entries(input.headers).filter(([key, value]) => key && typeof value === 'string')) : undefined
  return {
    id,
    name,
    enabled: Boolean(input.enabled),
    transport: input.transport,
    command: input.command?.trim() || undefined,
    args: Array.isArray(input.args) ? input.args.map(String).filter(Boolean) : undefined,
    cwd: input.cwd?.trim() || undefined,
    env,
    url: input.url?.trim() || undefined,
    headers,
    toolAllowlist: Array.isArray(input.toolAllowlist) ? input.toolAllowlist.map(String).filter(Boolean) : undefined,
  }
}
