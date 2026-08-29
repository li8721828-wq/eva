import { trustedIpcMain as ipcMain } from './trusted-ipc'
import { IPC } from '../../shared/ipc-channels'
import type { McpServerConfig, McpServerState } from '../../shared/types/mcp'
import type { McpClientManager } from '../services/mcp-client-manager'
import { getStorage } from '../storage'

export function registerMcpHandlers(manager: McpClientManager): void {
  ipcMain.handle(IPC.MCP_LIST, async (): Promise<McpServerState[]> => manager.listStates())
  ipcMain.handle(IPC.MCP_SAVE, async (_event, config: McpServerConfig): Promise<McpServerState[]> => {
    getStorage().mcpServers.upsert(config)
    return manager.reconcile()
  })
  ipcMain.handle(IPC.MCP_DELETE, async (_event, id: string): Promise<McpServerState[]> => {
    getStorage().mcpServers.remove(id)
    return manager.reconcile()
  })
  ipcMain.handle(IPC.MCP_TOGGLE, async (_event, id: string, enabled: boolean): Promise<McpServerState[]> => {
    getStorage().mcpServers.setEnabled(id, enabled)
    return manager.reconcile()
  })
  ipcMain.handle(IPC.MCP_RECONNECT, async (_event, id?: string): Promise<McpServerState[]> => manager.reconnect(id))
}
