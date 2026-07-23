export type FileAccessLevel = 'read' | 'read-write'

export interface FileAccessGrant {
  path: string
  access: FileAccessLevel
}
