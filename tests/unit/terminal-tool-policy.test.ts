import { describe, expect, it, vi } from 'vitest'
import { createTerminalTools } from '../../src/main/tools/terminal-tools'
import type { ToolContext } from '../../src/main/tools'

function makeContext(fullFilesystemAccess: boolean): ToolContext {
  return {
    workspacePath: 'C:/workspace',
    fullFilesystemAccess,
    fileService: {} as ToolContext['fileService'],
    terminalService: {
      createSession: vi.fn().mockResolvedValue(undefined),
      executeCommand: vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 }),
      destroySession: vi.fn(),
      writeInput: vi.fn(),
      resize: vi.fn(),
      onOutput: vi.fn(() => () => {}),
    },
  }
}

describe('execute_command permission boundary', () => {
  const tool = createTerminalTools()[0]

  it('does not run a shell from workspace-only conversations', async () => {
    const context = makeContext(false)
    const result = await tool.execute({ command: 'type C:\\Users\\private.txt' }, context)

    expect(result).toContain('requires Full filesystem access')
    expect(context.terminalService.createSession).not.toHaveBeenCalled()
  })

  it('allows command execution only after full filesystem access is granted', async () => {
    const context = makeContext(true)
    await expect(tool.execute({ command: 'echo ok' }, context)).resolves.toBe('ok')
    expect(context.terminalService.createSession).toHaveBeenCalledWith(expect.any(String), 'C:/workspace')
  })
})
