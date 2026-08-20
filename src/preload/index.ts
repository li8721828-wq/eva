import { contextBridge, ipcRenderer, IpcRendererEvent, webUtils } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { AgentConfig } from '../shared/types/agent'
import type { Conversation, ChatDocumentAttachment, ChatImageAttachment, ChatMessage, ChatMessageReference, ChatStreamEvent } from '../shared/types/conversation'
import type { GitRepositoryStatus } from '../shared/types/git'
import type { SymposiumContinueInput, SymposiumStartInput, SymposiumStreamEvent } from '../shared/types/symposium'
import type { TeamEvent, GoalConfig, GoalProgress, TaskArtifactRun, TaskFeedback, TaskRunSnapshot } from '../shared/types/task'
import type { LLMProviderConfig, ProviderConfigEntry, ProviderModelsResult, ProviderTestConfig } from '../shared/types/provider'
import type { ModelPool, ModelRouteRequest, ModelRouteResult } from '../shared/types/model-pool'
import type { CostUsageReport, ModelRateCard, SupplierRateRefreshResult } from '../shared/types/cost'
import type { SpecTemplate } from '../shared/types/spec'
import type { Workspace } from '../shared/types/workspace'
import type { ActivityLogEntry, ActivityLogFilter } from '../shared/types/activity'
import type { QqRemoteConfig, QqRemoteConfigInput, QqRemoteStatus } from '../shared/types/qq'
import type { InstalledPlugin, LocalSearxngStatus, MarketplacePluginView } from '../shared/types/plugin'
import type { ProjectIndexCatalogPage, ProjectIndexScope, ProjectIndexSearchResult, ProjectIndexSnapshot, ProjectIndexStatus } from '../shared/types/project-index'
import type { RuntimeEvolutionProposal } from '../shared/types/runtime-evolution'
import type { RuntimeKernelAuditRecord, RuntimeKernelSnapshot } from '../shared/types/runtime-kernel'
import type { ActivePlan } from '../shared/types/active-plan'
import type { NetworkConfig, NetworkTestResult } from '../shared/types/network'
import type { RequirementDocument, RequirementProgress, RequirementRun, SubmitClarificationAnswersInput, SubmitCodingInput, SubmitDslInput, SubmitRequirementInput, SubmitRequirementModelingInput, SubmitSpecificationInput, SubmitSpecificationResolutionInput } from '../shared/types/requirement-engineering'

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
  windowControls: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
    version(): Promise<string>
  }

  // 会话管理
  conversation: {
    list(): Promise<Conversation[]>
    create(data: Partial<Conversation>): Promise<Conversation>
    delete(id: string): Promise<void>
    load(id: string): Promise<{ conversation: Conversation; messages: ChatMessage[] }>
    update(id: string, data: Partial<Pick<Conversation, 'title' | 'titleSource' | 'agentId' | 'archived' | 'permissionLevel' | 'fileAccessGrants' | 'multiDimensionalIndexEnabled' | 'symposium' | 'executionStatusAcknowledgedAt' | 'contextHandoff'>>): Promise<void>
    updateMessage(conversationId: string, messageId: string, data: Partial<Pick<ChatMessage, 'favorited'>>): Promise<void>
    deleteMessagesFrom(conversationId: string, messageId: string): Promise<void>
    continueFromHandoff(conversationId: string): Promise<Conversation>
    onChanged(callback: EventCallback<string>): Unsubscribe
  }

  // 聊天
  chat: {
    send(conversationId: string, message: string, agentId?: string, images?: ChatImageAttachment[], attachments?: ChatDocumentAttachment[], quotedMessage?: ChatMessageReference): Promise<void>
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
    start(conversationId: string, goal: string, resume?: boolean): Promise<void>
    onStream(callback: EventCallback<TeamEvent>): Unsubscribe
    abort(conversationId: string): Promise<void>
    /** Cancels either a Goal or Team task and waits until its durable state is updated. */
    cancel(conversationId: string): Promise<boolean>
    getStatus(conversationId: string): Promise<string>
    getSnapshot(conversationId: string): Promise<TaskRunSnapshot | null>
    listArtifacts(workspaceId: string): Promise<TaskArtifactRun[]>
    addFeedback(conversationId: string, content: string, checkpointId?: string, pauseAfterCurrentOperation?: boolean): Promise<TaskFeedback>
    /** True when an already-running planner was resumed in this process. */
    resumeFromCheckpoint(conversationId: string): Promise<boolean>
    resume(run: Pick<TaskArtifactRun, 'conversationId' | 'kind' | 'goal' | 'agentId'>): Promise<void>
  }

  // Goal 模式
  goal: {
    start(payload: { goal: string; config?: Partial<GoalConfig>; conversationId: string; agentId: string; resume?: boolean }): void
    onStream(callback: EventCallback<GoalEvent>): Unsubscribe
    abort(conversationId: string): void
    pause(conversationId: string): Promise<void>
    resume(conversationId: string): Promise<void>
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
    selectFiles(): Promise<string[]>
    selectAttachments(): Promise<string[]>
    imagePreview(path: string): Promise<string | null>
    saveClipboardImage(input: { dataUrl: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' }): Promise<{ path: string; name: string; size: number }>
    showContextMenu(input: { path: string; workspacePath?: string; isDirectory: boolean }): Promise<void>
    getPath(file: File): string
  }

  // 终端
  terminal: {
    create(id: string, cwd: string): Promise<void>
    write(id: string, data: string): Promise<void>
    onOutput(callback: EventCallback<{ id: string; data: string }>): Unsubscribe
    resize(id: string, cols: number, rows: number): Promise<void>
    destroy(id: string): Promise<void>
  }

  activity: {
    list(filter?: ActivityLogFilter): Promise<ActivityLogEntry[]>
    onEntry(callback: EventCallback<ActivityLogEntry>): Unsubscribe
  }

  workspace: {
    list(): Promise<Workspace[]>
    create(path: string, name?: string): Promise<Workspace>
    update(id: string, updates: Partial<Workspace>): Promise<Workspace>
    delete(id: string): Promise<void>
  }

  symposium: {
    start(input: SymposiumStartInput): Promise<void>
    continue(input: SymposiumContinueInput): Promise<void>
    abort(conversationId: string): Promise<void>
    onStream(callback: EventCallback<SymposiumStreamEvent>): Unsubscribe
  }

  projectIndex: {
    status(workspaceId: string): Promise<ProjectIndexStatus>
    search(workspaceId: string, query: string, maxResults?: number, scope?: ProjectIndexScope): Promise<ProjectIndexSearchResult[]>
    browse(workspaceId: string, scope?: ProjectIndexScope, query?: string, offset?: number, limit?: number): Promise<ProjectIndexCatalogPage>
    refresh(workspaceId: string): Promise<ProjectIndexSnapshot>
  }

  git: {
    status(conversationId: string): Promise<GitRepositoryStatus>
    switchBranch(conversationId: string, branch: string): Promise<Conversation>
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
    delete(id: string): Promise<void>
    test(config: ProviderTestConfig): Promise<{ success: boolean; message: string }>
    listModels(config: ProviderTestConfig): Promise<ProviderModelsResult>
  }

  runtimeProposal: {
    list(): Promise<RuntimeEvolutionProposal[]>
    decide(id: string, status: 'approved' | 'rejected', decisionNote?: string): Promise<RuntimeEvolutionProposal>
    beginImplementation(id: string, conversationId: string): Promise<RuntimeEvolutionProposal>
  }

  runtimeKernel: {
    snapshot(): Promise<RuntimeKernelSnapshot>
    listAudit(limit?: number): Promise<RuntimeKernelAuditRecord[]>
  }

  network: {
    getConfig(): Promise<NetworkConfig>
    saveConfig(config: NetworkConfig): Promise<NetworkConfig>
    testConnection(url?: string): Promise<NetworkTestResult>
  }

  activePlan: {
    get(scopeKey: string): Promise<ActivePlan | null>
  }

  modelPool: {
    list(): Promise<ModelPool[]>
    save(pools: ModelPool[]): Promise<void>
    route(request: ModelRouteRequest): Promise<ModelRouteResult>
  }

  cost: {
    getUsageReport(): Promise<CostUsageReport>
    saveRateCards(rateCards: ModelRateCard[]): Promise<void>
    refreshSupplierRates(): Promise<SupplierRateRefreshResult[]>
  }

  qqRemote: {
    getConfig(): Promise<QqRemoteConfig>
    saveConfig(config: QqRemoteConfigInput): Promise<QqRemoteConfig>
    getStatus(): Promise<QqRemoteStatus>
    connect(): Promise<QqRemoteStatus>
    disconnect(): Promise<QqRemoteStatus>
  }

  plugins: {
    list(): Promise<InstalledPlugin[]>
    marketplace(): Promise<MarketplacePluginView[]>
    installMarketplace(id: string): Promise<InstalledPlugin>
    importManifest(): Promise<InstalledPlugin | null>
    setEnabled(id: string, enabled: boolean): Promise<InstalledPlugin>
    remove(id: string): Promise<void>
    updateSettings(id: string, settings: Record<string, string | number | boolean>): Promise<InstalledPlugin>
    selectPath(kind: 'file' | 'directory'): Promise<string | null>
    getLocalSearxngStatus(): Promise<LocalSearxngStatus>
    installLocalSearxng(): Promise<LocalSearxngStatus>
    stopLocalSearxng(): Promise<LocalSearxngStatus>
  }

  requirements: {
    listRuns(conversationId?: string): Promise<RequirementRun[]>
    submit(input: SubmitRequirementInput): Promise<RequirementRun>
    answer(input: SubmitClarificationAnswersInput): Promise<RequirementRun>
    model(input: SubmitRequirementModelingInput): Promise<RequirementRun>
    spec(input: SubmitSpecificationInput): Promise<RequirementRun>
    dsl(input: SubmitDslInput): Promise<RequirementRun>
    coding(input: SubmitCodingInput): Promise<RequirementRun>
    resolveSpec(input: SubmitSpecificationResolutionInput): Promise<RequirementRun>
    abort(conversationId: string): Promise<void>
    showDocumentContextMenu(document: Pick<RequirementDocument, 'path'>): Promise<void>
    onProgress(callback: EventCallback<RequirementProgress>): Unsubscribe
  }

}

const evaAPI: EvaAPI = {
  windowControls: {
    minimize: () => {
      ipcRenderer.send(IPC.WINDOW_MINIMIZE)
      return Promise.resolve()
    },
    toggleMaximize: () => {
      ipcRenderer.send(IPC.WINDOW_TOGGLE_MAXIMIZE)
      return Promise.resolve()
    },
    close: () => {
      ipcRenderer.send(IPC.WINDOW_CLOSE)
      return Promise.resolve()
    },
    version: () => ipcRenderer.invoke(IPC.WINDOW_GET_VERSION),
  },

  // 会话管理
  conversation: {
    list: () => ipcRenderer.invoke(IPC.CONVERSATION_LIST),
    create: (data) => ipcRenderer.invoke(IPC.CONVERSATION_CREATE, data),
    delete: (id) => ipcRenderer.invoke(IPC.CONVERSATION_DELETE, id),
    load: (id) => ipcRenderer.invoke(IPC.CONVERSATION_LOAD, id),
    update: (id, data) => ipcRenderer.invoke(IPC.CONVERSATION_UPDATE, id, data),
    updateMessage: (conversationId, messageId, data) => ipcRenderer.invoke(IPC.CONVERSATION_MESSAGE_UPDATE, conversationId, messageId, data),
    deleteMessagesFrom: (conversationId, messageId) => ipcRenderer.invoke(IPC.CONVERSATION_MESSAGES_DELETE_FROM, conversationId, messageId),
    continueFromHandoff: (conversationId) => ipcRenderer.invoke(IPC.CONVERSATION_CONTINUE_FROM_HANDOFF, conversationId),
    onChanged: (callback) => onStream(IPC.CONVERSATION_CHANGED, callback),
  },

  // 聊天
  chat: {
    send: (conversationId, message, agentId, images, attachments, quotedMessage) => {
      ipcRenderer.send(IPC.CHAT_SEND, { conversationId, message, agentId, images, attachments, quotedMessage })
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
    start: (conversationId, goal, resume) => {
      ipcRenderer.send(IPC.TASK_START, { conversationId, goal, resume })
      return Promise.resolve()
    },
    onStream: (callback) => onStream(IPC.TASK_STREAM, callback),
    abort: (conversationId) => {
      ipcRenderer.send(IPC.TASK_ABORT, conversationId)
      return Promise.resolve()
    },
    cancel: (conversationId) => ipcRenderer.invoke(IPC.TASK_CANCEL, conversationId),
    getStatus: (conversationId) => ipcRenderer.invoke(IPC.TASK_STATUS, conversationId),
    getSnapshot: (conversationId) => ipcRenderer.invoke(IPC.TASK_SNAPSHOT, conversationId),
    listArtifacts: (workspaceId) => ipcRenderer.invoke(IPC.TASK_ARTIFACTS_LIST, workspaceId),
    addFeedback: (conversationId, content, checkpointId, pauseAfterCurrentOperation) => ipcRenderer.invoke(IPC.TASK_FEEDBACK_ADD, { conversationId, content, checkpointId, pauseAfterCurrentOperation }),
    resumeFromCheckpoint: (conversationId) => ipcRenderer.invoke(IPC.TASK_CHECKPOINT_RESUME, conversationId),
    resume: (run) => {
      if (run.kind === 'expert') {
        ipcRenderer.send(IPC.TASK_START, { conversationId: run.conversationId, goal: run.goal, resume: true })
      } else {
        ipcRenderer.send(IPC.TASK_GOAL_START, { goal: run.goal, conversationId: run.conversationId, agentId: run.agentId, resume: true })
      }
      return Promise.resolve()
    },
  },

  // Goal 模式
  goal: {
    start: (payload) => {
      ipcRenderer.send(IPC.TASK_GOAL_START, payload)
    },
    onStream: (callback) => onStream(IPC.TASK_GOAL_STREAM, callback),
    abort: (conversationId) => {
      ipcRenderer.send(IPC.TASK_GOAL_ABORT, conversationId)
    },
    pause: (conversationId) => ipcRenderer.invoke(IPC.TASK_GOAL_PAUSE, conversationId),
    resume: (conversationId) => ipcRenderer.invoke(IPC.TASK_GOAL_RESUME, conversationId),
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
    selectFiles: () => ipcRenderer.invoke(IPC.FILE_SELECT_FILES),
    selectAttachments: () => ipcRenderer.invoke(IPC.FILE_SELECT_ATTACHMENTS),
    imagePreview: (path) => ipcRenderer.invoke(IPC.FILE_IMAGE_PREVIEW, path),
    saveClipboardImage: (input) => ipcRenderer.invoke(IPC.FILE_SAVE_CLIPBOARD_IMAGE, input),
    showContextMenu: (input) => ipcRenderer.invoke(IPC.FILE_CONTEXT_MENU, input),
    getPath: (file) => webUtils.getPathForFile(file),
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

  activity: {
    list: (filter) => ipcRenderer.invoke(IPC.ACTIVITY_LIST, filter),
    onEntry: (callback) => onStream(IPC.ACTIVITY_STREAM, callback),
  },

  workspace: {
    list: () => ipcRenderer.invoke(IPC.WORKSPACE_LIST),
    create: (path, name) => ipcRenderer.invoke(IPC.WORKSPACE_CREATE, path, name),
    update: (id, updates) => ipcRenderer.invoke(IPC.WORKSPACE_UPDATE, id, updates),
    delete: (id) => ipcRenderer.invoke(IPC.WORKSPACE_DELETE, id),
  },

  symposium: {
    start: (input) => {
      ipcRenderer.send(IPC.SYMPOSIUM_START, input)
      return Promise.resolve()
    },
    continue: (input) => {
      ipcRenderer.send(IPC.SYMPOSIUM_CONTINUE, input)
      return Promise.resolve()
    },
    abort: (conversationId) => {
      ipcRenderer.send(IPC.SYMPOSIUM_ABORT, conversationId)
      return Promise.resolve()
    },
    onStream: (callback) => onStream(IPC.SYMPOSIUM_STREAM, callback),
  },

  projectIndex: {
    status: (workspaceId) => ipcRenderer.invoke(IPC.PROJECT_INDEX_STATUS, workspaceId),
    search: (workspaceId, query, maxResults, scope) => ipcRenderer.invoke(IPC.PROJECT_INDEX_SEARCH, workspaceId, query, maxResults, scope),
    browse: (workspaceId, scope, query, offset, limit) => ipcRenderer.invoke(IPC.PROJECT_INDEX_BROWSE, workspaceId, scope, query, offset, limit),
    refresh: (workspaceId) => ipcRenderer.invoke(IPC.PROJECT_INDEX_REFRESH, workspaceId),
  },

  git: {
    status: (conversationId) => ipcRenderer.invoke(IPC.GIT_STATUS, conversationId),
    switchBranch: (conversationId, branch) => ipcRenderer.invoke(IPC.GIT_SWITCH_BRANCH, conversationId, branch),
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
    delete: (id) => ipcRenderer.invoke(IPC.PROVIDER_DELETE, id),
    test: (config) => ipcRenderer.invoke(IPC.PROVIDER_TEST, config),
    listModels: (config) => ipcRenderer.invoke(IPC.PROVIDER_MODELS, config),
  },

  runtimeProposal: {
    list: () => ipcRenderer.invoke(IPC.RUNTIME_PROPOSAL_LIST),
    decide: (id, status, decisionNote) => ipcRenderer.invoke(IPC.RUNTIME_PROPOSAL_DECIDE, id, status, decisionNote),
    beginImplementation: (id, conversationId) => ipcRenderer.invoke(IPC.RUNTIME_PROPOSAL_BEGIN_IMPLEMENTATION, id, conversationId),
  },

  runtimeKernel: {
    snapshot: () => ipcRenderer.invoke(IPC.RUNTIME_KERNEL_SNAPSHOT),
    listAudit: (limit) => ipcRenderer.invoke(IPC.RUNTIME_KERNEL_AUDIT_LIST, limit),
  },

  network: {
    getConfig: () => ipcRenderer.invoke(IPC.NETWORK_GET_CONFIG),
    saveConfig: (config) => ipcRenderer.invoke(IPC.NETWORK_SAVE_CONFIG, config),
    testConnection: (url) => ipcRenderer.invoke(IPC.NETWORK_TEST_CONNECTION, url),
  },

  activePlan: {
    get: (scopeKey) => ipcRenderer.invoke(IPC.ACTIVE_PLAN_GET, scopeKey),
  },

  modelPool: {
    list: () => ipcRenderer.invoke(IPC.MODEL_POOL_LIST),
    save: (entries) => ipcRenderer.invoke(IPC.MODEL_POOL_SAVE, entries),
    route: (request) => ipcRenderer.invoke(IPC.MODEL_POOL_ROUTE, request),
  },

  cost: {
    getUsageReport: () => ipcRenderer.invoke(IPC.COST_USAGE_REPORT),
    saveRateCards: (rateCards) => ipcRenderer.invoke(IPC.COST_RATE_CARDS_SAVE, rateCards),
    refreshSupplierRates: () => ipcRenderer.invoke(IPC.COST_RATE_CARDS_REFRESH),
  },

  qqRemote: {
    getConfig: () => ipcRenderer.invoke(IPC.QQ_REMOTE_GET_CONFIG),
    saveConfig: (config) => ipcRenderer.invoke(IPC.QQ_REMOTE_SAVE_CONFIG, config),
    getStatus: () => ipcRenderer.invoke(IPC.QQ_REMOTE_GET_STATUS),
    connect: () => ipcRenderer.invoke(IPC.QQ_REMOTE_CONNECT),
    disconnect: () => ipcRenderer.invoke(IPC.QQ_REMOTE_DISCONNECT),
  },

  plugins: {
    list: () => ipcRenderer.invoke(IPC.PLUGIN_LIST),
    marketplace: () => ipcRenderer.invoke(IPC.PLUGIN_MARKETPLACE),
    installMarketplace: (id) => ipcRenderer.invoke(IPC.PLUGIN_INSTALL_MARKETPLACE, id),
    importManifest: () => ipcRenderer.invoke(IPC.PLUGIN_IMPORT),
    setEnabled: (id, enabled) => ipcRenderer.invoke(IPC.PLUGIN_TOGGLE, id, enabled),
    remove: (id) => ipcRenderer.invoke(IPC.PLUGIN_DELETE, id),
    updateSettings: (id, settings) => ipcRenderer.invoke(IPC.PLUGIN_UPDATE_SETTINGS, id, settings),
    selectPath: (kind) => ipcRenderer.invoke(IPC.PLUGIN_SELECT_PATH, kind),
    getLocalSearxngStatus: () => ipcRenderer.invoke(IPC.PLUGIN_LOCAL_SEARXNG_STATUS),
    installLocalSearxng: () => ipcRenderer.invoke(IPC.PLUGIN_LOCAL_SEARXNG_INSTALL),
    stopLocalSearxng: () => ipcRenderer.invoke(IPC.PLUGIN_LOCAL_SEARXNG_STOP),
  },

  requirements: {
    listRuns: (conversationId) => ipcRenderer.invoke(IPC.REQUIREMENT_RUN_LIST, conversationId),
    submit: (input) => ipcRenderer.invoke(IPC.REQUIREMENT_RUN_SUBMIT, input),
    answer: (input) => ipcRenderer.invoke(IPC.REQUIREMENT_CLARIFICATION_ANSWER, input),
    model: (input) => ipcRenderer.invoke(IPC.REQUIREMENT_MODELING_SUBMIT, input),
    spec: (input) => ipcRenderer.invoke(IPC.REQUIREMENT_SPECIFICATION_SUBMIT, input),
    dsl: (input) => ipcRenderer.invoke(IPC.REQUIREMENT_DSL_SUBMIT, input),
    coding: (input) => ipcRenderer.invoke(IPC.REQUIREMENT_CODING_SUBMIT, input),
    resolveSpec: (input) => ipcRenderer.invoke(IPC.REQUIREMENT_SPECIFICATION_RESOLUTION, input),
    abort: (conversationId) => ipcRenderer.invoke(IPC.REQUIREMENT_RUN_ABORT, conversationId),
    showDocumentContextMenu: (document) => ipcRenderer.invoke(IPC.REQUIREMENT_DOCUMENT_CONTEXT_MENU, document),
    onProgress: (callback) => onStream(IPC.REQUIREMENT_PROGRESS, callback),
  },

}

contextBridge.exposeInMainWorld('eva', evaAPI)
