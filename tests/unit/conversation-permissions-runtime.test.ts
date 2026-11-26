import { afterEach, describe, expect, it, vi } from 'vitest'
import { activeRunRegistry } from '../../src/main/services/run-registry'
import { createLocalExecutionPolicy, executionApproval } from '../../src/main/services/execution-policy'
import { ToolRegistry } from '../../src/main/tools'
import { ToolDispatcher } from '../../src/main/services/tool-dispatcher'
import { NativeToolPolicy } from '../../src/main/agent-engine/native-tool-policy'
import { registerConversationHandlers } from '../../src/main/ipc/conversation'
import { IPC } from '../../src/shared/ipc-channels'

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  events: [] as any[],
  scheduler: { cancelInteractive: vi.fn(async () => false), cancelTask: vi.fn(async () => false) },
}))
vi.mock('../../src/main/ipc/trusted-ipc', () => ({ trustedIpcMain: {
  handle: (channel: string, handler: (...args: any[]) => any) => harness.handlers.set(channel, handler), on: vi.fn(),
} }))
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_channel: string, event: any) => harness.events.push(event) } }] } }))
vi.mock('../../src/main/services/agent-os-scheduler', () => ({ getAgentOsScheduler: () => harness.scheduler }))
vi.mock('../../src/main/services/activity-log', () => ({ recordActivity: vi.fn() }))
vi.mock('../../src/main/services/supplier-pricing-service', () => ({ ensureProviderPricing: vi.fn() }))
vi.mock('../../src/main/services/usage-pricing-service', () => ({ hydrateUsagePricing: vi.fn() }))

afterEach(() => {
  activeRunRegistry.clearConversation('permission-runtime')
  activeRunRegistry.clearConversation('unrelated-runtime')
  vi.useRealTimers()
})

describe('desktop permission change during a real pending authorization', () => {
  it.each(['eva', 'pi', 'deepseek-harness'] as const)('%s cancels old authorization and the next request uses full access', async (engine) => {
    vi.useFakeTimers()
    harness.events.length = 0
    const conversationId = 'permission-runtime'
    let conversation: any = { id: conversationId, permissionLevel: 'workspace', fileAccessGrants: [] }
    registerConversationHandlers({ storage: { conversations: {
      getConversation: async () => conversation,
      updateConversation: async (_id: string, data: any) => { conversation = { ...conversation, ...data } },
    } } } as any)
    const controller = new AbortController()
    const abort = vi.fn(() => controller.abort())
    const unrelated = vi.fn()
    activeRunRegistry.set('chat', conversationId, { abort })
    activeRunRegistry.set('chat', 'unrelated-runtime', { abort: unrelated })
    const window = { isDestroyed: () => false, webContents: { send: (_channel: string, event: any) => harness.events.push(event) } } as any
    const registry = new ToolRegistry()
    const execute = vi.fn(async () => 'written')
    registry.register({ definition: { name: 'write_file', description: '', parameters: { type: 'object' } }, execute })
    const authorize = (signal: AbortSignal) => {
      const local = createLocalExecutionPolicy({ toolApproval: { policy: 'safe', timeoutMs: 60000 } }, { conversationId, conversation, window })
      const approve = executionApproval(local)
      if (engine === 'eva') return new ToolDispatcher({ toolRegistry: registry, agentTools: ['write_file'], requestToolApproval: approve }).dispatch({
        id: 'write', name: 'write_file', arguments: { path: 'specs/example.md', content: 'test' }, signal,
        context: { workspacePath: process.cwd(), fullFilesystemAccess: conversation.permissionLevel === 'full-access' } as any,
      })
      return new NativeToolPolicy({ engine, allowedTools: ['write_file'], workspacePath: process.cwd(), sandbox: null, signal, approve })
        .authorize({ id: 'write', name: 'write', arguments: { [engine === 'pi' ? 'path' : 'file_path']: 'specs/example.md', content: 'test' } })
    }
    // Attach both handlers immediately so cancellation cannot produce an unhandled rejection.
    const pending = authorize(controller.signal).then(value => ({ value }), error => ({ error }))
    await vi.waitFor(() => expect(harness.events.some(event => event.type === 'tool_approval_request')).toBe(true))
    await harness.handlers.get(IPC.CONVERSATION_UPDATE)!({}, conversationId, { permissionLevel: 'full-access' })
    expect(abort).toHaveBeenCalledOnce()
    expect(unrelated).not.toHaveBeenCalled()
    expect(controller.signal.aborted).toBe(true)
    await pending
    expect(execute).not.toHaveBeenCalled()
    expect(harness.events.some(event => event.type === 'permissions_changed')).toBe(true)
    expect(harness.events.some(event => event.type === 'tool_approval_closed')).toBe(true)
    const approvals = harness.events.filter(event => event.type === 'tool_approval_request').length
    await authorize(new AbortController().signal)
    expect(harness.events.filter(event => event.type === 'tool_approval_request')).toHaveLength(approvals)
    if (engine === 'eva') expect(execute).toHaveBeenCalledOnce()
  })
})
