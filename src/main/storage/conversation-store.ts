import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import type { Conversation, ChatMessage } from '../../shared/types/conversation'
import { assertRunTransition } from '../services/run-state-machine'

interface ConversationIndex {
  ids: string[]
}

interface MessagePageDescriptor {
  id: string
  count: number
}

interface MessagePageIndex {
  version: 1
  pages: MessagePageDescriptor[]
}

const MESSAGE_PAGE_SIZE = 100

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

  private messagePagesDir(id: string): string {
    return path.join(this.convDir(id), 'message-pages')
  }

  private messagePageIndexPath(id: string): string {
    return path.join(this.convDir(id), 'message-pages.json')
  }

  private messagePagePath(id: string, pageId: string): string {
    return path.join(this.messagePagesDir(id), `${pageId}.json`)
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

  /**
   * Write via a unique temp file plus rename so a crash mid-write leaves the
   * previous version intact instead of a truncated JSON file that readers
   * would treat as "missing".
   *
   * On Windows, antivirus or search indexers briefly lock the destination
   * after each write, which makes the rename fail with EPERM. We retry a few
   * times with a tiny backoff before giving up so a transient lock does not
   * corrupt the durable record.
   */
  private writeJsonAtomic(filePath: string, data: unknown): void {
    this.ensureDir(path.dirname(filePath))
    const tmpPath = `${filePath}.${uuidv4()}.tmp`
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
    try {
      this.renameWithRetry(tmpPath, filePath)
    } catch (error) {
      try {
        fs.rmSync(tmpPath, { force: true })
      } catch {
        // Best-effort cleanup; the rename error below is the actionable one.
      }
      throw error
    }
  }

  private renameWithRetry(src: string, dest: string): void {
    const maxAttempts = 5
    let lastError: unknown
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        fs.renameSync(src, dest)
        return
      } catch (error) {
        lastError = error
        const code = (error as NodeJS.ErrnoException)?.code
        const retriable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
        if (!retriable || attempt === maxAttempts) break
        // Brief synchronous sleep so a Defender/Indexing handle can release.
        const sleepMs = 10 * attempt
        const until = Date.now() + sleepMs
        while (Date.now() < until) { /* spin */ }
      }
    }
    throw lastError
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
    this.writeJsonAtomic(this.indexPath(), index)
  }

  /**
   * Migrate the old monolithic messages.json lazily, per conversation. New
   * writes touch only the final page and its tiny index instead of rewriting a
   * growing full transcript on every streamed response.
   *
   * When the page index is missing or corrupt, recover from the page files on
   * disk first: they hold everything written after the legacy migration, so
   * rebuilding from a stale messages.json would silently replace newer
   * transcripts with old content.
   */
  private ensureMessagePages(conversationId: string): MessagePageIndex {
    const existing = this.readJson<MessagePageIndex | null>(this.messagePageIndexPath(conversationId), null)
    if (existing?.version === 1 && Array.isArray(existing.pages)) {
      if (existing.pages.length > 0) return existing
      // An empty index can still coexist with page files: an earlier partial
      // recovery wrote an empty index while the transcript pages stayed on
      // disk. Recover them instead of orphaning the conversation history.
      const fromDisk = this.recoverPagesFromDisk(conversationId)
      if (fromDisk.pages.length > 0) {
        this.writeMessagePageIndex(conversationId, fromDisk)
        return fromDisk
      }
      return existing
    }

    const recovered = this.recoverPagesFromDisk(conversationId)
    if (recovered.pages.length > 0) {
      this.writeMessagePageIndex(conversationId, recovered)
      return recovered
    }

    const legacyMessages = this.readJson<ChatMessage[]>(this.messagesPath(conversationId), [])
    this.ensureDir(this.messagePagesDir(conversationId))
    const pages: MessagePageDescriptor[] = []
    for (let offset = 0; offset < legacyMessages.length; offset += MESSAGE_PAGE_SIZE) {
      const id = `page-${String(pages.length + 1).padStart(6, '0')}`
      const messages = legacyMessages.slice(offset, offset + MESSAGE_PAGE_SIZE)
      this.writeJsonAtomic(this.messagePagePath(conversationId, id), messages)
      pages.push({ id, count: messages.length })
    }
    const index: MessagePageIndex = { version: 1, pages }
    this.writeMessagePageIndex(conversationId, index)
    return index
  }

  /** Rebuild a page index from the page files actually present on disk. */
  private recoverPagesFromDisk(conversationId: string): MessagePageIndex {
    let entries: string[]
    try {
      entries = fs.readdirSync(this.messagePagesDir(conversationId))
    } catch {
      return { version: 1, pages: [] }
    }

    const pageIds = entries
      .filter((name) => /^page-\d+\.json$/.test(name))
      .map((name) => name.slice(0, -'.json'.length))
      .sort()
    const pages: MessagePageDescriptor[] = []
    for (const id of pageIds) {
      const messages = this.readJson<ChatMessage[]>(this.messagePagePath(conversationId, id), [])
      if (messages.length === 0) continue
      pages.push({ id, count: messages.length })
    }
    return { version: 1, pages }
  }

  /** Next unused page id. Never reuses a number whose file still exists. */
  private nextMessagePageId(conversationId: string, index: MessagePageIndex): string {
    let highest = 0
    for (const page of index.pages) {
      const match = /^page-(\d+)$/.exec(page.id)
      if (match) highest = Math.max(highest, Number(match[1]))
    }
    let next = highest + 1
    while (fs.existsSync(this.messagePagePath(conversationId, `page-${String(next).padStart(6, '0')}`))) {
      next += 1
    }
    return `page-${String(next).padStart(6, '0')}`
  }

  private writeMessagePageIndex(conversationId: string, index: MessagePageIndex): void {
    this.writeJsonAtomic(this.messagePageIndexPath(conversationId), index)
  }

  private readMessagePage(conversationId: string, pageId: string): ChatMessage[] {
    return this.readJson<ChatMessage[]>(this.messagePagePath(conversationId, pageId), [])
  }

  private writeMessagePage(conversationId: string, pageId: string, messages: ChatMessage[]): void {
    this.writeJsonAtomic(this.messagePagePath(conversationId, pageId), messages)
  }

  private totalPageMessages(index: MessagePageIndex): number {
    return index.pages.reduce((total, page) => total + page.count, 0)
  }

  private updateMessageCount(conversationId: string, count: number): void {
    const meta = this.readJson<Conversation | null>(this.metaPath(conversationId), null)
    if (!meta) return
    meta.messageCount = count
    meta.updatedAt = Date.now()
    this.writeJsonAtomic(this.metaPath(conversationId), meta)
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
    titleSource?: Conversation['titleSource']
    agentId: string
    mode: 'normal' | 'expert' | 'goal'
    workspaceId?: string
    channel?: Conversation['channel']
    parentConversationId?: string
    teamTaskId?: string
    goalStepId?: string
    accessScope?: 'workspace' | 'full'
    permissionLevel?: Conversation['permissionLevel']
    fileAccessGrants?: Conversation['fileAccessGrants']
    multiDimensionalIndexEnabled?: boolean
    symposium?: Conversation['symposium']
    workspacePath: string
  }): Promise<Conversation> {
    return this.enqueue(() => {
      const now = Date.now()
      const conversation: Conversation = {
        id: uuidv4(),
        title: params.title,
        titleSource: params.titleSource || 'manual',
        agentId: params.agentId,
        mode: params.mode,
        workspaceId: params.workspaceId,
        channel: params.channel,
        parentConversationId: params.parentConversationId,
        teamTaskId: params.teamTaskId,
        goalStepId: params.goalStepId,
        accessScope: params.accessScope,
        permissionLevel: params.permissionLevel,
        fileAccessGrants: params.fileAccessGrants || [],
        multiDimensionalIndexEnabled: params.multiDimensionalIndexEnabled !== false,
        symposium: params.symposium,
        archived: false,
        workspacePath: params.workspacePath,
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
      }

      // Create conversation directory
      this.ensureDir(this.convDir(conversation.id))

      // Write meta
      this.writeJsonAtomic(this.metaPath(conversation.id), conversation)

      // Initialize paged message storage. Existing conversations migrate from
      // messages.json only when first accessed after this release.
      this.writeMessagePageIndex(conversation.id, { version: 1, pages: [] })

      // Update index
      const index = this.readIndex()
      index.ids.push(conversation.id)
      this.writeIndex(index)

      return conversation
    })
  }

  async updateConversation(
    id: string,
    updates: Partial<Pick<Conversation, 'title' | 'titleSource' | 'agentId' | 'archived' | 'permissionLevel' | 'fileAccessGrants' | 'multiDimensionalIndexEnabled' | 'gitRepositoryPath' | 'gitBranch' | 'gitWorktreePath' | 'workspacePath' | 'symposium' | 'executionStatus' | 'executionUpdatedAt' | 'executionStatusAcknowledgedAt' | 'updatedAt'>>
  ): Promise<void> {
    return this.enqueue(() => {
      const meta = this.readJson<Conversation | null>(this.metaPath(id), null)
      if (!meta) throw new Error(`Conversation ${id} not found`)
      if (updates.executionStatus && updates.executionStatus !== meta.executionStatus && !(updates.executionStatus === 'running' && meta.executionStatus && ['completed', 'failed', 'cancelled'].includes(meta.executionStatus))) {
        // Conversations created before the runtime kernel had no lifecycle
        // state; treat that first transition as a queued run.
        assertRunTransition(meta.executionStatus || 'queued', updates.executionStatus)
      }

      const hasNewTerminalState = updates.executionStatus !== undefined
        && updates.executionStatus !== meta.executionStatus
        && updates.executionStatus !== 'running'
      const updated = {
        ...meta,
        ...updates,
        ...(hasNewTerminalState ? { executionStatusAcknowledgedAt: undefined } : {}),
        updatedAt: Date.now(),
      }
      this.writeJsonAtomic(this.metaPath(id), updated)
    })
  }

  /** Runs cannot survive an app restart. Reset conversations left "running" by
   * a previous session so the sidebar does not spin forever after relaunch. */
  async markRunningAsInterrupted(): Promise<void> {
    return this.enqueue(() => {
      this.ensureDir(this.dataDir)
      for (const id of this.readIndex().ids) {
        const meta = this.readJson<Conversation | null>(this.metaPath(id), null)
        if (!meta || meta.executionStatus !== 'running') continue
        const updated: Conversation = {
          ...meta,
          executionStatus: 'failed',
          executionUpdatedAt: Date.now(),
          executionStatusAcknowledgedAt: undefined,
        }
        this.writeJsonAtomic(this.metaPath(id), updated)
      }
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
      const index = this.ensureMessagePages(conversationId)
      const total = this.totalPageMessages(index)
      const offset = Math.max(0, options?.offset ?? 0)
      const limit = Math.max(0, options?.limit ?? total)
      const end = Math.min(total, offset + limit)
      if (offset >= end) return []

      const messages: ChatMessage[] = []
      let pageStart = 0
      for (const page of index.pages) {
        const pageEnd = pageStart + page.count
        if (pageEnd <= offset) {
          pageStart = pageEnd
          continue
        }
        if (pageStart >= end) break
        const records = this.readMessagePage(conversationId, page.id)
        const from = Math.max(0, offset - pageStart)
        const to = Math.min(records.length, end - pageStart)
        messages.push(...records.slice(from, to))
        pageStart = pageEnd
      }
      return messages
    })
  }

  /** Read the newest messages without scanning earlier pages. Used for model context. */
  async getRecentMessages(conversationId: string, limit: number): Promise<ChatMessage[]> {
    return this.enqueue(() => {
      const index = this.ensureMessagePages(conversationId)
      const requested = Math.max(0, Math.floor(limit))
      if (requested === 0) return []

      const messages: ChatMessage[] = []
      for (let pageIndex = index.pages.length - 1; pageIndex >= 0 && messages.length < requested; pageIndex -= 1) {
        const page = index.pages[pageIndex]
        const records = this.readMessagePage(conversationId, page.id)
        const remaining = requested - messages.length
        messages.unshift(...records.slice(Math.max(0, records.length - remaining)))
      }
      return messages
    })
  }

  async addMessage(conversationId: string, message: Omit<ChatMessage, 'conversationId'> | ChatMessage): Promise<void> {
    return this.enqueue(() => {
      const storedMessage: ChatMessage = { ...message, conversationId }
      const index = this.ensureMessagePages(conversationId)
      let page = index.pages.at(-1)
      if (!page || page.count >= MESSAGE_PAGE_SIZE) {
        page = { id: this.nextMessagePageId(conversationId, index), count: 0 }
        index.pages.push(page)
      }
      const messages = this.readMessagePage(conversationId, page.id)
      messages.push(storedMessage)
      page.count = messages.length
      this.writeMessagePage(conversationId, page.id, messages)
      this.writeMessagePageIndex(conversationId, index)
      this.updateMessageCount(conversationId, this.totalPageMessages(index))
    })
  }

  async updateMessage(
    conversationId: string,
    messageId: string,
    updates: Partial<ChatMessage>
  ): Promise<void> {
    return this.enqueue(() => {
      const index = this.ensureMessagePages(conversationId)
      for (const page of index.pages) {
        const messages = this.readMessagePage(conversationId, page.id)
        const messageIndex = messages.findIndex((message) => message.id === messageId)
        if (messageIndex < 0) continue
        messages[messageIndex] = { ...messages[messageIndex], ...updates }
        this.writeMessagePage(conversationId, page.id, messages)
        return
      }
      throw new Error(`Message ${messageId} not found`)
    })
  }

  async deleteMessages(conversationId: string, fromMessageId: string): Promise<void> {
    return this.enqueue(() => {
      const index = this.ensureMessagePages(conversationId)
      const pageIndex = index.pages.findIndex((page) => this.readMessagePage(conversationId, page.id).some((message) => message.id === fromMessageId))
      if (pageIndex < 0) return

      const page = index.pages[pageIndex]
      const records = this.readMessagePage(conversationId, page.id)
      const messageIndex = records.findIndex((message) => message.id === fromMessageId)
      const keptInPage = records.slice(0, messageIndex)
      const removedPages = index.pages.slice(pageIndex)
      for (const removed of removedPages) {
        const filePath = this.messagePagePath(conversationId, removed.id)
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
      }
      index.pages = index.pages.slice(0, pageIndex)
      if (keptInPage.length > 0) {
        this.writeMessagePage(conversationId, page.id, keptInPage)
        index.pages.push({ id: page.id, count: keptInPage.length })
      }
      this.writeMessagePageIndex(conversationId, index)
      this.updateMessageCount(conversationId, this.totalPageMessages(index))
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
      const index = this.ensureMessagePages(id)
      const lastPage = index.pages.at(-1)
      const messages = lastPage ? this.readMessagePage(id, lastPage.id) : []
      return {
        messageCount: this.totalPageMessages(index),
        lastMessageAt: messages.at(-1)?.timestamp || 0,
      }
    })
  }
}
