export type ActivityCategory = 'agent' | 'tool' | 'file' | 'terminal' | 'permission' | 'conversation' | 'system'

export type ActivityStatus = 'info' | 'success' | 'error'

export interface ActivityLogEntry {
  id: string
  timestamp: number
  category: ActivityCategory
  action: string
  status: ActivityStatus
  summary: string
  conversationId?: string
  workspaceId?: string
}

export interface ActivityLogFilter {
  conversationId?: string
  workspaceId?: string
  limit?: number
}

export type CreateActivityLogEntry = Omit<ActivityLogEntry, 'id' | 'timestamp'> & {
  timestamp?: number
}
