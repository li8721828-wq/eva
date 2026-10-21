import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ spawn: vi.fn(), wrap: vi.fn(async (command, args) => ({ command, args, envOverrides: {} })) }))
vi.mock('child_process', () => ({ spawn: mock.spawn }))
vi.mock('../../src/main/services/sandbox/scope', () => ({ currentSandboxScope: () => ({ level: 'strict', workspacePath: 'C:/workspace' }) }))
vi.mock('../../src/main/services/sandbox', () => ({ evaluateSandboxCommand: () => ({ allowed: true }), evaluateSandboxPath: () => ({ allowed: true }), wrapCommandForSandbox: mock.wrap }))
import { TerminalServiceImpl } from '../../src/main/services/terminal-service'

let service: TerminalServiceImpl
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  mock.spawn.mockImplementation((_command, args) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() })
    if (args.includes('-NonInteractive')) queueMicrotask(() => { child.stdout.emit('data', Buffer.from('done')); child.emit('close', 7) })
    return child
  })
  service = new TerminalServiceImpl(null)
})
afterEach(() => { service.destroySession('fallback'); vi.unstubAllGlobals() })

describe('PowerShell fallback', () => {
  it('uses one-shot arguments, the requested directory, sandbox wrapping and the real child status', async () => {
    await service.createSession('fallback', 'C:/workspace')
    const result = await service.executeCommand('fallback', 'cmd /c exit 7', 1000, 'C:/workspace/subdir')
    expect(result).toEqual({ stdout: 'done', stderr: '', exitCode: 7 })
    const [command, args, options] = mock.spawn.mock.calls[1]
    expect(command).toBe('powershell.exe')
    expect(args.filter((arg: string) => arg === '-Command')).toHaveLength(1)
    expect(args).toContain('-NonInteractive')
    expect(args).not.toContain('-c')
    expect(args).not.toContain('-NoExit')
    expect(options).toMatchObject({ cwd: 'C:/workspace/subdir', windowsHide: true })
    expect(options.timeout).toBeGreaterThan(0)
    expect(options.timeout).toBeLessThanOrEqual(1000)
    expect(service.getOutput('fallback')).toBe('done')
    expect(mock.wrap).toHaveBeenCalledTimes(2)
  })

  it('kills the running one-shot process when the command is cancelled', async () => {
    mock.spawn.mockImplementation(() => Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
    }))
    await service.createSession('fallback', 'C:/workspace')
    const controller = new AbortController()
    const pending = service.executeCommand('fallback', 'long-running', 1000, undefined, controller.signal)
    await vi.waitFor(() => expect(mock.spawn).toHaveBeenCalledTimes(2))
    const child = mock.spawn.mock.results[1].value
    controller.abort()
    expect((await pending).stderr).toContain('cancelled')
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(service.hasSession('fallback')).toBe(false)
    await service.createSession('fallback', 'C:/workspace')
    const output = vi.fn()
    const unsubscribe = service.onOutput('fallback', output)
    child.stdout.emit('data', Buffer.from('late old output'))
    child.stderr.emit('data', Buffer.from('late old error'))
    expect(output).not.toHaveBeenCalled()
    expect(service.getOutput('fallback')).toBe('')
    unsubscribe()
  })

  it('does not spawn after cancellation during asynchronous sandbox preparation', async () => {
    await service.createSession('fallback', 'C:/workspace')
    let release!: () => void
    const wrapping = new Promise<void>(resolve => { release = resolve })
    mock.wrap.mockImplementationOnce(async (command, args) => { await wrapping; return { command, args, envOverrides: {} } })
    const controller = new AbortController()
    const pending = service.executeCommand('fallback', 'must-not-run', 1000, undefined, controller.signal)
    await vi.waitFor(() => expect(mock.wrap).toHaveBeenCalledTimes(2))
    controller.abort()
    release()
    expect((await pending).stderr).toContain('cancelled')
    await Promise.resolve()
    expect(mock.spawn).toHaveBeenCalledTimes(1)
  })
})
