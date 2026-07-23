import type { EvaAPI } from '../../preload/index'

declare global {
  interface Window {
    eva: EvaAPI
  }
}

/**
 * Typed IPC client for renderer process.
 * Wraps window.eva with type safety and convenience methods.
 */
export const ipc: EvaAPI = window.eva
