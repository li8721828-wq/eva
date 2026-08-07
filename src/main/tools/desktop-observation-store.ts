import { randomUUID } from 'crypto'

export interface DesktopBounds {
  left: number
  top: number
  width: number
  height: number
}

export interface DesktopControl {
  name: string
  role: string
  automationId: string
  surface?: 'foreground' | 'taskbar'
  enabled: boolean
  focused: boolean
  password: boolean
  bounds: DesktopBounds
}

export interface DesktopDialog {
  title: string
  bounds: DesktopBounds
  controls: DesktopControl[]
}

export interface DesktopObservation {
  id: string
  observedAt: number
  activeWindow: {
    handle: number
    title: string
    process: string
    processId: number
    bounds: DesktopBounds
  }
  controls?: DesktopControl[]
  priorityControls?: DesktopControl[]
  dialog?: DesktopDialog
  taskbar?: {
    bounds: DesktopBounds
    controls: DesktopControl[]
  }
  controlCount?: number
  truncated?: boolean
}

export type DesktopSessionState = 'active' | 'paused' | 'stopped' | 'completed' | 'expired'

export interface DesktopSessionStep {
  at: number
  kind: 'observe' | 'action' | 'verification' | 'note'
  summary: string
  observationId?: string
  verified?: boolean
}

export interface DesktopControlSession {
  id: string
  conversationId: string
  objective: string
  state: DesktopSessionState
  createdAt: number
  updatedAt: number
  expiresAt: number
  stepBudget: number
  steps: DesktopSessionStep[]
}

const OBSERVATION_TTL_MS = 15_000
const SESSION_TTL_MS = 30 * 60_000
const DEFAULT_STEP_BUDGET = 100
const observations = new Map<string, DesktopObservation>()
const sessions = new Map<string, DesktopControlSession>()

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

export function startDesktopControlSession(
  conversationId: string | undefined,
  objective: unknown,
  stepBudget: unknown,
): DesktopControlSession {
  const normalizedObjective = typeof objective === 'string' ? objective.trim() : ''
  if (!normalizedObjective) throw new Error('objective is required to start a desktop control session.')
  const budget = normalizeStepBudget(stepBudget)
  const now = Date.now()
  const session: DesktopControlSession = {
    id: `desktop_session_${randomUUID()}`,
    conversationId: conversationId || 'global',
    objective: normalizedObjective.slice(0, 500),
    state: 'active',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + SESSION_TTL_MS,
    stepBudget: budget,
    steps: [],
  }
  sessions.set(session.id, session)
  pruneExpiredSessions()
  return session
}

export function getDesktopControlSession(id: unknown, conversationId?: string): DesktopControlSession {
  if (typeof id !== 'string' || !id) throw new Error('sessionId is required.')
  const session = sessions.get(id)
  if (!session) throw new Error('The desktop control session is unavailable. Start a new session to continue.')
  if (session.conversationId !== (conversationId || 'global')) {
    throw new Error('This desktop control session belongs to a different conversation.')
  }
  expireSessionIfNeeded(session)
  return session
}

export function setDesktopControlSessionState(
  id: unknown,
  conversationId: string | undefined,
  state: Extract<DesktopSessionState, 'active' | 'paused' | 'stopped' | 'completed'>,
): DesktopControlSession {
  const session = getDesktopControlSession(id, conversationId)
  if (session.state === 'expired') throw new Error('The desktop control session has expired. Start a new session.')
  session.state = state
  session.updatedAt = Date.now()
  return session
}

export function requireActiveDesktopControlSession(id: unknown, conversationId?: string): DesktopControlSession {
  const session = getDesktopControlSession(id, conversationId)
  if (session.state !== 'active') {
    throw new Error(`The desktop control session is ${session.state}. Resume or start a session before acting.`)
  }
  if (session.steps.filter((step) => step.kind === 'action').length >= session.stepBudget) {
    session.state = 'paused'
    session.updatedAt = Date.now()
    throw new Error(`The desktop control session reached its ${session.stepBudget}-action budget and was paused. Review the result, then resume it explicitly.`)
  }
  return session
}

export function recordDesktopControlStep(
  id: string | undefined,
  conversationId: string | undefined,
  step: Omit<DesktopSessionStep, 'at'>,
): DesktopControlSession | undefined {
  if (!id) return undefined
  const session = getDesktopControlSession(id, conversationId)
  if (session.state === 'expired') return session
  session.steps.push({ ...step, at: Date.now() })
  session.steps = session.steps.slice(-100)
  session.updatedAt = Date.now()
  return session
}

export function toDesktopSessionSummary(session: DesktopControlSession): Record<string, unknown> {
  return {
    sessionId: session.id,
    objective: session.objective,
    state: session.state,
    stepBudget: session.stepBudget,
    actionsUsed: session.steps.filter((step) => step.kind === 'action').length,
    expiresAt: new Date(session.expiresAt).toISOString(),
    recentSteps: session.steps.slice(-8),
  }
}

function normalizeStepBudget(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_STEP_BUDGET
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error('stepBudget must be a number.')
  return Math.max(1, Math.min(100, Math.round(parsed)))
}

function expireSessionIfNeeded(session: DesktopControlSession): void {
  if (session.state === 'active' || session.state === 'paused') {
    if (Date.now() > session.expiresAt) {
      session.state = 'expired'
      session.updatedAt = Date.now()
    }
  }
}

function pruneExpiredSessions(): void {
  const threshold = Date.now() - SESSION_TTL_MS
  for (const [id, session] of sessions) {
    expireSessionIfNeeded(session)
    if (session.updatedAt < threshold && (session.state === 'expired' || session.state === 'stopped' || session.state === 'completed')) {
      sessions.delete(id)
    }
  }
}
