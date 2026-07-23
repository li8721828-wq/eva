import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import type { Conversation, ChatMessage } from '../../shared/types/conversation'

interface ConversationIndex {
  ids: string[]
}

export class ConversationStore {
  private dataDir: string
  private writeLock: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.dataDir = dataDir
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  private convDir(id: string): string {
    return path.join(this.dataDir, id)
  }

  private metaPath(id: string): string {
    return path.join(this.convDir(id), 'meta.json')
  }

  private messagesPath(id: string): string {
    return path.join(this.convDir(id), 'messages.json')
  }

  private indexPath(): string {
    return path.join(this.dataDir, 'index.json')
  }

  private readJson<T>(filePath: string, fallback: T): T {
    try {
      if (!fs.existsSync(filePath)) return fallback
      const raw = fs.readFileSync(filePath, 'utf-8')
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  }

  /** Serialize writes to avoid concurrent corruption */
  private enqueue<T>(fn: () => T): Promise<T> {
    const run = async (): Promise<T> => {
      await this.writeLock
      return fn()
    }
    const p = run()
    this.writeLock = p.then(
      () => {},
      () => {}
    )
    return p
  }

  private readIndex(): ConversationIndex {
    return this.readJson<ConversationIndex>(this.indexPath(), { ids: [] })
  }

  private writeIndex(index: ConversationIndex): void {
    this.ensureDir(this.dataDir)
    fs.writeFileSync(this.indexPath(), JSON.stringify(index, null, 2), 'utf-8')
  }

  // ─── Conversation CRUD ─────────────────────────────────────────────────────

  async listConversations(): Promise<Conversation[]> {
    return this.enqueue(() => {
      this.ensureDir(this.dataDir)
      const index = this.readIndex()
      const results: Conversation[] = []
      for (const id of index.ids) {
        const meta = this.readJson<Conversation | null>(this.metaPath(id), null)
        if (meta) results.push(meta)
      }
      // Sort by updatedAt descending (most recent first)
      results.sort((a, b) => b.updatedAt - a.updatedAt)
      return results
    })
  }

  async getConversation(id: string): Promise<Conversation | null> {
    return this.enqueue(() => {
      return this.readJson<Conversation | null>(this.metaPath(id), null)
    })
  }

  async createConversation(params: {
    title: string
    agentId: string
    mode: 'normal' | 'expert' | 'goal'
    workspaceId?: string
    accessScope?: 'workspace' | 'full'
    workspacePath: string
  }): Promise<Conversation> {
    return this.enqueue(() => {
      const now = Date.now()
      const conversation: Conversation = {
        id: uuidv4(),
        title: params.title,
        agentId: params.agentId,
        mode: params.mode,
        workspaceId: params.workspaceId,
        accessScope: params.accessScope,
        workspacePath: params.workspacePath,
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
      }

      // Create conversation directory
      this.ensureDir(this.convDir(conversation.id))

      // Write meta
      fs.writeFileSync(
        this.metaPath(conversation.id),
        JSON.stringify(conversation, null, 2),
        'utf-8'
      )

      // Write empty messages
      fs.writeFileSync(this.messagesPath(conversation.id), '[]', 'utf-8')

      // Update index
      const index = this.readIndex()
      index.ids.push(conversation.id)
      this.writeIndex(index)

      return conversation
    })
  }

  async updateConversation(
    id: string,
    updates: Partial<Pick<Conversation, 'title' | 'updatedAt'>>
  ): Promise<void> {
    return this.enqueue(() => {
      const meta = this.readJson<Conversation | null>(this.metaPath(id), null)
      if (!meta) throw new Error(`Conversation ${id} not found`)

      const updated = {
        ...meta,
        ...updates,
        updatedAt: Date.now(),
      }
      fs.writeFileSync(this.metaPath(id), JSON.stringify(updated, null, 2), 'utf-8')
    })
  }

  async deleteConversation(id: string): Promise<void> {
    return this.enqueue(() => {
      const dir = this.convDir(id)
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true })
      }

      // Update index
      const index = this.readIndex()
      index.ids = index.ids.filter((cid) => cid !== id)
      this.writeIndex(index)
    })
  }

  // ─── Message Management ────────────────────────────────────────────────────

  async getMessages(
    conversationId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<ChatMessage[]> {
    return this.enqueue(() => {
      const all = this.readJson<ChatMessage[]>(this.messagesPath(conversationId), [])
      const offset = options?.offset ?? 0
      const limit = options?.limit ?? all.length
      return all.slice(offset, offset + limit)
    })
  }

  async addMessage(conversationId: string, message: ChatMessage): Promise<void> {
    return this.enqueue(() => {
      const messages = this.readJson<ChatMessage[]>(this.messagesPath(conversationId), [])
      messages.push(message)
      fs.writeFileSync(
        this.messagesPath(conversationId),
        JSON.stringify(messages, null, 2),
        'utf-8'
      )

      // Update message count in meta
      const meta = this.readJson<Conversation | null>(this.metaPath(conversationId), null)
      if (meta) {
        meta.messageCount = messages.length
        meta.updatedAt = Date.now()
        fs.writeFileSync(this.metaPath(conversationId), JSON.stringify(meta, null, 2), 'utf-8')
      }
    })
  }

  async updateMessage(
    conversationId: string,
    messageId: string,
    updates: Partial<ChatMessage>
  ): Promise<void> {
    return this.enqueue(() => {
      const messages = this.readJson<ChatMessage[]>(this.messagesPath(conversationId), [])
      const index = messages.findIndex((m) => m.id === messageId)
      if (index < 0) throw new Error(`Message ${messageId} not found`)

      messages[index] = { ...messages[index], ...updates }
      fs.writeFileSync(
        this.messagesPath(conversationId),
        JSON.stringify(messages, null, 2),
        'utf-8'
      )
    })
  }

  async deleteMessages(conversationId: string, fromMessageId: string): Promise<void> {
    return this.enqueue(() => {
      const messages = this.readJson<ChatMessage[]>(this.messagesPath(conversationId), [])
      const index = messages.findIndex((m) => m.id === fromMessageId)
      if (index < 0) return

      const kept = messages.slice(0, index)
      fs.writeFileSync(
        this.messagesPath(conversationId),
        JSON.stringify(kept, null, 2),
        'utf-8'
      )

      // Update message count
      const meta = this.readJson<Conversation | null>(this.metaPath(conversationId), null)
      if (meta) {
        meta.messageCount = kept.length
        meta.updatedAt = Date.now()
        fs.writeFileSync(this.metaPath(conversationId), JSON.stringify(meta, null, 2), 'utf-8')
      }
    })
  }

  // ─── Utility ───────────────────────────────────────────────────────────────

  async searchConversations(query: string): Promise<Conversation[]> {
    return this.enqueue(() => {
      const index = this.readIndex()
      const q = query.toLowerCase()
      const results: Conversation[] = []
      for (const id of index.ids) {
        const meta = this.readJson<Conversation | null>(this.metaPath(id), null)
        if (meta && meta.title.toLowerCase().includes(q)) {
          results.push(meta)
        }
      }
      results.sort((a, b) => b.updatedAt - a.updatedAt)
      return results
    })
  }

  async getConversationStats(
    id: string
  ): Promise<{ messageCount: number; lastMessageAt: number }> {
    return this.enqueue(() => {
      const messages = this.readJson<ChatMessage[]>(this.messagesPath(id), [])
      const lastMessageAt =
        messages.length > 0 ? messages[messages.length - 1].timestamp : 0
      return { messageCount: messages.length, lastMessageAt }
    })
  }
}
