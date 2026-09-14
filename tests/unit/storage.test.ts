import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Mock electron before importing stores
vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('') },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
}))

vi.mock('electron-store', () => {
  const store = new Map<string, any>()
  return {
    default: vi.fn().mockImplementation(() => ({
      get: vi.fn((key: string) => store.get(key)),
      set: vi.fn((key: string, value: any) => {
        store.set(key, value)
      }),
      store: {},
    })),
  }
})

import { ConversationStore } from '../../src/main/storage/conversation-store'
import { ActivityLogStore } from '../../src/main/storage/activity-log-store'
import { AgentStore } from '../../src/main/storage/agent-store'
import { TaskRunStore } from '../../src/main/storage/task-run-store'
import { BUILT_IN_AGENTS } from '../../src/shared/constants'

describe('ConversationStore', () => {
  it('rejects stale execution status updates after a run is cancelled', async () => {
    const conversation = await store.createConversation({ title: 'State guard', agentId: 'agent', mode: 'normal', workspacePath: '/tmp' })
    await store.updateConversation(conversation.id, { executionStatus: 'running' })
    await store.updateConversation(conversation.id, { executionStatus: 'cancelled' })
    await expect(store.updateConversation(conversation.id, { executionStatus: 'completed' })).rejects.toThrow('Illegal run state transition')
    expect((await store.getConversation(conversation.id))?.executionStatus).toBe('cancelled')
  })
  let store: ConversationStore
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-test-conv-'))
    store = new ConversationStore(tmpDir)
  })

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should list conversations (initially empty)', async () => {
    const list = await store.listConversations()
    expect(list).toEqual([])
  })

  it('should create a conversation', async () => {
    const conv = await store.createConversation({
      title: 'Test Conv',
      agentId: 'agent-1',
      mode: 'normal',
      workspacePath: '/workspace',
    })
    expect(conv.id).toBeDefined()
    expect(conv.title).toBe('Test Conv')
    expect(conv.mode).toBe('normal')

    const list = await store.listConversations()
    expect(list.length).toBe(1)
    expect(list[0].id).toBe(conv.id)
  })

  it('stores the multi-dimensional index preference per conversation', async () => {
    const first = await store.createConversation({
      title: 'First',
      agentId: 'agent-1',
      mode: 'normal',
      workspacePath: '/workspace',
    })
    const second = await store.createConversation({
      title: 'Second',
      agentId: 'agent-1',
      mode: 'normal',
      workspacePath: '/workspace',
    })

    await store.updateConversation(first.id, { multiDimensionalIndexEnabled: false })

    expect((await store.getConversation(first.id))?.multiDimensionalIndexEnabled).toBe(false)
    expect((await store.getConversation(second.id))?.multiDimensionalIndexEnabled).toBe(true)
  })

  it('acknowledges terminal execution status until the next execution completes', async () => {
    const conversation = await store.createConversation({
      title: 'Execution status',
      agentId: 'agent-1',
      mode: 'normal',
      workspacePath: '/workspace',
    })

    await store.updateConversation(conversation.id, { executionStatus: 'completed' })
    await store.updateConversation(conversation.id, { executionStatusAcknowledgedAt: 123 })
    expect((await store.getConversation(conversation.id))?.executionStatusAcknowledgedAt).toBe(123)

    await store.updateConversation(conversation.id, { executionStatus: 'running' })
    await store.updateConversation(conversation.id, { executionStatus: 'failed' })
    expect((await store.getConversation(conversation.id))?.executionStatusAcknowledgedAt).toBeUndefined()
  })

  it('marks conversations left running by a previous session as failed on startup', async () => {
    const stale = await store.createConversation({
      title: 'Stale run',
      agentId: 'agent-1',
      mode: 'normal',
      workspacePath: '/workspace',
    })
    const finished = await store.createConversation({
      title: 'Finished before restart',
      agentId: 'agent-1',
      mode: 'normal',
      workspacePath: '/workspace',
    })
    await store.updateConversation(stale.id, { executionStatus: 'running' })
    await store.updateConversation(finished.id, { executionStatus: 'completed' })
    await store.updateConversation(finished.id, { executionStatusAcknowledgedAt: 123 })

    await store.markRunningAsInterrupted()

    const recovered = await store.getConversation(stale.id)
    expect(recovered?.executionStatus).toBe('failed')
    expect(recovered?.executionStatusAcknowledgedAt).toBeUndefined()
    const untouched = await store.getConversation(finished.id)
    expect(untouched?.executionStatus).toBe('completed')
    expect(untouched?.executionStatusAcknowledgedAt).toBe(123)
  })

  it('should get a conversation by ID', async () => {
    const conv = await store.createConversation({
      title: 'Get Test',
      agentId: '',
      mode: 'normal',
      workspacePath: '',
    })
    const retrieved = await store.getConversation(conv.id)
    expect(retrieved).not.toBeNull()
    expect(retrieved!.title).toBe('Get Test')
  })

  it('should return null for non-existent conversation', async () => {
    expect(await store.getConversation('nonexistent')).toBeNull()
  })

  it('should delete a conversation', async () => {
    const conv = await store.createConversation({
      title: 'To Delete',
      agentId: '',
      mode: 'normal',
      workspacePath: '',
    })
    await store.deleteConversation(conv.id)
    expect(await store.getConversation(conv.id)).toBeNull()
    const list = await store.listConversations()
    expect(list.length).toBe(0)
  })

  it('should archive and restore a conversation without deleting it', async () => {
    const conv = await store.createConversation({
      title: 'To Archive',
      agentId: '',
      mode: 'normal',
      workspacePath: '',
    })

    expect(conv.archived).toBe(false)
    await store.updateConversation(conv.id, { archived: true })
    expect((await store.getConversation(conv.id))?.archived).toBe(true)

    await store.updateConversation(conv.id, { archived: false })
    expect((await store.getConversation(conv.id))?.archived).toBe(false)
  })

  it('should persist permissions on a conversation', async () => {
    const conv = await store.createConversation({
      title: 'Permission Test',
      agentId: '',
      mode: 'normal',
      permissionLevel: 'workspace',
      fileAccessGrants: [],
      workspacePath: '/workspace',
    })

    await store.updateConversation(conv.id, {
      permissionLevel: 'granted-folders',
      fileAccessGrants: [{ path: '/shared', access: 'read' }],
    })

    const updated = await store.getConversation(conv.id)
    expect(updated?.permissionLevel).toBe('granted-folders')
    expect(updated?.fileAccessGrants).toEqual([{ path: '/shared', access: 'read' }])
  })

  it('should add and get messages', async () => {
    const conv = await store.createConversation({
      title: 'Messages Test',
      agentId: '',
      mode: 'normal',
      workspacePath: '',
    })

    await store.addMessage(conv.id, {
      id: 'msg-1',
      role: 'user',
      content: 'Hello',
      timestamp: Date.now(),
    })
    await store.addMessage(conv.id, {
      id: 'msg-2',
      role: 'assistant',
      content: 'Hi!',
      timestamp: Date.now(),
    })

    const messages = await store.getMessages(conv.id)
    expect(messages.length).toBe(2)
    expect(messages[0].content).toBe('Hello')
    expect(messages[1].content).toBe('Hi!')
  })

  it('should support message pagination', async () => {
    const conv = await store.createConversation({
      title: 'Pagination',
      agentId: '',
      mode: 'normal',
      workspacePath: '',
    })

    for (let i = 0; i < 5; i++) {
      await store.addMessage(conv.id, {
        id: `msg-${i}`,
        role: 'user',
        content: `Message ${i}`,
        timestamp: Date.now(),
      })
    }

    const page = await store.getMessages(conv.id, { limit: 2, offset: 1 })
    expect(page.length).toBe(2)
    expect(page[0].content).toBe('Message 1')
    expect(page[1].content).toBe('Message 2')
  })

  it('writes new messages in bounded pages and lazily migrates legacy transcripts', async () => {
    const conv = await store.createConversation({
      title: 'Paged messages', agentId: '', mode: 'normal', workspacePath: '',
    })

    for (let i = 0; i < 101; i++) {
      await store.addMessage(conv.id, {
        id: `paged-${i}`, role: 'user', content: `Message ${i}`, timestamp: i,
      })
    }
    const pagesRoot = path.join(tmpDir, conv.id)
    const pageIndex = JSON.parse(fs.readFileSync(path.join(pagesRoot, 'message-pages.json'), 'utf8'))
    expect(pageIndex.pages.map((page: { count: number }) => page.count)).toEqual([100, 1])
    expect((await store.getMessages(conv.id, { offset: 99, limit: 2 })).map((message) => message.id)).toEqual(['paged-99', 'paged-100'])
    expect((await store.getRecentMessages(conv.id, 2)).map((message) => message.id)).toEqual(['paged-99', 'paged-100'])

    const legacy = await store.createConversation({
      title: 'Legacy messages', agentId: '', mode: 'normal', workspacePath: '',
    })
    const legacyRoot = path.join(tmpDir, legacy.id)
    fs.rmSync(path.join(legacyRoot, 'message-pages.json'))
    fs.writeFileSync(path.join(legacyRoot, 'messages.json'), JSON.stringify([
      { id: 'legacy-1', conversationId: legacy.id, role: 'user', content: 'Retained legacy content', timestamp: 1 },
    ]))
    expect((await store.getMessages(legacy.id))[0]?.content).toBe('Retained legacy content')
    expect(fs.existsSync(path.join(legacyRoot, 'message-pages', 'page-000001.json'))).toBe(true)
  })

  it('recovers the page index from disk pages instead of a stale legacy transcript', async () => {
    const conv = await store.createConversation({
      title: 'Index recovery', agentId: '', mode: 'normal', workspacePath: '',
    })
    for (let i = 0; i < 150; i++) {
      await store.addMessage(conv.id, {
        id: `recover-${i}`, role: 'user', content: `Message ${i}`, timestamp: i,
      })
    }

    const convRoot = path.join(tmpDir, conv.id)
    // A pre-existing legacy file must not win over the newer page files.
    fs.writeFileSync(path.join(convRoot, 'messages.json'), JSON.stringify([
      { id: 'stale-legacy', conversationId: conv.id, role: 'user', content: 'Stale legacy content', timestamp: 0 },
    ]))
    fs.writeFileSync(path.join(convRoot, 'message-pages.json'), '{ truncated', 'utf-8')

    const recovered = await store.getMessages(conv.id)
    expect(recovered.length).toBe(150)
    expect(recovered[149].id).toBe('recover-149')
    expect(recovered.some((message) => message.id === 'stale-legacy')).toBe(false)

    await store.addMessage(conv.id, { id: 'recover-150', role: 'user', content: 'Message 150', timestamp: 150 })
    const messages = await store.getMessages(conv.id)
    expect(messages.length).toBe(151)
    expect(messages[150].id).toBe('recover-150')
    const firstPage = JSON.parse(fs.readFileSync(path.join(convRoot, 'message-pages', 'page-000001.json'), 'utf8'))
    expect(firstPage.length).toBe(100)
  })

  it('never reuses a page id whose file still exists on disk', async () => {
    const conv = await store.createConversation({
      title: 'Page id reuse', agentId: '', mode: 'normal', workspacePath: '',
    })
    for (let i = 0; i < 100; i++) {
      await store.addMessage(conv.id, {
        id: `page-id-${i}`, role: 'user', content: `Message ${i}`, timestamp: i,
      })
    }

    // Simulate a crash between writing a new page file and updating the index:
    // the orphan file exists while the index still points at page one only.
    const orphanPath = path.join(tmpDir, conv.id, 'message-pages', 'page-000002.json')
    fs.writeFileSync(orphanPath, JSON.stringify([
      { id: 'orphan-1', conversationId: conv.id, role: 'user', content: 'Orphaned message', timestamp: 999 },
    ]))
    await store.addMessage(conv.id, { id: 'page-id-100', role: 'user', content: 'Message 100', timestamp: 100 })

    expect(JSON.parse(fs.readFileSync(orphanPath, 'utf8'))[0].id).toBe('orphan-1')
    const pageIndex = JSON.parse(fs.readFileSync(path.join(tmpDir, conv.id, 'message-pages.json'), 'utf8'))
    expect(pageIndex.pages.at(-1).id).toBe('page-000003')
    const messages = await store.getMessages(conv.id)
    expect(messages.at(-1)?.id).toBe('page-id-100')
  })

  it('should update a message', async () => {
    const conv = await store.createConversation({
      title: 'Update Msg',
      agentId: '',
      mode: 'normal',
      workspacePath: '',
    })

    await store.addMessage(conv.id, {
      id: 'msg-1',
      role: 'assistant',
      content: 'Original',
      timestamp: Date.now(),
    })

    await store.updateMessage(conv.id, 'msg-1', { content: 'Updated' })
    const messages = await store.getMessages(conv.id)
    expect(messages[0].content).toBe('Updated')
  })

  it('should delete messages from a specific message', async () => {
    const conv = await store.createConversation({
      title: 'Delete Msgs',
      agentId: '',
      mode: 'normal',
      workspacePath: '',
    })

    for (let i = 0; i < 4; i++) {
      await store.addMessage(conv.id, {
        id: `msg-${i}`,
        role: 'user',
        content: `Message ${i}`,
        timestamp: Date.now(),
      })
    }

    await store.deleteMessages(conv.id, 'msg-2')
    const remaining = await store.getMessages(conv.id)
    expect(remaining.length).toBe(2)
    expect(remaining[0].content).toBe('Message 0')
    expect(remaining[1].content).toBe('Message 1')
  })
})

