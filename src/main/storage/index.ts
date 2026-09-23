import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import { ConfigStore } from './config-store'
import { ConversationStore } from './conversation-store'
import { AgentStore } from './agent-store'
import { WorkspaceStore } from './workspace-store'
import { ActivityLogStore } from './activity-log-store'
import { QqRemoteStore } from './qq-remote-store'
import { PluginStore } from './plugin-store'
import { TaskRunStore } from './task-run-store'
import { ProjectIndexStore } from './project-index-store'
import { RuntimeProposalStore } from './runtime-proposal-store'
import { RuntimeKernelStore } from './runtime-kernel-store'
import { RuntimeMemoryStore } from './runtime-memory-store'
import { RuntimeRunStore } from './runtime-run-store'
import { ActivePlanStore } from './active-plan-store'
import { McpServerStore } from './mcp-server-store'
import { PersonalPreferenceStore } from './personal-preference-store'
import { AgentRunEventStore } from './agent-run-event-store'
import { ProjectKnowledgeStore } from './project-knowledge-store'
import { LongTermMemoryStore } from './long-term-memory-store'
import { MemoryAgentQueueStore } from './memory-agent-queue-store'
import type { LongTermMemoryEvidence } from '../../shared/types/long-term-memory'

export class StorageManager {
  config: ConfigStore
  conversations: ConversationStore
  agents: AgentStore
  workspaces: WorkspaceStore
  activity: ActivityLogStore
  qqRemote: QqRemoteStore
  plugins: PluginStore
  taskRuns: TaskRunStore
  projectIndexes: ProjectIndexStore
  runtimeProposals: RuntimeProposalStore
  runtimeKernel: RuntimeKernelStore
  runtimeMemory: RuntimeMemoryStore
  runtimeRuns: RuntimeRunStore
  activePlans: ActivePlanStore
  mcpServers: McpServerStore
  personalPreferences: PersonalPreferenceStore
  agentRunEvents: AgentRunEventStore
  projectKnowledge: ProjectKnowledgeStore
  longTermMemory: LongTermMemoryStore
  memoryAgentQueue: MemoryAgentQueueStore

  private userDataPath: string

  constructor() {
    this.userDataPath = app.getPath('userData')
    this.config = new ConfigStore()
    this.conversations = new ConversationStore(
      path.join(this.userDataPath, 'conversations')
    )
    this.agents = new AgentStore(path.join(this.userDataPath, 'agents'))
    this.workspaces = new WorkspaceStore(this.userDataPath)
    this.activity = new ActivityLogStore(this.userDataPath)
    this.qqRemote = new QqRemoteStore()
    this.plugins = new PluginStore()
    this.taskRuns = new TaskRunStore(this.userDataPath)
    this.projectIndexes = new ProjectIndexStore(this.userDataPath)
    this.runtimeProposals = new RuntimeProposalStore(this.userDataPath)
    this.runtimeKernel = new RuntimeKernelStore(this.userDataPath)
    this.runtimeMemory = new RuntimeMemoryStore(this.userDataPath)
    this.runtimeRuns = new RuntimeRunStore(this.userDataPath)
    this.activePlans = new ActivePlanStore(this.userDataPath)
    this.mcpServers = new McpServerStore()
    this.personalPreferences = new PersonalPreferenceStore()
    this.agentRunEvents = new AgentRunEventStore(this.userDataPath)
    this.projectKnowledge = new ProjectKnowledgeStore(this.userDataPath)
    this.longTermMemory = new LongTermMemoryStore(this.userDataPath)
    this.memoryAgentQueue = new MemoryAgentQueueStore(this.userDataPath)
  }

  async initialize(): Promise<void> {
    // Ensure data directories exist
    const dirs = [
      path.join(this.userDataPath, 'conversations'),
      path.join(this.userDataPath, 'agents'),
    ]
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    }

