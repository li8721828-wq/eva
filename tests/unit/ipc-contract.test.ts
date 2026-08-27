import { describe, expect, it } from 'vitest'
import { IPC } from '../../src/shared/ipc-channels'
import type { ContractArgs, ContractResult } from '../../src/shared/ipc-contract'

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
})
