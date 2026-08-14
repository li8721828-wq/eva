import type { ActivityCategory, ActivityLogEntry } from '../../shared/types/activity'

export function summarizeRuntimeActivity(entries: ActivityLogEntry[]): {
  errors: number
  byCategory: Partial<Record<ActivityCategory, number>>
} {
  return entries.reduce<{ errors: number; byCategory: Partial<Record<ActivityCategory, number>> }>((summary, entry) => {
    summary.byCategory[entry.category] = (summary.byCategory[entry.category] || 0) + 1
    if (entry.status === 'error') summary.errors += 1
    return summary
  }, { errors: 0, byCategory: {} })
}