    // Initialize built-in agents on first launch
    await this.agents.initializeBuiltInAgents()
    // Repair stale built-in bindings (for example OpenAI/gpt-4o after the
    // user switched to an enabled OpenAI-compatible connection). This keeps
    // diagnostics and non-chat entry points aligned with the real route while
    // leaving custom Agent overrides untouched.
    const enabledProviderIds = new Set(this.config.getProviders().filter((provider) => provider.isEnabled && provider.apiKey).map((provider) => provider.id))
    await this.agents.alignBuiltInConnections(this.config.get('activeProviderId'), this.config.getActiveModel(), enabledProviderIds)
    await this.taskRuns.markRunningAsInterrupted()
    await this.conversations.markRunningAsInterrupted()
    await this.runtimeKernel.markActiveAsInterrupted()
    await this.runtimeRuns.markActiveAsInterrupted()
    await this.migrateLegacyLongTermMemory()

    // Preserve the pre-project single workspace as the first project workspace.
    const legacyWorkspacePath = this.config.get('workspacePath')
    if (legacyWorkspacePath && (await this.workspaces.list()).length === 0) {
      await this.workspaces.create(legacyWorkspacePath)
    }
  }

  private async migrateLegacyLongTermMemory(): Promise<void> {
    const existing = await this.longTermMemory.list()
    if (existing.some((memory) => memory.sourceKey.startsWith('legacy:'))) return

    const preferences = this.personalPreferences.list()
    for (const preference of preferences) {
      await this.longTermMemory.upsert({
        sourceKey: `legacy:preference:${preference.id}`,
        scope: 'user',
        scopeId: 'default',
        kind: 'preference',
        title: preference.polarity === 'avoid' ? `避免：${preference.statement}` : `偏好：${preference.statement}`,
        content: preference.statement,
        tags: [preference.category, preference.polarity],
        confidence: preference.confidence,
        importance: preference.durability === 'established' ? 0.8 : 0.55,
        evidence: [{
          conversationId: 'legacy-preferences',
          summary: preference.evidenceSummary || 'Migrated from the legacy personal preference store.',
          recordedAt: preference.updatedAt,
        }],
      })
    }

    const projectEntries = await this.projectKnowledge.list()
    for (const entry of projectEntries) {
      const scopeId = entry.workspaceId
        ? `workspace:${entry.workspaceId}`
        : entry.workspacePath
          ? `workspace-path:${entry.workspacePath.replace(/\\/g, '/').toLowerCase()}`
          : undefined
      if (!scopeId) continue
      const details = [
        entry.summary,
        entry.rootCause ? `根因：${entry.rootCause}` : '',
        entry.resolution ? `处理：${entry.resolution}` : '',
        entry.verification ? `验证：${entry.verification}` : '',
        entry.regressionGuard ? `回归守则：${entry.regressionGuard}` : '',
      ].filter(Boolean).join('\n')
      const evidence: LongTermMemoryEvidence = {
        conversationId: entry.conversationId || 'legacy-project-knowledge',
        summary: entry.verification || 'Migrated from the legacy project knowledge store.',
        recordedAt: entry.updatedAt,
      }
      await this.longTermMemory.upsert({
        sourceKey: `legacy:project:${entry.id}`,
        scope: 'project',
        scopeId,
        kind: entry.kind === 'bug' ? 'bug' : entry.kind === 'direction' ? 'constraint' : entry.kind === 'decision' ? 'decision' : 'fact',
        status: entry.status === 'superseded' ? 'superseded' : 'active',
        title: entry.title,
        content: details,
        tags: entry.tags,
        confidence: entry.status === 'resolved' ? 0.85 : 0.65,
        importance: entry.regressionGuard ? 0.85 : 0.6,
        evidence: [evidence],
      })
    }
  }
}

// Global singleton
export let storageManager: StorageManager

export async function initializeStorage(): Promise<StorageManager> {
  storageManager = new StorageManager()
  await storageManager.initialize()
  return storageManager
}

export function getStorage(): StorageManager {
  if (!storageManager) {
    throw new Error('Storage not initialized. Call initializeStorage() first.')
  }
  return storageManager
}
