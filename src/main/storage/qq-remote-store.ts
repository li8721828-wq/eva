import { safeStorage } from 'electron'
import Store from 'electron-store'
import type { QqRemoteConfig, QqRemoteConfigInput } from '../../shared/types/qq'

interface StoredQqRemoteConfig {
  enabled: boolean
  appId: string
  encryptedSecret: string
  allowedUserIds: string[]
  defaultWorkspaceId: string | null
  defaultAgentId: string | null
  sandbox: boolean
  conversationIdsByUser: Record<string, string>
}

const defaults: StoredQqRemoteConfig = {
  enabled: false,
  appId: '',
  encryptedSecret: '',
  allowedUserIds: [],
  defaultWorkspaceId: null,
  defaultAgentId: null,
  sandbox: false,
  conversationIdsByUser: {},
}

export class QqRemoteStore {
  private readonly store = new Store<StoredQqRemoteConfig>({ name: 'qq-remote', defaults })

  getConfig(): QqRemoteConfig {
    const stored = this.store.store
    return {
      enabled: stored.enabled,
      appId: stored.appId,
      hasAppSecret: Boolean(stored.encryptedSecret),
      allowedUserIds: stored.allowedUserIds,
      defaultWorkspaceId: stored.defaultWorkspaceId,
      defaultAgentId: stored.defaultAgentId,
      sandbox: stored.sandbox,
    }
  }

  saveConfig(input: QqRemoteConfigInput): QqRemoteConfig {
    const appId = input.appId.trim()
    const next: Partial<StoredQqRemoteConfig> = {
      enabled: input.enabled,
      appId,
      allowedUserIds: [...new Set(input.allowedUserIds.map((id) => id.trim()).filter(Boolean))],
      defaultWorkspaceId: input.defaultWorkspaceId || null,
      defaultAgentId: input.defaultAgentId || null,
      sandbox: input.sandbox,
    }

    if (input.appSecret !== undefined && input.appSecret.trim()) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Secure credential storage is not available on this system.')
      }
      next.encryptedSecret = safeStorage.encryptString(input.appSecret.trim()).toString('base64')
    }

    this.store.set(next)
    return this.getConfig()
  }

  getAppSecret(): string | null {
    const encryptedSecret = this.store.get('encryptedSecret')
    if (!encryptedSecret || !safeStorage.isEncryptionAvailable()) return null
    try {
      return safeStorage.decryptString(Buffer.from(encryptedSecret, 'base64'))
    } catch {
      return null
    }
  }

  getConversationId(userId: string): string | null {
    return this.store.get('conversationIdsByUser')[userId] || null
  }

  setConversationId(userId: string, conversationId: string): void {
    this.store.set('conversationIdsByUser', {
      ...this.store.get('conversationIdsByUser'),
      [userId]: conversationId,
    })
  }
}
