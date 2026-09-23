import { trustedIpcMain as ipcMain } from './trusted-ipc'
import { IPC } from '../../shared/ipc-channels'
import type { LongTermMemoryScope, UpdateLongTermMemoryInput } from '../../shared/types/long-term-memory'
import { getStorage } from '../storage'

export function registerLongTermMemoryHandlers(): void {
  ipcMain.handle(IPC.LONG_TERM_MEMORY_LIST, async (_event, scope?: { scope?: LongTermMemoryScope; scopeId?: string }) => {
    return getStorage().longTermMemory.list(scope)
  })

  ipcMain.handle(IPC.LONG_TERM_MEMORY_SEARCH, async (_event, query: string, scopes: Array<{ scope: LongTermMemoryScope; scopeId: string }>, limit?: number) => {
    return getStorage().longTermMemory.search(query, scopes, limit)
  })

  ipcMain.handle(IPC.LONG_TERM_MEMORY_UPDATE, async (_event, id: string, input: UpdateLongTermMemoryInput) => {
    return getStorage().longTermMemory.update(id, input)
  })

  ipcMain.handle(IPC.LONG_TERM_MEMORY_DELETE, async (_event, id: string) => {
    return getStorage().longTermMemory.remove(id)
  })
}
