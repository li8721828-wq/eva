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
