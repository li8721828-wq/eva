import { describe, expect, it } from 'vitest'
import { IPC } from '../../src/shared/ipc-channels'
import type { ContractArgs, ContractResult } from '../../src/shared/ipc-contract'
import { DEFAULT_APP_SERVER_CONFIG } from '../../src/shared/types/automation'

describe('IPC contract', () => {
  it('keeps the critical renderer boundaries typed from one shared definition', () => {
    const args: ContractArgs<typeof IPC.FILE_READ> = ['C:/workspace/file.ts', 'C:/workspace']
    const result: ContractResult<typeof IPC.FILE_READ> = 'contents'
    expect(args[0]).toContain('file.ts')
    expect(result).toBe('contents')
  })

  it('types requirement-engineering submissions at the preload boundary', () => {
    const args: ContractArgs<typeof IPC.REQUIREMENT_RUN_ABORT> = ['conversation-1']
    const result: ContractResult<typeof IPC.REQUIREMENT_RUN_ABORT> = undefined
    expect(args[0]).toBe('conversation-1')
    expect(result).toBeUndefined()
  })

  it('publishes the ACP door through the shared App-Server status contract', () => {
    const result: ContractResult<typeof IPC.APP_SERVER_GET_STATUS> = {
      running: true,
      host: '127.0.0.1',
      port: 53120,
      scheme: 'http',
      baseUrl: 'http://127.0.0.1:53120',
      rpcUrl: 'http://127.0.0.1:53120/v1/rpc',
      acpUrl: 'ws://127.0.0.1:53120/acp',
      bearerToken: 'token',
      startedAt: 1,
      lastError: null,
      loopbackOnly: true,
      connections: 0,
      acp: { enabled: true, path: '/acp', requireAuth: true, connections: 1 },
    }
    expect(result.acp?.path).toBe('/acp')
    expect(result.acp?.connections).toBe(1)
  })

  it('keeps ACP bearer authentication on until the user deliberately turns it off', () => {
    expect(DEFAULT_APP_SERVER_CONFIG.autoStart).toBe(false)
    expect(DEFAULT_APP_SERVER_CONFIG.acpRequireAuth).toBe(true)
    expect(DEFAULT_APP_SERVER_CONFIG.preferredPort).toBeNull()
    expect(DEFAULT_APP_SERVER_CONFIG.listenHost).toBe('127.0.0.1')
  })
})
