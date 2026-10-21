import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  spawn: vi.fn(),
  emit: (_data: string) => {},
  exit: (_event: { exitCode: number }) => {},
  write: vi.fn(),
  kill: vi.fn(),
  scope: null as any,
  wrap: vi.fn(async (command, args) => ({ command, args, envOverrides: {} })),
}))
vi.mock('../../src/main/services/sandbox', () => ({
  evaluateSandboxCommand: () => ({ allowed: true }),
  evaluateSandboxPath: () => ({ allowed: true }),
  wrapCommandForSandbox: fake.wrap,
}))
vi.mock('../../src/main/services/sandbox/scope', () => ({ currentSandboxScope: () => fake.scope }))
import { TerminalServiceImpl } from '../../src/main/services/terminal-service'

const prompt = (code: number) => `\x1b]633;E;EvaPrompt;${code}\x07PS > `
let service: TerminalServiceImpl
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  fake.scope = null
  fake.spawn.mockImplementation(() => ({
    onData(fn: typeof fake.emit) { fake.emit = fn; queueMicrotask(() => fn(prompt(0))) },
    onExit(fn: typeof fake.exit) { fake.exit = fn },
    write: fake.write,
    kill: fake.kill,
  }))
  fake.write.mockImplementation(() => queueMicrotask(() => fake.emit(`output\r\n${prompt(0)}`)))
  service = new TerminalServiceImpl({ spawn: fake.spawn } as never)
})
afterEach(() => { service.destroySession('test'); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('terminal command completion', () => {
  it('submits multiline PowerShell scripts in one physical line and strips the transport echo', async () => {
    const command = "Write-Output 'first'\nWrite-Output 'second'\ncmd /c exit 7"
    fake.write.mockImplementation((input: string) => {
      const encoded = /FromBase64String\('([^']+)'\)/.exec(input)?.[1]
      const script = Buffer.from(encoded!, 'base64').toString('utf8')
      expect(input).not.toContain('\n')
      expect(script).toContain(command)
      expect(script).toContain('$global:EvaCommandExitCode = if ($?)')
      const token = /EvaCommand;([a-f0-9]+)/.exec(script)![1]
      queueMicrotask(() => fake.emit(`${input}\r\n\x1b]633;E;EvaCommand;${token}\x07first\r\nsecond\r\n${prompt(7)}`))
    })
    await service.createSession('test', 'C:/a')
    expect(await service.executeCommand('test', command)).toEqual({ stdout: 'first\r\nsecond', stderr: '', exitCode: 7 })
  })
  it('uses one timeout budget for startup, directory change and command execution', async () => {
    vi.useFakeTimers()
    fake.spawn.mockImplementation(() => ({
      onData(fn: typeof fake.emit) { fake.emit = fn; setTimeout(() => fn(prompt(0)), 30) },
      onExit(fn: typeof fake.exit) { fake.exit = fn },
      write: fake.write, kill: fake.kill,
    }))
    fake.write.mockImplementation(() => setTimeout(() => fake.emit(prompt(0)), 40))
    await service.createSession('test', 'C:/a')
    const pending = service.executeCommand('test', 'slow command', 100, 'C:/b')
    await vi.advanceTimersByTimeAsync(100)
    const result = await pending
    expect(result.stderr).toContain('timed out')
    expect(fake.write.mock.calls.filter(([data]) => data !== '\x03')).toHaveLength(2)
    expect(fake.write).toHaveBeenLastCalledWith('\x03')
    expect(service.hasSession('test')).toBe(false)
  })

  it('cancels while waiting for the first shell prompt without submitting a command', async () => {
    fake.spawn.mockImplementation(() => ({ onData() {}, onExit() {}, write: fake.write, kill: fake.kill }))
    await service.createSession('test', 'C:/a')
    const controller = new AbortController()
    const pending = service.executeCommand('test', 'must-not-run', 100, undefined, controller.signal)
    await Promise.resolve()
    controller.abort()
    expect((await pending).stderr).toContain('cancelled')
    expect(fake.write.mock.calls.map(([data]) => data)).toEqual(['\x03'])
    expect(service.hasSession('test')).toBe(false)
  })
  it('cancels an executing command immediately and closes its shell', async () => {
    fake.write.mockImplementation(() => {})
    await service.createSession('test', 'C:/a')
    const controller = new AbortController()
    const pending = service.executeCommand('test', 'long-running', 100, undefined, controller.signal)
    await vi.waitFor(() => expect(fake.write).toHaveBeenCalled())
    controller.abort()
    const result = await pending
    expect(result.stderr).toContain('cancelled')
    expect(service.hasSession('test')).toBe(false)
    expect(fake.kill).toHaveBeenCalledTimes(1)
  })

  it('does not run a queued command after its signal is cancelled', async () => {
    fake.write.mockImplementation(() => {})
    await service.createSession('test', 'C:/a')
    const active = service.executeCommand('test', 'active', 300)
    await vi.waitFor(() => expect(fake.write).toHaveBeenCalledTimes(1))
    const controller = new AbortController()
    const queued = service.executeCommand('test', 'queued', 100, undefined, controller.signal)
    controller.abort()
    const promptly = await Promise.race([queued, new Promise<null>(resolve => setTimeout(() => resolve(null), 25))])
    fake.emit(prompt(0))
    await active
    await queued
    expect(promptly?.stderr).toContain('cancelled')
    expect(fake.write).toHaveBeenCalledTimes(1)
    expect(service.hasSession('test')).toBe(true)
  })

  it('does not send old queued commands into a replacement shell', async () => {
    fake.write.mockImplementation(() => {})
    await service.createSession('test', 'C:/a')
    const active = service.executeCommand('test', 'active', 100)
    await vi.waitFor(() => expect(fake.write).toHaveBeenCalledTimes(1))
    const queued = service.executeCommand('test', 'old-queued', 100)
    service.destroySession('test')
    await service.createSession('test', 'C:/a')
    await active
    const result = await queued
    expect(result.stderr).toContain('changed')
    expect(fake.write).toHaveBeenCalledTimes(1)
    expect(service.hasSession('test')).toBe(true)
  })
  it('waits for startup and reports the real exit status across fragmented markers', async () => {
    fake.write.mockImplementation(() => queueMicrotask(() => {
      fake.emit('failed\r\n\x1b]633;E;EvaPrompt;')
      fake.emit('7\x07PS > ')
    }))
    await service.createSession('test', 'C:/a')
    expect(await service.executeCommand('test', 'cmd /c exit 7')).toEqual({ stdout: 'failed', stderr: '', exitCode: 7 })
  })

  it('changes an explicit cwd in the existing shell before running the command', async () => {
    await service.createSession('test', 'C:/a')
    await service.executeCommand('test', 'Get-Location', 1000, "C:/b's folder")
    expect(fake.spawn).toHaveBeenCalledTimes(1)
    expect(fake.write.mock.calls.map(([text]) => text)).toEqual(["Set-Location -LiteralPath 'C:/b''s folder' -ErrorAction Stop\r", 'Get-Location\r'])
  })

  it('does not execute the command if changing cwd fails', async () => {
    fake.write.mockImplementation(() => queueMicrotask(() => fake.emit(`missing path\r\n${prompt(1)}`)))
    await service.createSession('test', 'C:/a')
    expect((await service.executeCommand('test', 'write-something', 1000, 'C:/missing')).exitCode).toBe(1)
    expect(fake.write).toHaveBeenCalledTimes(1)
  })

  it('serializes concurrent commands so each receives its own status and output', async () => {
    fake.write.mockImplementation((command: string) => {
      setTimeout(() => fake.emit(`${command.trim()} output\r\n${prompt(command.startsWith('first') ? 3 : 0)}`), 5)
    })
    await service.createSession('test', 'C:/a')
    const results = await Promise.all([service.executeCommand('test', 'first'), service.executeCommand('test', 'second')])
    expect(results.map(r => [r.stdout, r.exitCode])).toEqual([['first output', 3], ['second output', 0]])
  })

  it('settles immediately if the shell exits without a prompt', async () => {
    fake.write.mockImplementation(() => queueMicrotask(() => fake.exit({ exitCode: 9 })))
    await service.createSession('test', 'C:/a')
    expect((await service.executeCommand('test', 'exit 9')).exitCode).toBe(9)
    expect(service.hasSession('test')).toBe(false)
  })

  it('closes timed-out shells so late output cannot finish the next command', async () => {
    fake.write.mockImplementation(() => {})
    await service.createSession('test', 'C:/a')
    expect((await service.executeCommand('test', 'hang', 10)).exitCode).toBe(-1)
    expect(fake.kill).toHaveBeenCalledTimes(1)
    expect(service.hasSession('test')).toBe(false)
  })

  it('recreates an existing shell when sandbox policy changes', async () => {
    await service.createSession('test', 'C:/a')
    const output = vi.fn()
    const unsubscribe = service.onOutput('test', output)
    output.mockClear()
    fake.scope = { level: 'strict', workspacePath: 'C:/a', fileAccessGrants: [], extraAllowedPaths: [], allowNetwork: false }
    await service.createSession('test', 'C:/a')
    expect(fake.kill).toHaveBeenCalledTimes(1)
    expect(fake.spawn).toHaveBeenCalledTimes(2)
    expect(fake.wrap).toHaveBeenCalledTimes(1)
    fake.emit('new shell output')
    expect(output).toHaveBeenCalledWith('new shell output')
    unsubscribe()
    output.mockClear()
    fake.emit('after unsubscribe')
    expect(output).not.toHaveBeenCalled()
  })
})
