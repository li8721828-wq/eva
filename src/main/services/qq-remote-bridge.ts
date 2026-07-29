import WebSocket from 'ws'
import type { ChatServices } from '../ipc/conversation'
import type { QqRemoteStatus } from '../../shared/types/qq'
import { getStorage } from '../storage'
import { recordActivity } from './activity-log'
import { executeRemoteConversationMessage } from './remote-conversation-executor'
import { splitQqPlainText } from './qq-message-format'

const QQ_API_BASE = 'https://api.sgroup.qq.com'
const QQ_SANDBOX_API_BASE = 'https://sandbox.api.sgroup.qq.com'
const QQ_ACCESS_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const GROUP_AND_C2C_INTENT = 1 << 25
const MAX_REMOTE_MESSAGES_PER_MINUTE = 6
const RATE_LIMIT_WINDOW_MS = 60_000

interface GatewayEnvelope {
  op: number
  s?: number
  t?: string
  d?: Record<string, unknown>
}

interface IncomingMessage {
  id: string
  userId: string
  content: string
  replyPath: string
}

export class QqRemoteBridge {
  private socket: WebSocket | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private reconnect: NodeJS.Timeout | null = null
  private sequence: number | null = null
  private status: QqRemoteStatus = { state: 'disabled', message: 'QQ remote control is not configured.' }
  private readonly processedMessageIds = new Set<string>()
  private readonly messageTimestampsByUser = new Map<string, number[]>()
  private readonly activeUsers = new Set<string>()

  constructor(private readonly services: ChatServices) {}

  getStatus(): QqRemoteStatus {
    return this.status
  }

  async start(): Promise<QqRemoteStatus> {
    this.stopTimers()
    this.socket?.terminate()
    this.socket = null

    const config = getStorage().qqRemote.getConfig()
    const secret = getStorage().qqRemote.getAppSecret()
    if (!config.enabled) return this.setStatus({ state: 'disabled', message: 'QQ remote control is disabled.' })
    if (!config.appId || !secret) return this.setStatus({ state: 'error', message: 'Enter and save both AppID and AppSecret first.' })
    if (!config.defaultWorkspaceId) return this.setStatus({ state: 'error', message: 'Choose a default project workspace before connecting.' })
    if (config.allowedUserIds.length === 0) return this.setStatus({ state: 'error', message: 'Add at least one allowed QQ OpenID before connecting.' })

    this.setStatus({ state: 'connecting', message: 'Connecting to the QQ Bot gateway...' })
    try {
      const accessToken = await this.fetchAccessToken(config.appId, secret)
      const apiBase = config.sandbox ? QQ_SANDBOX_API_BASE : QQ_API_BASE
      const gatewayResponse = await fetch(`${apiBase}/gateway/bot`, {
        headers: { Authorization: `QQBot ${accessToken}` },
      })
      if (!gatewayResponse.ok) throw new Error(`QQ gateway request failed (${gatewayResponse.status}).`)
      const gateway = await gatewayResponse.json() as { url?: string }
      if (!gateway.url) throw new Error('QQ did not return a gateway URL.')
      this.connectSocket(gateway.url, accessToken)
      return this.status
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to connect to QQ.'
      return this.setStatus({ state: 'error', message })
    }
  }

  stop(): QqRemoteStatus {
    this.stopTimers()
    this.socket?.close()
    this.socket = null
    return this.setStatus({ state: 'disconnected', message: 'QQ remote control disconnected.' })
  }