describe('TaskRunStore', () => {
  let store: TaskRunStore
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-test-task-runs-'))
    store = new TaskRunStore(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('marks an unfinished run as interrupted after restart recovery', async () => {
    await store.save({ conversationId: 'conversation-1', kind: 'goal', status: 'running' })
    await store.markRunningAsInterrupted()

    const snapshot = await store.get('conversation-1')
    expect(snapshot?.status).toBe('interrupted')
    expect(snapshot?.error).toContain('Eva was closed')
  })
})

describe('ActivityLogStore', () => {
  let store: ActivityLogStore
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-test-activity-'))
    store = new ActivityLogStore(tmpDir)
  })

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('persists entries newest first and filters by conversation', async () => {
    await store.append({
      category: 'conversation',
      action: 'conversation.created',
      status: 'success',
      summary: 'Created first conversation.',
      conversationId: 'conversation-a',
      timestamp: 100,
    })
    await store.append({
      category: 'tool',
      action: 'tool.completed',
      status: 'success',
      summary: 'Completed tool call.',
      conversationId: 'conversation-b',
      timestamp: 200,
    })

    const allEntries = await store.list()
    expect(allEntries.map((entry) => entry.summary)).toEqual(['Completed tool call.', 'Created first conversation.'])

    const filteredEntries = await store.list({ conversationId: 'conversation-a' })
    expect(filteredEntries).toHaveLength(1)
    expect(filteredEntries[0].action).toBe('conversation.created')
  })
})

