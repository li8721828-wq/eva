import type { Conversation } from './types/conversation'

type Access = Pick<Conversation, 'permissionLevel' | 'accessScope' | 'fileAccessGrants'>

/** Compare effective access, not object identity or the ordering of folder grants. */
export function conversationPermissionsChanged(previous: Access, update: Partial<Access>): boolean {
  const key = (value: Access): string => JSON.stringify({
    permission: value.permissionLevel || (value.accessScope === 'full' ? 'full-access' : 'workspace'),
    grants: (value.fileAccessGrants || []).map(grant => `${grant.path}\0${grant.access}`).sort(),
  })
  return key(previous) !== key({ ...previous, ...update })
}
