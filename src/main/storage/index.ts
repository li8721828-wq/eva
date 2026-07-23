import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import { ConfigStore } from './config-store'
import { ConversationStore } from './conversation-store'
import { AgentStore } from './agent-store'
import { WorkspaceStore } from './workspace-store'

export class StorageManager {
  config: ConfigStore
  conversations: ConversationStore
  agents: AgentStore
  workspaces: WorkspaceStore

  private userDataPath: string

  constructor() {
    this.userDataPath = app.getPath('userData')
    this.config = new ConfigStore()
    this.conversations = new ConversationStore(
      path.join(this.userDataPath, 'conversations')
    )
    this.agents = new AgentStore(path.join(this.userDataPath, 'agents'))
    this.workspaces = new WorkspaceStore(this.userDataPath)
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

    // Preserve the pre-project single workspace as the first project workspace.
    const legacyWorkspacePath = this.config.get('workspacePath')
    if (legacyWorkspacePath && (await this.workspaces.list()).length === 0) {
      await this.workspaces.create(legacyWorkspacePath)
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
