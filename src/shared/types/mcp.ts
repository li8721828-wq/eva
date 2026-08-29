export type McpTransport = 'stdio' | 'streamable-http'
export type McpServerStatus = 'disabled' | 'connecting' | 'connected' | 'error'

export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  transport: McpTransport
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  toolAllowlist?: string[]
}

export interface McpServerState extends McpServerConfig {
  status: McpServerStatus
  toolCount: number
  tools: string[]
  error?: string
  connectedAt?: string
}
