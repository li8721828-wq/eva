import { create } from 'zustand'

/**
 * Lightweight, app-wide notification system. Toasts are queued in the
 * `useToastStore` and rendered by the global `ToastViewport`. The viewport is
 * mounted once near the app root, so individual components just dispatch
 * `pushToast` without owning any state.
 *
 * Kinds:
 *  - `info` / `success` / `warning` / `error` are the four semantic levels.
 *  - `actions` lets the caller add buttons (e.g. retry) on the right edge.
 *  - `dismissable: false` keeps the toast visible until the caller clears it
 *    (used by destructive confirmations that need an explicit user choice).
 */
export type ToastKind = 'info' | 'success' | 'warning' | 'error'

export interface ToastAction {
  label: string
  onClick: () => void
  /** `primary` paints the button in the accent color, otherwise neutral. */
  variant?: 'primary' | 'neutral'
}

export interface ToastEntry {
  id: string
  kind: ToastKind
  title: string
  description?: string
  /** Action buttons rendered below the title/description. */
  actions?: ToastAction[]
  /** Hide after `durationMs`. Set to `0` to require manual dismissal. */
  durationMs: number
  /** Allow the user to close the toast by clicking it. */
  dismissable: boolean
  createdAt: number
}

interface ToastState {
  toasts: ToastEntry[]
  push: (entry: Omit<ToastEntry, 'id' | 'createdAt' | 'durationMs' | 'dismissable'> & {
    durationMs?: number
    dismissable?: boolean
  }) => string
  dismiss: (id: string) => void
  clear: () => void
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

const DEFAULT_DURATION_MS = 4200

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (entry) => {
    const id = generateId()
    const toast: ToastEntry = {
      id,
      kind: entry.kind,
      title: entry.title,
      description: entry.description,
      actions: entry.actions,
      durationMs: entry.durationMs ?? DEFAULT_DURATION_MS,
      dismissable: entry.dismissable ?? true,
      createdAt: Date.now(),
    }
    set((s) => {
      // Cap the visible stack at 5; older entries drop off automatically.
      const toasts = s.toasts.length >= 5 ? s.toasts.slice(s.toasts.length - 4) : s.toasts.slice()
      toasts.push(toast)
      return { toasts }
    })
    return id
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((toast) => toast.id !== id) })),
  clear: () => set({ toasts: [] }),
}))

export function pushToast(entry: Parameters<ToastState['push']>[0]): string {
  return useToastStore.getState().push(entry)
}