  private async fetchAccessToken(appId: string, clientSecret: string): Promise<string> {
    const response = await fetch(QQ_ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret }),
    })
    if (!response.ok) throw new Error(`QQ credential check failed (${response.status}).`)
    const payload = await response.json() as { access_token?: string }
    if (!payload.access_token) throw new Error('QQ did not return an access token.')
    return payload.access_token
  }

  private connectSocket(url: string, accessToken: string): void {
    const socket = new WebSocket(url)
    this.socket = socket
    socket.on('message', (raw) => this.handleGatewayMessage(raw.toString(), accessToken))
    socket.on('error', (error) => {
      void recordActivity({ category: 'system', action: 'qq.gateway_error', status: 'error', summary: `QQ gateway error: ${error.message}` })
      this.setStatus({ state: 'error', message: `QQ gateway error: ${error.message}` })
    })
    socket.on('close', () => {
      this.stopTimers()
      if (this.status.state !== 'disabled' && this.status.state !== 'disconnected') {
        void recordActivity({ category: 'system', action: 'qq.gateway_disconnected', status: 'error', summary: 'QQ gateway disconnected. Retrying shortly.' })
        this.setStatus({ state: 'disconnected', message: 'QQ gateway disconnected. Retrying shortly...' })
        this.reconnect = setTimeout(() => void this.start(), 5000)
      }
    })
  }

  private handleGatewayMessage(raw: string, accessToken: string): void {
    let event: GatewayEnvelope
    try {
      event = JSON.parse(raw) as GatewayEnvelope
    } catch {
      return
    }
    if (typeof event.s === 'number') this.sequence = event.s

    if (event.op === 10) {
      const interval = Number(event.d?.heartbeat_interval || 45000)
      this.heartbeat = setInterval(() => this.sendGateway({ op: 1, d: this.sequence }), interval)
      this.sendGateway({
        op: 2,
        d: {
          token: `QQBot ${accessToken}`,
          intents: GROUP_AND_C2C_INTENT,
          shard: [0, 1],
          properties: { $os: process.platform, $browser: 'Eva', $device: 'Eva Desktop' },
        },
      })
      return
    }
    if (event.op === 0 && event.t === 'READY') {
      void recordActivity({ category: 'system', action: 'qq.gateway_connected', status: 'success', summary: 'Connected to the QQ Bot gateway.' })
      this.setStatus({ state: 'connected', message: 'Connected to QQ Bot.', connectedAt: Date.now() })
      return
    }
    if (event.op === 0 && event.t) {
      const incoming = this.normalizeIncoming(event.t, event.d || {})
      if (incoming) void this.handleIncoming(incoming)
      else if (event.t !== 'RESUMED') {
        void recordActivity({ category: 'system', action: 'qq.event_ignored', status: 'info', summary: `Received unsupported QQ event: ${event.t}.` })
      }
    }
  }

  private normalizeIncoming(type: string, data: Record<string, unknown>): IncomingMessage | null {
    const id = typeof data.id === 'string' ? data.id : ''
    const content = typeof data.content === 'string' ? data.content.trim() : ''
    const author = data.author as { id?: string } | undefined
    const userId = author?.id || ''
    if (!id || !userId || !content) return null
    if (type === 'C2C_MESSAGE_CREATE') return { id, userId, content, replyPath: `/v2/users/${userId}/messages` }
    if (type === 'GROUP_AT_MESSAGE_CREATE') {
      const groupId = typeof data.group_openid === 'string' ? data.group_openid : ''
      return groupId ? { id, userId, content, replyPath: `/v2/groups/${groupId}/messages` } : null
    }
    return null
  }

  private async handleIncoming(incoming: IncomingMessage): Promise<void> {
    if (this.processedMessageIds.has(incoming.id)) return
    this.processedMessageIds.add(incoming.id)
    if (this.processedMessageIds.size > 500) this.processedMessageIds.clear()

    const config = getStorage().qqRemote.getConfig()
    if (!config.allowedUserIds.includes(incoming.userId)) {
      void recordActivity({ category: 'permission', action: 'qq.access_denied', status: 'error', summary: `Blocked QQ OpenID ${incoming.userId}. Add this OpenID to the QQ Remote allowlist to authorize it.` })
      return
    }
    if (!this.reserveMessageSlot(incoming.userId)) {
      void recordActivity({ category: 'permission', action: 'qq.rate_limited', status: 'error', summary: 'Rate-limited a QQ remote user after too many messages.', })
      await this.reply(incoming, 'Too many remote requests. Please wait one minute before trying again.')
      return
    }
    if (this.activeUsers.has(incoming.userId)) {
      void recordActivity({ category: 'conversation', action: 'qq.request_busy', status: 'info', summary: 'A QQ remote request was already running for this user.' })
      await this.reply(incoming, 'Eva is still handling your previous request. Please wait for its reply.')
      return
    }
    const workspace = config.defaultWorkspaceId ? await getStorage().workspaces.get(config.defaultWorkspaceId) : null
    if (!workspace) {
      await this.reply(incoming, 'Eva has no valid default workspace configured for QQ remote control.')
      return
    }

    let conversationId = getStorage().qqRemote.getConversationId(incoming.userId)
    const existing = conversationId ? await getStorage().conversations.getConversation(conversationId) : null
    if (!existing) {
      const agents = await getStorage().agents.listAgents()
      const conversation = await getStorage().conversations.createConversation({
        title: `QQ · ${incoming.userId.slice(-8)}`,
        agentId: config.defaultAgentId || agents[0]?.id || '',
        mode: 'normal',
        workspaceId: workspace.id,
        channel: 'qq',
        accessScope: 'workspace',
        permissionLevel: 'workspace',
        workspacePath: workspace.path,
      })
      conversationId = conversation.id
      getStorage().qqRemote.setConversationId(incoming.userId, conversationId)
    }
    if (!conversationId) throw new Error('Unable to create a conversation for the QQ message.')

    this.activeUsers.add(incoming.userId)
    try {
      void recordActivity({ category: 'conversation', action: 'qq.message_received', status: 'info', summary: 'Received a QQ remote message.', conversationId, workspaceId: workspace.id })
      const response = await executeRemoteConversationMessage(this.services, conversationId, incoming.content)
      await this.reply(incoming, response)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      await this.reply(incoming, `Eva could not complete this request: ${message}`)
    } finally {
      this.activeUsers.delete(incoming.userId)
    }
  }

  private async reply(incoming: IncomingMessage, content: string): Promise<void> {
    const config = getStorage().qqRemote.getConfig()
    const secret = getStorage().qqRemote.getAppSecret()
    if (!secret) return
    const accessToken = await this.fetchAccessToken(config.appId, secret)
    const apiBase = config.sandbox ? QQ_SANDBOX_API_BASE : QQ_API_BASE
    const chunks = await splitQqPlainText(content)
    for (const [index, chunk] of chunks.entries()) {
      const response = await fetch(`${apiBase}${incoming.replyPath}`, {
        method: 'POST',
        headers: { Authorization: `QQBot ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: chunk,
          msg_type: 0,
          msg_id: incoming.id,
          msg_seq: index + 1,
        }),
      })
      if (!response.ok) throw new Error(`QQ reply failed (${response.status}).`)
    }
    void recordActivity({ category: 'conversation', action: 'qq.reply_sent', status: 'success', summary: `Sent ${chunks.length} Eva reply message${chunks.length === 1 ? '' : 's'} to QQ.` })
  }

  private reserveMessageSlot(userId: string): boolean {
    const now = Date.now()
    const recent = (this.messageTimestampsByUser.get(userId) || []).filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS)
    if (recent.length >= MAX_REMOTE_MESSAGES_PER_MINUTE) {
      this.messageTimestampsByUser.set(userId, recent)
      return false
    }
    recent.push(now)
    this.messageTimestampsByUser.set(userId, recent)
    return true
  }

  private sendGateway(payload: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload))
  }

  private stopTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.reconnect) clearTimeout(this.reconnect)
    this.heartbeat = null
    this.reconnect = null
  }

  private setStatus(status: QqRemoteStatus): QqRemoteStatus {
    this.status = status
    return status
  }
}
