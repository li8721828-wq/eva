import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { getStorage } from '../storage'
import type { Workspace } from '../../shared/types/workspace'
import fs from 'fs'
import type { ProjectIndexService } from '../services/project-index-service'
import type { ProjectIndexCatalogPage, ProjectIndexScope, ProjectIndexSearchResult, ProjectIndexSnapshot, ProjectIndexStatus } from '../../shared/types/project-index'

export function registerWorkspaceHandlers(projectIndexService?: ProjectIndexService): void {
  ipcMain.handle(IPC.WORKSPACE_LIST, async (): Promise<Workspace[]> => {
    return getStorage().workspaces.list()
  })

  ipcMain.handle(IPC.WORKSPACE_CREATE, async (_event, path: string, name?: string): Promise<Workspace> => {
    if (!path || !fs.existsSync(path) || !fs.statSync(path).isDirectory()) {
      throw new Error('Please choose a folder to create a project workspace.')
    }
    const workspace = await getStorage().workspaces.create(path, name)
    if (projectIndexService) {
      void projectIndexService.indexWorkspace(workspace).then(() => projectIndexService.watchWorkspace(workspace))
    }
    return workspace
  })

  ipcMain.handle(
    IPC.WORKSPACE_UPDATE,
    async (_event, id: string, updates: Partial<Workspace>): Promise<Workspace> => {
      return getStorage().workspaces.update(id, updates)
    }
  )

  ipcMain.handle(
    IPC.PROJECT_INDEX_BROWSE,
    async (_event, workspaceId: string, scope?: ProjectIndexScope, query?: string, offset?: number, limit?: number): Promise<ProjectIndexCatalogPage> => {
      if (!projectIndexService) throw new Error('Project index service is unavailable')
      return projectIndexService.browse(workspaceId, scope, query, offset, limit)
    }
  )

  ipcMain.handle(IPC.WORKSPACE_DELETE, async (_event, id: string): Promise<void> => {
    projectIndexService?.stopWatching(id)
    await getStorage().projectIndexes.delete(id)
    await getStorage().workspaces.delete(id)
  })

  ipcMain.handle(IPC.PROJECT_INDEX_STATUS, async (_event, workspaceId: string): Promise<ProjectIndexStatus> => {
    if (!projectIndexService) throw new Error('Project index service is unavailable')
    return projectIndexService.getStatus(workspaceId)
  })

  ipcMain.handle(
    IPC.PROJECT_INDEX_SEARCH,
    async (_event, workspaceId: string, query: string, maxResults?: number, scope?: ProjectIndexScope): Promise<ProjectIndexSearchResult[]> => {
      if (!projectIndexService) throw new Error('Project index service is unavailable')
      return projectIndexService.search(workspaceId, query, maxResults, scope)
    }
  )

  ipcMain.handle(IPC.PROJECT_INDEX_REFRESH, async (_event, workspaceId: string): Promise<ProjectIndexSnapshot> => {
    if (!projectIndexService) throw new Error('Project index service is unavailable')
    return projectIndexService.refreshWorkspace(workspaceId)
  })
}
