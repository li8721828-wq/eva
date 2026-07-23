import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { AgentConfig } from '../shared/types/agent'
import type { Conversation, ChatMessage, ChatStreamEvent } from '../shared/types/conversation'
import type { TeamEvent, GoalConfig, GoalProgress } from '../shared/types/task'
import type { LLMProviderConfig, ProviderConfigEntry, ProviderModelsResult, ProviderTestConfig } from '../shared/types/provider'
import type { SpecTemplate } from '../shared/types/spec'
import type { Workspace } from '../shared/types/workspace'

// GoalEvent type - defined locally to avoid importing from main process
type GoalEvent = unknown

type EventCallback<T = unknown> = (event: IpcRendererEvent, data: T) => void

export interface Unsubscribe {
  (): void
}

function onStream<T>(channel: string, callback: EventCallback<T>): Unsubscribe {
  const handler = (event: IpcRendererEvent, data: T): void => {
    callback(event, data)
  }
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

export interface EvaAPI {
  // 会话管理
  conversation: {
    list(): Promise<Conversation[]>
    create(data: Partial<Conversation>): Promise<Conversation>
    delete(id: string): Promise<void>
    load(id: string): Promise<{ conversation: Conversation; messages: ChatMessage[] }>
    update(id: string, data: Partial<Conversation>): Promise<Conversation>
  }

  // 聊天
  chat: {
    send(conversationId: string, message: string, agentId?: string): Promise<void>
    onStream(callback: EventCallback<ChatStreamEvent>): Unsubscribe
    abort(conversationId: string): Promise<void>
  }

  // 智能体管理
  agent: {
    list(): Promise<AgentConfig[]>
    get(id: string): Promise<AgentConfig>
    create(data: Partial<AgentConfig>): Promise<AgentConfig>
    update(id: string, data: Partial<AgentConfig>): Promise<AgentConfig>
    delete(id: string): Promise<void>
  }

  // 任务（Expert 模式）
  task: {
    start(conversationId: string, goal: string): Promise<void>
    onStream(callback: EventCallback<TeamEvent>): Unsubscribe
    abort(conversationId: string): Promise<void>
    getStatus(conversationId: string): Promise<string>
  }

  // Goal 模式
  goal: {
    start(payload: { goal: string; config?: Partial<GoalConfig>; conversationId: string; agentId: string }): void
    onStream(callback: EventCallback<GoalEvent>): Unsubscribe
    abort(): void
    pause(): void
    resume(): void
  }

  // Spec 模板
  spec: {
    list(): Promise<SpecTemplate[]>
    get(id: string): Promise<SpecTemplate>
  }

  // 文件系统
  file: {
    read(path: string, workspacePath?: string): Promise<string>
    write(path: string, content: string, workspacePath?: string): Promise<void>
    tree(path: string, workspacePath?: string): Promise<Array<{ name: string; path: string; isDirectory: boolean }>>
    search(path: string, query: string, workspacePath?: string): Promise<string[]>
    selectFolder(): Promise<string | null>
  }

  // 终端
  terminal: {
    create(id: string, cwd: string): Promise<void>
    write(id: string, data: string): Promise<void>
    onOutput(callback: EventCallback<{ id: string; data: string }>): Unsubscribe
    resize(id: string, cols: number, rows: number): Promise<void>
    destroy(id: string): Promise<void>
  }

  workspace: {
    list(): Promise<Workspace[]>
    create(path: string, name?: string): Promise<Workspace>
    update(id: string, updates: Partial<Workspace>): Promise<Workspace>
    delete(id: string): Promise<void>
  }

  menu: {
    onToggleTerminal(callback: () => void): Unsubscribe
  }

  // 配置
  config: {
    get<T = unknown>(key: string): Promise<T>
    set(key: string, value: unknown): Promise<void>
    getAll(): Promise<Record<string, unknown>>
  }

  // Provider
  provider: {
    list(): Promise<ProviderConfigEntry[]>
    getConfig(id: string): Promise<LLMProviderConfig>
    saveConfig(config: ProviderConfigEntry): Promise<void>
    test(config: ProviderTestConfig): Promise<{ success: boolean; message: string }>
    listModels(config: ProviderTestConfig): Promise<ProviderModelsResult>
  }
}

const evaAPI: EvaAPI = {
  // 会话管理
  conversation: {
    list: () => ipcRenderer.invoke(IPC.CONVERSATION_LIST),
    create: (data) => ipcRenderer.invoke(IPC.CONVERSATION_CREATE, data),
    delete: (id) => ipcRenderer.invoke(IPC.CONVERSATION_DELETE, id),
    load: (id) => ipcRenderer.invoke(IPC.CONVERSATION_LOAD, id),
    update: (id, data) => ipcRenderer.invoke(IPC.CONVERSATION_UPDATE, id, data),
  },

  // 聊天
  chat: {
    send: (conversationId, message, agentId) => {
      ipcRenderer.send(IPC.CHAT_SEND, { conversationId, message, agentId })
      return Promise.resolve()
    },
    onStream: (callback) => onStream(IPC.CHAT_STREAM, callback),
    abort: (conversationId) => {
      ipcRenderer.send(IPC.CHAT_ABORT, conversationId)
      return Promise.resolve()
    },
  },

  // 智能体管理
  agent: {
    list: () => ipcRenderer.invoke(IPC.AGENT_LIST),
    get: (id) => ipcRenderer.invoke(IPC.AGENT_GET, id),
    create: (data) => ipcRenderer.invoke(IPC.AGENT_CREATE, data),
    update: (id, data) => ipcRenderer.invoke(IPC.AGENT_UPDATE, id, data),
    delete: (id) => ipcRenderer.invoke(IPC.AGENT_DELETE, id),
  },

  // 任务（Expert 模式）
  task: {
    start: (conversationId, goal) => {
      ipcRenderer.send(IPC.TASK_START, { conversationId, goal })
      return Promise.resolve()
    },
    onStream: (callback) => onStream(IPC.TASK_STREAM, callback),
    abort: (conversationId) => {
      ipcRenderer.send(IPC.TASK_ABORT, conversationId)
      return Promise.resolve()
    },
    getStatus: (conversationId) => ipcRenderer.invoke(IPC.TASK_STATUS, conversationId),
  },

  // Goal 模式
  goal: {
    start: (payload) => {
      ipcRenderer.send(IPC.TASK_GOAL_START, payload)
    },
    onStream: (callback) => onStream(IPC.TASK_GOAL_STREAM, callback),
    abort: () => {
      ipcRenderer.send(IPC.TASK_GOAL_ABORT)
    },
    pause: () => {
      ipcRenderer.send(IPC.TASK_GOAL_PAUSE)
    },
    resume: () => {
      ipcRenderer.send(IPC.TASK_GOAL_RESUME)
    },
  },

  // Spec 模板
  spec: {
    list: () => ipcRenderer.invoke(IPC.SPEC_LIST),
    get: (id) => ipcRenderer.invoke(IPC.SPEC_GET, id),
  },

  // 文件系统
  file: {
    read: (path, workspacePath) => ipcRenderer.invoke(IPC.FILE_READ, path, workspacePath),
    write: (path, content, workspacePath) => ipcRenderer.invoke(IPC.FILE_WRITE, path, content, workspacePath),
    tree: (path, workspacePath) => ipcRenderer.invoke(IPC.FILE_TREE, path, workspacePath),
    search: (path, query, workspacePath) => ipcRenderer.invoke(IPC.FILE_SEARCH, query, workspacePath),
    selectFolder: () => ipcRenderer.invoke(IPC.FILE_SELECT_FOLDER),
  },

  // 终端
  terminal: {
    create: (id, cwd) => ipcRenderer.invoke(IPC.TERMINAL_CREATE, id, cwd),
    write: (id, data) => {
      ipcRenderer.send(IPC.TERMINAL_WRITE, id, data)
      return Promise.resolve()
    },
    onOutput: (callback) => onStream(IPC.TERMINAL_OUTPUT, callback),
    resize: (id, cols, rows) => {
      ipcRenderer.send(IPC.TERMINAL_RESIZE, id, cols, rows)
      return Promise.resolve()
    },
    destroy: (id) => ipcRenderer.invoke(IPC.TERMINAL_DESTROY, id),
  },

  workspace: {
    list: () => ipcRenderer.invoke(IPC.WORKSPACE_LIST),
    create: (path, name) => ipcRenderer.invoke(IPC.WORKSPACE_CREATE, path, name),
    update: (id, updates) => ipcRenderer.invoke(IPC.WORKSPACE_UPDATE, id, updates),
    delete: (id) => ipcRenderer.invoke(IPC.WORKSPACE_DELETE, id),
  },

  menu: {
    onToggleTerminal: (callback) => onStream<void>(IPC.MENU_TOGGLE_TERMINAL, () => callback()),
  },

  // 配置
  config: {
    get: (key) => ipcRenderer.invoke(IPC.CONFIG_GET, key),
    set: (key, value) => ipcRenderer.invoke(IPC.CONFIG_SET, key, value),
    getAll: () => ipcRenderer.invoke(IPC.CONFIG_GET_ALL),
  },

  // Provider
  provider: {
    list: () => ipcRenderer.invoke(IPC.PROVIDER_LIST),
    getConfig: (id) => ipcRenderer.invoke(IPC.PROVIDER_CONFIG, id),
    saveConfig: (config) => ipcRenderer.invoke(IPC.PROVIDER_CONFIG, config),
    test: (config) => ipcRenderer.invoke(IPC.PROVIDER_TEST, config),
    listModels: (config) => ipcRenderer.invoke(IPC.PROVIDER_MODELS, config),
  },
}

contextBridge.exposeInMainWorld('eva', evaAPI)
