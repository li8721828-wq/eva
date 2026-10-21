import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import path from 'path'
import type { TerminalService } from '../tools'
import { evaluateSandboxCommand, evaluateSandboxPath, wrapCommandForSandbox } from './sandbox'
import { currentSandboxScope } from './sandbox/scope'

interface TerminalSession {
  process: ChildProcess
  cwd: string
  outputCallbacks: Array<(data: string) => void>
  outputBuffer: string
  scopeKey: string
  commands: Map<ChildProcess, () => void>
}

interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

const cancelledCommand = (): CommandResult => ({ stdout: '', stderr: '[Command cancelled]', exitCode: -1 })

const DEFAULT_TIMEOUT = 30_000
const MAX_OUTPUT_LENGTH = 10_000
const MAX_SESSION_OUTPUT_LENGTH = 100_000
// OSC 633 is consumed by modern terminal emulators without rendering text.
// It lets command execution observe PowerShell's next prompt without injecting
// a control character into PSReadLine's input buffer.
const POWERSHELL_PROMPT_PATTERN = /\x1b\]633;E;EvaPrompt;(-?\d+)\x07/
const POWERSHELL_FAILURE_CODE = "if ($global:Error[0] -ne $global:EvaLastError) { 1 } elseif ($global:LASTEXITCODE) { $global:LASTEXITCODE } else { 1 }"
const POWERSHELL_BOOTSTRAP = [
  "try { Import-Module PSReadLine -ErrorAction Stop; Set-PSReadLineOption -Colors @{ Command = 'Yellow'; Parameter = 'Cyan'; String = 'Green'; Variable = 'Magenta'; Number = 'Cyan'; Operator = 'DarkYellow'; Type = 'Blue'; Comment = 'DarkGray'; Error = 'Red'; Selection = 'Black,DarkCyan' } } catch {}",
  "$global:EvaPromptShown = $false",
  "function global:prompt { $evaOk = $?; $evaCode = if ($null -ne $global:EvaCommandExitCode) { $global:EvaCommandExitCode } elseif ($evaOk) { 0 } elseif ($global:Error[0] -ne $global:EvaLastError) { 1 } elseif ($global:LASTEXITCODE) { $global:LASTEXITCODE } else { 1 }; $global:EvaCommandExitCode = $null; $global:EvaLastError = $global:Error[0]; $esc = [char]27; $osc = \"${esc}]633;E;EvaPrompt;${evaCode}$([char]7)\"; $path = (Get-Location).Path; $leaf = Split-Path -Leaf $path; $displayPath = if ($path -match '^[A-Za-z]:\\\\?$' -or !$leaf) { $path } elseif ($path -match '^[A-Za-z]:\\\\') { \"$($path.Substring(0, 2))\\~\\$leaf\" } else { $path }; $gap = if ($global:EvaPromptShown) { \"`r`n\" } else { $global:EvaPromptShown = $true; '' }; \"${gap}${osc}${esc}[90mPS ${esc}[1;34m${displayPath} ${esc}[90m>${esc}[0m \" }",
].join('; ')

function getShell(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoExit', '-Command', POWERSHELL_BOOTSTRAP],
    }
  }
  return {
    command: process.env.SHELL || '/bin/bash',
    args: [],
  }
}

let nodePty: typeof import('node-pty') | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  nodePty = require('node-pty')
} catch {
  console.warn('[TerminalService] node-pty not available, using child_process fallback')
}

interface PtySession {
  pty: import('node-pty').IPty
  outputCallbacks: Array<(data: string) => void>
  outputBuffer: string
  scopeKey: string
  ready: Promise<void>
  markReady: () => void
  exitCallbacks: Array<(code: number) => void>
}

export class TerminalServiceImpl implements TerminalService {
  constructor(private readonly ptyModule: typeof nodePty = nodePty) {}
  private ptySessions: Map<string, PtySession> = new Map()
  private fallbackSessions: Map<string, TerminalSession> = new Map()
  private creationPromises = new Map<string, Promise<void>>()
  private commandQueues = new Map<string, Promise<void>>()
  private outputListeners = new Map<string, Set<(data: string) => void>>()

  private get usePty(): boolean {
    return this.ptyModule !== null
  }

