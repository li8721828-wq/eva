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
})
