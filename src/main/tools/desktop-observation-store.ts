import { randomUUID } from 'crypto'

export interface DesktopObservation {
  id: string
  observedAt: number
  activeWindow: {
    handle: number
    title: string
    process: string
    processId: number
    bounds: { left: number; top: number; width: number; height: number }
  }
}

const OBSERVATION_TTL_MS = 15_000
const observations = new Map<string, DesktopObservation>()

export function storeDesktopObservation(snapshot: Omit<DesktopObservation, 'id' | 'observedAt'>): DesktopObservation {
  const observation: DesktopObservation = {
    id: `desktop_${randomUUID()}`,
    observedAt: Date.now(),
    ...snapshot,
  }
  observations.set(observation.id, observation)
  pruneExpiredObservations()
  return observation
}

export function getFreshDesktopObservation(id: unknown): DesktopObservation {
  if (typeof id !== 'string' || !id) {
    throw new Error('observationId is required. Call desktop_observe first, then act only on that visible desktop state.')
  }
  const observation = observations.get(id)
  if (!observation) throw new Error('The desktop observation is unavailable. Observe the visible desktop again before acting.')
  if (Date.now() - observation.observedAt > OBSERVATION_TTL_MS) {
    observations.delete(id)
    throw new Error('The desktop observation has expired after 15 seconds. Observe again before acting.')
  }
  return observation
}

function pruneExpiredObservations(): void {
  const threshold = Date.now() - OBSERVATION_TTL_MS
  for (const [id, observation] of observations) {
    if (observation.observedAt < threshold) observations.delete(id)
  }
}
