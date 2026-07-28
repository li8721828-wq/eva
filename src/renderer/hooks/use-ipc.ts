import { useCallback, useEffect, useRef } from 'react'

/**
 * Hook for invoking IPC calls with loading/error state management.
 */
export function useIpcInvoke<T = unknown>(
  channel: string,
  ...args: unknown[]
): {
  invoke: () => Promise<T | null>
  isLoading: boolean
} {
  const isLoadingRef = useRef(false)

  const invoke = useCallback(async (): Promise<T | null> => {
    try {
      isLoadingRef.current = true
      // Dynamic import to avoid circular dependencies
      const { ipc } = await import('@/lib/ipc-client')
      const result = await (window.eva as any)[channel]?.(...args)
      return result as T
    } catch (err) {
      console.error(`IPC invoke error [${channel}]:`, err)
      return null
    } finally {
      isLoadingRef.current = false
    }
  }, [channel, ...args])

  return { invoke, isLoading: isLoadingRef.current }
}

/**
 * Hook for listening to IPC events from the main process.
 * Automatically cleans up on unmount.
 */
export function useIpcOn<T = unknown>(
  subscribe: (callback: (event: any, data: T) => void) => () => void,
  callback: (data: T) => void
): void {
  const callbackRef = useRef(callback)
  callbackRef.current = callback

  useEffect(() => {
    const cleanup = subscribe((_event, data) => {
      callbackRef.current(data)
    })
    return cleanup
  }, [subscribe])
}
