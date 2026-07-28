export interface QqRemoteConfig {
  enabled: boolean
  appId: string
  hasAppSecret: boolean
  allowedUserIds: string[]
  defaultWorkspaceId: string | null
  defaultAgentId: string | null
  sandbox: boolean
}

export interface QqRemoteConfigInput {
  enabled: boolean
  appId: string
  /** Omit this field to keep the previously saved secret. */
  appSecret?: string
  allowedUserIds: string[]
  defaultWorkspaceId: string | null
  defaultAgentId: string | null
  sandbox: boolean
}

export interface QqRemoteStatus {
  state: 'disabled' | 'disconnected' | 'connecting' | 'connected' | 'error'
  message: string
  connectedAt?: number
}