  /**
   * Evaluate a command line against the sandbox of the running agent, if any.
   * Returns the denial reason, or null when the command may proceed.
   */
  checkSandboxCommand(command: string): string | null {
    const scope = currentSandboxScope()
    if (!scope) return null
    const decision = evaluateSandboxCommand(command, scope)
    return decision.allowed ? null : decision.reason
  }

  async createSession(id: string, cwd: string): Promise<void> {
    const pending = this.creationPromises.get(id) || Promise.resolve()
    const creation = pending.catch(() => undefined).then(() => this.createSessionInternal(id, cwd))
    this.creationPromises.set(id, creation)
    try { await creation } finally {
      if (this.creationPromises.get(id) === creation) this.creationPromises.delete(id)
    }
  }

  private async createSessionInternal(id: string, cwd: string): Promise<void> {
    // A conversation may re-open its visible terminal after the panel was
    // hidden. Keep the original process and its working state intact.
    const scope = currentSandboxScope()
    const scopeKey = JSON.stringify(scope)
    const existing = this.ptySessions.get(id) || this.fallbackSessions.get(id)
    if (existing?.scopeKey === scopeKey) return
    if (existing) this.destroySession(id)

    if (this.usePty) {
      const shell = getShell()
      let command = shell.command
      let args = shell.args
      // Wrap the shell process if a sandbox context is active.
      let envOverrides: Record<string, string | undefined> = {}
      if (scope && scope.level !== 'off') {
        const wrapped = await wrapCommandForSandbox(command, args, {
          ...scope,
          workspacePath: scope.workspacePath || cwd,
        })
        command = wrapped.command
        args = wrapped.args
        envOverrides = wrapped.envOverrides
      }
      const pty = this.ptyModule!.spawn(command, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd,
        env: { ...process.env, ...envOverrides } as Record<string, string>,
      })

      let markReady!: () => void
      const ready = new Promise<void>((resolve) => { markReady = resolve })
      const session: PtySession = {
        pty,
        outputCallbacks: [],
        outputBuffer: '',
        scopeKey, ready, markReady, exitCallbacks: [],
      }

      pty.onData((data: string) => {
        if (this.ptySessions.get(id) !== session) return
        this.appendOutput(session, data)
        if (POWERSHELL_PROMPT_PATTERN.test(session.outputBuffer)) session.markReady()
        for (const cb of [...session.outputCallbacks]) {
          cb(data)
        }
        for (const cb of this.outputListeners.get(id) || []) cb(data)
      })

      this.ptySessions.set(id, session)
      if (process.platform !== 'win32') markReady()
      pty.onExit(({ exitCode }) => {
        if (this.ptySessions.get(id) === session) this.ptySessions.delete(id)
        markReady()
        for (const cb of [...session.exitCallbacks]) cb(exitCode)
      })
    } else {
      const shell = getShell()
      const wrapped = scope && scope.level !== 'off'
        ? await wrapCommandForSandbox(shell.command, shell.args, scope)
        : { ...shell, envOverrides: {} }
      const child = spawn(wrapped.command, wrapped.args, {
        cwd,
        env: { ...process.env, ...wrapped.envOverrides },
        windowsHide: true,
        shell: false,
      })

      const session: TerminalSession = {
        process: child,
        cwd,
        outputCallbacks: [],
        outputBuffer: '',
        scopeKey,
        commands: new Map(),
      }

      child.stdout?.on('data', (data: Buffer) => {
        if (this.fallbackSessions.get(id) !== session) return
        const text = data.toString()
        this.appendOutput(session, text)
        for (const cb of session.outputCallbacks) {
          cb(text)
        }
        for (const cb of this.outputListeners.get(id) || []) cb(text)
      })

      child.stderr?.on('data', (data: Buffer) => {
        if (this.fallbackSessions.get(id) !== session) return
        const text = data.toString()
        this.appendOutput(session, text)
        for (const cb of session.outputCallbacks) {
          cb(text)
        }
        for (const cb of this.outputListeners.get(id) || []) cb(text)
      })

      this.fallbackSessions.set(id, session)
      const close = (): void => { if (this.fallbackSessions.get(id) === session) this.destroySession(id) }
      child.on('error', close)
      child.on('close', close)
    }
  }

  hasSession(id: string): boolean {
    return this.ptySessions.has(id) || this.fallbackSessions.has(id)
  }

  getOutput(id: string): string {
    return this.ptySessions.get(id)?.outputBuffer || this.fallbackSessions.get(id)?.outputBuffer || ''
  }

  private appendOutput(session: Pick<TerminalSession, 'outputBuffer'> | Pick<PtySession, 'outputBuffer'>, data: string): void {
    session.outputBuffer = `${session.outputBuffer}${data}`.slice(-MAX_SESSION_OUTPUT_LENGTH)
  }

  async executeCommand(
    sessionId: string,
    command: string,
    timeout: number = DEFAULT_TIMEOUT,
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (signal?.aborted) return cancelledCommand()
    const session = this.ptySessions.get(sessionId) || this.fallbackSessions.get(sessionId)
    if (!session) throw new Error(`Terminal session ${sessionId} not found`)
    const isCurrentSession = (): boolean => (this.ptySessions.get(sessionId) || this.fallbackSessions.get(sessionId)) === session
    let running = false
    let cancel: (() => void) | undefined
    const cancellation = signal ? new Promise<CommandResult>((resolve) => {
      cancel = () => {
        resolve(cancelledCommand())
        if (running && isCurrentSession()) this.interruptAndCloseSession(sessionId)
      }
      signal.addEventListener('abort', cancel, { once: true })
    }) : undefined
    const previous = this.commandQueues.get(sessionId) || Promise.resolve()
    const execution = previous.then(async () => {
      if (signal?.aborted) return cancelledCommand()
      if (!isCurrentSession()) return { stdout: '', stderr: '[Terminal session changed; command not executed]', exitCode: -1 }
      running = true
      const budget = Number.isFinite(timeout) ? Math.max(1, timeout) : DEFAULT_TIMEOUT
      const deadline = Date.now() + budget
      const remaining = (): number => Math.max(1, deadline - Date.now())
      const scope = currentSandboxScope()
      if (cwd && scope) {
        const decision = evaluateSandboxPath(path.resolve(cwd), 'read', scope)
        if (!decision.allowed) return { stdout: '', stderr: decision.reason, exitCode: 126 }
      }
      if (this.usePty) {
        if (cwd) {
          const quoted = `'${cwd.replace(/'/g, process.platform === 'win32' ? "''" : "'\\''")}'`
          const changeDirectory = process.platform === 'win32' ? `Set-Location -LiteralPath ${quoted} -ErrorAction Stop` : `cd -- ${quoted}`
          const changed = await this.executeCommandPty(sessionId, changeDirectory, remaining())
          if (changed.exitCode !== 0) return changed
        }
        if (signal?.aborted) return cancelledCommand()
        if (!isCurrentSession()) return { stdout: '', stderr: '[Terminal session changed; command not executed]', exitCode: -1 }
        if (Date.now() >= deadline) {
          this.destroySession(sessionId)
          return { stdout: '', stderr: '[Command timed out; terminal session closed]', exitCode: -1 }
        }
        return this.executeCommandPty(sessionId, command, remaining())
      }
      return this.executeCommandFallback(sessionId, command, remaining(), cwd, signal)
    })
    const settled = execution.then(() => undefined, () => undefined)
    this.commandQueues.set(sessionId, settled)
    void settled.then(() => {
      if (this.commandQueues.get(sessionId) === settled) this.commandQueues.delete(sessionId)
    })
    try { return await (cancellation ? Promise.race([execution, cancellation]) : execution) } finally {
      if (cancel) signal?.removeEventListener('abort', cancel)
    }
  }

  private async executeCommandPty(
    sessionId: string,
    command: string,
    timeout: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const session = this.ptySessions.get(sessionId)
    if (!session) throw new Error(`Terminal session ${sessionId} not found`)

    // Sandbox command-line pre-check: deny catastrophic patterns before they
    // ever reach the shell. The OS sandbox (if present) provides the real
    // enforcement; this is the fast-path defense-in-depth.
    const scope = currentSandboxScope()
    if (scope) {
      const decision = evaluateSandboxCommand(command, scope)
      if (!decision.allowed) {
        return { stdout: '', stderr: decision.reason, exitCode: 126 }
      }
    }

    // Do not mistake the first shell prompt for completion of the first command.
    const deadline = Date.now() + timeout
    let startupTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        session.ready,
        new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error('Terminal startup timed out')), timeout) }),
      ])
    } catch (error) {
      this.destroySession(sessionId)
      throw error
    } finally { clearTimeout(startupTimer) }
    if (this.ptySessions.get(sessionId) !== session) throw new Error('Terminal exited before command execution')

    const isWindows = process.platform === 'win32'
    const unixMarkerText = `EVA_CMD_DONE_${randomUUID().replace(/-/g, '')}`
    const endPattern = isWindows ? POWERSHELL_PROMPT_PATTERN : new RegExp(`\\x1e${unixMarkerText};(-?\\d+)\\x1e`)
    const startToken = isWindows && /[\r\n]/.test(command) ? randomUUID().replace(/-/g, '') : undefined
    const startMarker = startToken ? `\x1b]633;E;EvaCommand;${startToken}\x07` : undefined
    let output = ''

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        // A late prompt must not complete the next queued command. End this
        // shell on timeout; a later tool call creates a fresh session.
        this.interruptAndCloseSession(sessionId)
        resolve({
          stdout: truncateOutput(output),
          stderr: '[Command timed out; terminal session closed]',
          exitCode: -1,
        })
      }, Math.max(1, deadline - Date.now()))

      const onData = (data: string): void => {
        output += data
        const marker = endPattern.exec(output)
        if (marker) {
          cleanup()
          const start = startMarker ? output.indexOf(startMarker) : -1
          const cleaned = output.slice(start >= 0 ? start + startMarker!.length : 0, marker.index).trim()
          resolve({ stdout: truncateOutput(cleaned), stderr: '', exitCode: Number(marker[1]) })
        }
      }

      const onExit = (code: number): void => {
        cleanup()
        resolve({ stdout: truncateOutput(output), stderr: '[Terminal exited]', exitCode: code })
      }

      const cleanup = (): void => {
        clearTimeout(timer)
        const idx = session.outputCallbacks.indexOf(onData)
        if (idx >= 0) session.outputCallbacks.splice(idx, 1)
        const exitIndex = session.exitCallbacks.indexOf(onExit)
        if (exitIndex >= 0) session.exitCallbacks.splice(exitIndex, 1)
      }

      session.outputCallbacks.push(onData)
      session.exitCallbacks.push(onExit)
      try {
        if (isWindows) {
          // The prompt captures $? before running any formatting commands.
          if (startToken) {
            // PSReadLine treats embedded LF as editing keys and can reorder
            // pasted lines. Submit one physical line, dot-source the original
            // script to preserve cwd/variables, and capture status inside it.
            const script = `[Console]::Write([string][char]27 + ']633;E;EvaCommand;${startToken}' + [char]7)\n${command}\n$global:EvaCommandExitCode = if ($?) { 0 } else { ${POWERSHELL_FAILURE_CODE} }`
            const encoded = Buffer.from(script, 'utf8').toString('base64')
            session.pty.write(`. ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))))\r`)
          } else session.pty.write(`${command}\r`)
        } else {
          session.pty.write(`${command}\n__eva_status=$?; printf '\\036${unixMarkerText};%d\\036' "$__eva_status"\n`)
        }
      } catch (error) { cleanup(); reject(error) }
    })
  }

  private async executeCommandFallback(
    sessionId: string,
    command: string,
    timeout: number,
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const session = this.fallbackSessions.get(sessionId)
    if (!session) throw new Error(`Terminal session ${sessionId} not found`)
    const deadline = Date.now() + timeout

    // Same sandbox pre-check for the fallback child_process path.
    const scope = currentSandboxScope()
    if (scope) {
      const decision = evaluateSandboxCommand(command, scope)
      if (!decision.allowed) {
        return { stdout: '', stderr: decision.reason, exitCode: 126 }
      }
    }

    const shell = getShell()
    // A one-shot PowerShell invocation must not inherit interactive -NoExit/
    // -Command bootstrap arguments. Wrap exactly the process we execute.
    const args = process.platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${command}\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }`]
      : ['-c', command]
    const wrapped = scope && scope.level !== 'off'
      ? await wrapCommandForSandbox(shell.command, args, scope)
      : { command: shell.command, args, envOverrides: {} }
    if (signal?.aborted) return cancelledCommand()
    if (this.fallbackSessions.get(sessionId) !== session) return { stdout: '', stderr: '[Terminal session changed; command not executed]', exitCode: -1 }
    if (Date.now() >= deadline) return { stdout: '', stderr: '[Command timed out before process launch]', exitCode: -1 }
    return new Promise((resolve, reject) => {
      const child = spawn(wrapped.command, wrapped.args, {
        cwd: cwd || session.cwd,
        env: { ...process.env, ...wrapped.envOverrides },
        timeout: Math.max(1, deadline - Date.now()),
        windowsHide: true,
      })

      let stdout = ''
      let stderr = ''
      const close = (): void => {
        session.commands.delete(child)
        resolve({ stdout: truncateOutput(stdout), stderr: '[Terminal session closed]', exitCode: -1 })
      }
      session.commands.set(child, close)

      child.stdout?.on('data', (data: Buffer) => {
        if (this.fallbackSessions.get(sessionId) !== session) return
        stdout += data.toString()
        this.appendOutput(session, data.toString())
        for (const listener of this.outputListeners.get(sessionId) || []) listener(data.toString())
      })

      child.stderr?.on('data', (data: Buffer) => {
        if (this.fallbackSessions.get(sessionId) !== session) return
        stderr += data.toString()
        this.appendOutput(session, data.toString())
        for (const listener of this.outputListeners.get(sessionId) || []) listener(data.toString())
      })

      child.on('error', (err) => {
        session.commands.delete(child)
        reject(new Error(`Command failed: ${err.message}`))
      })

      child.on('close', (code) => {
        session.commands.delete(child)
        resolve({
          stdout: truncateOutput(stdout),
          stderr: truncateOutput(stderr),
          exitCode: code ?? -1,
        })
      })
    })
  }

  writeInput(sessionId: string, data: string): void {
    if (this.usePty) {
      const session = this.ptySessions.get(sessionId)
      if (session) session.pty.write(data)
    } else {
      const session = this.fallbackSessions.get(sessionId)
      if (session?.process.stdin?.writable) {
        session.process.stdin.write(data)
      }
    }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    if (this.usePty) {
      const session = this.ptySessions.get(sessionId)
      if (session) {
        try {
          session.pty.resize(cols, rows)
        } catch {
          // Ignore resize errors
        }
      }
    }
    // Fallback doesn't support resize
  }

  destroySession(sessionId: string): void {
    if (this.usePty) {
      const session = this.ptySessions.get(sessionId)
      if (session) {
        this.ptySessions.delete(sessionId)
        session.markReady()
        for (const callback of [...session.exitCallbacks]) callback(-1)
        try {
          session.pty.kill()
        } catch {
          // Ignore kill errors
        }
      }
    } else {
      const session = this.fallbackSessions.get(sessionId)
      if (session) {
        this.fallbackSessions.delete(sessionId)
        for (const [child, close] of [...session.commands]) {
          close()
          try { child.kill() } catch { /* process already exited */ }
        }
        try {
          session.process.kill()
        } catch {
          // Ignore kill errors
        }
      }
    }
  }

  private interruptAndCloseSession(sessionId: string): void {
    try { this.ptySessions.get(sessionId)?.pty.write('\x03') } catch { /* shell already exited */ }
    this.destroySession(sessionId)
  }

  onOutput(sessionId: string, callback: (data: string) => void): () => void {
    const listeners = this.outputListeners.get(sessionId) || new Set()
    listeners.add(callback)
    this.outputListeners.set(sessionId, listeners)
    const output = this.getOutput(sessionId)
    if (output) callback(output)
    return () => {
      listeners.delete(callback)
      if (listeners.size === 0) this.outputListeners.delete(sessionId)
    }
  }
}

function truncateOutput(output: string): string {
  if (output.length > MAX_OUTPUT_LENGTH) {
    const truncated = output.slice(0, MAX_OUTPUT_LENGTH)
    return `${truncated}\n\n... [Output truncated: ${output.length} chars total, showing first ${MAX_OUTPUT_LENGTH}]`
  }
  return output
}
