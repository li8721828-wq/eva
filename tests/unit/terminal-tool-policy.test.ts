import { describe, expect, it, vi } from 'vitest'
import { createTerminalTools } from '../../src/main/tools/terminal-tools'
import type { ToolContext } from '../../src/main/tools'
import { conversationTerminalSessionId } from '../../src/shared/terminal-session'

function makeContext(fullFilesystemAccess: boolean): ToolContext {
  return {
    workspacePath: 'C:/workspace',
    fullFilesystemAccess,
    fileService: {} as ToolContext['fileService'],
    terminalService: {
      createSession: vi.fn().mockResolvedValue(undefined),
      hasSession: vi.fn(() => false),
      getOutput: vi.fn(() => ''),
      executeCommand: vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 }),
      destroySession: vi.fn(),
      writeInput: vi.fn(),
      resize: vi.fn(),
      onOutput: vi.fn(() => () => {}),
    },
  }
}

describe('execute_command permission boundary', () => {
  const tool = createTerminalTools().find((candidate) => candidate.definition.name === 'execute_command')!

  it('does not run a one-off shell without full filesystem access', async () => {
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

  it('allows a command-based fallback when full filesystem access is granted', async () => {
    const context = makeContext(true)
    await expect(tool.execute({ command: 'start chrome.exe' }, context)).resolves.toBe('ok')

    expect(context.terminalService.createSession).toHaveBeenCalledWith(expect.any(String), 'C:/workspace')
  })

  it('reuses the terminal controlled by the current conversation', async () => {
    const context = { ...makeContext(false), conversationId: 'conversation-a' }

    await expect(tool.execute({ command: 'echo ok' }, context)).resolves.toBe('ok')

    expect(context.terminalService.createSession).toHaveBeenCalledWith(
      conversationTerminalSessionId('conversation-a'),
      'C:/workspace',
    )
    expect(context.terminalService.destroySession).not.toHaveBeenCalled()
  })

  it('blocks a PowerShell pipeline property access missing the current-item variable', async () => {
    const context = { ...makeContext(false), conversationId: 'conversation-powershell' }
    const result = await tool.execute({ command: "Get-ChildItem -Recurse -File | Where-Object { .Extension -match '\\.ts$' }" }, context)

    expect(result).toContain('$_.Extension')
    expect(context.terminalService.createSession).not.toHaveBeenCalled()
    expect(context.terminalService.executeCommand).not.toHaveBeenCalled()
  })

  it('blocks an identical command after it fails in the same terminal session', async () => {
    const context = { ...makeContext(false), conversationId: 'conversation-repeat' }
    vi.mocked(context.terminalService.executeCommand).mockResolvedValue({ stdout: '', stderr: 'CommandNotFoundException', exitCode: 1 })

    await expect(tool.execute({ command: 'broken-command' }, context)).resolves.toContain('CommandNotFoundException')
    await expect(tool.execute({ command: 'broken-command' }, context)).resolves.toContain('identical command already failed')
    expect(context.terminalService.executeCommand).toHaveBeenCalledTimes(1)
  })
})

describe('read_terminal conversation boundary', () => {
  it('reads only the output held by the current conversation terminal', async () => {
    const tool = createTerminalTools().find((candidate) => candidate.definition.name === 'read_terminal')!
    const context = { ...makeContext(false), conversationId: 'conversation-a' }
    vi.mocked(context.terminalService.getOutput).mockReturnValue('PS C:\\~\\eva > Get-Location')

    await expect(tool.execute({}, context)).resolves.toContain('Get-Location')
    expect(context.terminalService.getOutput).toHaveBeenCalledWith(conversationTerminalSessionId('conversation-a'))
  })
})

describe('controlled terminal visibility', () => {
  it('opens the current conversation terminal instead of a disposable shell', async () => {
    const tool = createTerminalTools().find((candidate) => candidate.definition.name === 'open_terminal')!
    const context = { ...makeContext(false), conversationId: 'conversation-a' }

    await expect(tool.execute({}, context)).resolves.toContain('Opened')
    expect(context.terminalService.createSession).toHaveBeenCalledWith(
      conversationTerminalSessionId('conversation-a'),
      'C:/workspace',
    )
  })

  it('types and submits text in the current conversation terminal', async () => {
    const tool = createTerminalTools().find((candidate) => candidate.definition.name === 'write_terminal')!
    const context = { ...makeContext(false), conversationId: 'conversation-a' }

    await expect(tool.execute({ text: 'ipconfig', submit: true }, context)).resolves.toContain('pressed Enter')
    expect(context.terminalService.writeInput).toHaveBeenCalledWith(
      conversationTerminalSessionId('conversation-a'),
      'ipconfig\r',
    )
  })

  it('does not submit a malformed PowerShell pipeline through direct terminal typing', async () => {
    const tool = createTerminalTools().find((candidate) => candidate.definition.name === 'write_terminal')!
    const context = { ...makeContext(false), conversationId: 'conversation-typed-powershell' }

    await expect(tool.execute({ text: 'Get-ChildItem | Where-Object { .Name -eq \'x\' }', submit: true }, context)).resolves.toContain('$_.Property')
    expect(context.terminalService.writeInput).not.toHaveBeenCalled()
  })

  it('closes only the current conversation terminal', async () => {
    const tool = createTerminalTools().find((candidate) => candidate.definition.name === 'close_terminal')!
    const context = { ...makeContext(false), conversationId: 'conversation-a' }

    await expect(tool.execute({}, context)).resolves.toContain('Closed')
    expect(context.terminalService.destroySession).toHaveBeenCalledWith(conversationTerminalSessionId('conversation-a'))
  })
})
