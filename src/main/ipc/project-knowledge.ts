import { trustedIpcMain as ipcMain } from './trusted-ipc'
import { IPC } from '../../shared/ipc-channels'
import type { ProjectKnowledgeScope, ProjectKnowledgeStatus } from '../../shared/types/project-knowledge'
import { getStorage } from '../storage'

export function registerProjectKnowledgeHandlers(): void {
  ipcMain.handle(IPC.PROJECT_KNOWLEDGE_LIST, async (_event, scope?: ProjectKnowledgeScope) => {
    return getStorage().projectKnowledge.list(scope)
  })

  ipcMain.handle(IPC.PROJECT_KNOWLEDGE_SEARCH, async (_event, scope: ProjectKnowledgeScope, query: string, limit?: number) => {
    return getStorage().projectKnowledge.search(scope, query, limit)
  })

  ipcMain.handle(IPC.PROJECT_KNOWLEDGE_UPDATE, async (_event, scope: ProjectKnowledgeScope, id: string, status: ProjectKnowledgeStatus) => {
    return getStorage().projectKnowledge.updateStatus(scope, id, status)
  })

  ipcMain.handle(IPC.PROJECT_KNOWLEDGE_DELETE, async (_event, scope: ProjectKnowledgeScope, id: string) => {
    return getStorage().projectKnowledge.remove(scope, id)
  })
}