describe('AgentStore', () => {
  let store: AgentStore
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-test-agents-'))
    store = new AgentStore(tmpDir)
  })

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('updates persisted built-in prompts during initialization', async () => {
    await store.initializeBuiltInAgents()
    const codingAssistant = (await store.listAgents()).find((agent) => agent.name === 'Coding Assistant')!

    await store.updateAgent(codingAssistant.id, { systemPrompt: 'Old built-in prompt' })
    await store.initializeBuiltInAgents()

    const updated = await store.getAgent(codingAssistant.id)
    const shippedPrompt = BUILT_IN_AGENTS.find((agent) => agent.name === 'Coding Assistant')!.systemPrompt
    expect(updated?.systemPrompt).toBe(shippedPrompt)
  })

  it('serializes concurrent agent updates so no change is lost', async () => {
    const created = await store.createAgent({
      name: 'Racy', description: '', role: 'custom', systemPrompt: '',
      model: 'gpt-4o', providerId: 'openai', tools: [], maxIterations: 10,
      temperature: 0.7, isBuiltIn: false,
    })

    await Promise.all([
      store.updateAgent(created.id, { name: 'Renamed' }),
      store.updateAgent(created.id, { description: 'Described' }),
    ])

    const final = await store.getAgent(created.id)
    expect(final?.name).toBe('Renamed')
    expect(final?.description).toBe('Described')
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'agents.json'), 'utf8'))
    expect(onDisk).toHaveLength(1)
  })

  it('persists the selected Markdown renderer and defaults older agents to enhanced', async () => {
    const created = await store.createAgent({
      name: 'Classic reader',
      description: '',
      role: 'custom',
      systemPrompt: '',
      model: 'gpt-4o',
      providerId: 'openai',
      tools: [],
      maxIterations: 10,
      temperature: 0.7,
      isBuiltIn: false,
      markdownRenderer: 'streamdown',
    })

    expect((await store.getAgent(created.id))?.markdownRenderer).toBe('streamdown')

    await fs.promises.writeFile(path.join(tmpDir, 'agents.json'), JSON.stringify([{
      ...created,
      markdownRenderer: undefined,
    }]), 'utf-8')
    expect((await store.listAgents())[0].markdownRenderer).toBe('enhanced')
  })
})
