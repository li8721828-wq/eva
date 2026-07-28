import { create } from 'zustand'
import type { ActivityLogEntry } from '../../shared/types/activity'

interface ActivityLogState {
  entries: ActivityLogEntry[]
  isLoading: boolean
  loadEntries: () => Promise<void>
  appendEntry: (entry: ActivityLogEntry) => void
}

export const useActivityLogStore = create<ActivityLogState>((set) => ({
  entries: [],
  isLoading: false,

  loadEntries: async () => {
    set({ isLoading: true })
    try {
      const entries = await window.eva.activity.list({ limit: 250 })
      set({ entries })
    } catch (error) {
      console.error('Failed to load activity log:', error)
    } finally {
      set({ isLoading: false })
    }
  },

  appendEntry: (entry) => {
    set((state) => {
      if (state.entries.some((existing) => existing.id === entry.id)) return state
      return { entries: [entry, ...state.entries].slice(0, 250) }
    })
  },
}))
