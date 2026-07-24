import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { getStorage } from '../storage'
import type { Workspace } from '../../shared/types/workspace'
import fs from 'fs'

export function registerWorkspaceHandlers(): void {
  ipcMain.handle(IPC.WORKSPACE_LIST, async (): Promise<Workspace[]> => {
    return getStorage().workspaces.list()
  })

  ipcMain.handle(IPC.WORKSPACE_CREATE, async (_event, path: string, name?: string): Promise<Workspace> => {
    if (!path || !fs.existsSync(path) || !fs.statSync(path).isDirectory()) {
      throw new Error('Please choose a folder to create a project workspace.')
    }
    return getStorage().workspaces.create(path, name)
  })

  ipcMain.handle(
    IPC.WORKSPACE_UPDATE,
    async (_event, id: string, updates: Partial<Workspace>): Promise<Workspace> => {
      return getStorage().workspaces.update(id, updates)
    }
  )

  ipcMain.handle(IPC.WORKSPACE_DELETE, async (_event, id: string): Promise<void> => {
    await getStorage().workspaces.delete(id)
  })
}
