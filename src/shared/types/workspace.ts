import type { FileAccessGrant } from './file-access'

export type WorkspacePermissionLevel = 'workspace' | 'granted-folders' | 'full-access'

export interface Workspace {
  id: string
  name: string
  path: string
  permissionLevel: WorkspacePermissionLevel
  fileAccessGrants: FileAccessGrant[]
  createdAt: number
  updatedAt: number
}
