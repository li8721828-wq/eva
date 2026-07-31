import { create } from 'zustand'
import type { SymposiumStreamEvent } from '../../shared/types/symposium'

export interface SymposiumRuntime {
  status: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed'
  agentId?: string
  agentName?: string
  cycle?: number
  participantCount?: number
  error?: string
}

interface SymposiumState {
  runtimes: Record<string, SymposiumRuntime>
  handleEvent: (event: SymposiumStreamEvent) => void
}

export const useSymposiumStore = create<SymposiumState>((set) => ({
  runtimes: {},
  handleEvent: (event) => set((state) => {
    const current = state.runtimes[event.conversationId] || { status: 'idle' as const }
    const next: SymposiumRuntime = {
      ...current,
      agentId: event.agentId ?? current.agentId,
      agentName: event.agentName ?? current.agentName,
      cycle: event.cycle ?? current.cycle,
      participantCount: event.participantCount ?? current.participantCount,
      error: event.error,
      status: event.type === 'started' || event.type === 'speaker_started' || event.type === 'speaker_completed'
        ? 'running'
        : event.type === 'completed'
          ? 'completed'
          : event.type === 'cancelled'
            ? 'cancelled'
            : event.type === 'error'
              ? 'failed'
              : current.status,
    }
    return { runtimes: { ...state.runtimes, [event.conversationId]: next } }
  }),
}))
