import { spawn, type ChildProcess } from 'child_process'
import type { TerminalService } from '../tools'

interface TerminalSession {
  process: ChildProcess
  cwd: string
  outputCallbacks: Array<(data: string) => void>
  outputBuffer: string
}

const DEFAULT_TIMEOUT = 30_000
const MAX_OUTPUT_LENGTH = 10_000
const MAX_SESSION_OUTPUT_LENGTH = 100_000
// OSC 633 is consumed by modern terminal emulators without rendering text.
// It lets command execution observe PowerShell's next prompt without injecting
// a control character into PSReadLine's input buffer.
const POWERSHELL_PROMPT_MARKER = '\x1b]633;E;EvaPrompt\x07'
const POWERSHELL_BOOTSTRAP = [
  "try { Import-Module PSReadLine -ErrorAction Stop; Set-PSReadLineOption -Colors @{ Command = 'Yellow'; Parameter = 'Cyan'; String = 'Green'; Variable = 'Magenta'; Number = 'Cyan'; Operator = 'DarkYellow'; Type = 'Blue'; Comment = 'DarkGray'; Error = 'Red'; Selection = 'Black,DarkCyan' } } catch {}",
  "$global:EvaPromptShown = $false",
  "function global:prompt { $esc = [char]27; $osc = \"${esc}]633;E;EvaPrompt$([char]7)\"; $path = (Get-Location).Path; $leaf = Split-Path -Leaf $path; $displayPath = if ($path -match '^[A-Za-z]:\\\\?$' -or !$leaf) { $path } elseif ($path -match '^[A-Za-z]:\\\\') { \"$($path.Substring(0, 2))\\~\\$leaf\" } else { $path }; $gap = if ($global:EvaPromptShown) { \"`r`n\" } else { $global:EvaPromptShown = $true; '' }; \"${gap}${osc}${esc}[90mPS ${esc}[1;34m${displayPath} ${esc}[90m>${esc}[0m \" }",
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
}

export class TerminalServiceImpl implements TerminalService {
  private ptySessions: Map<string, PtySession> = new Map()
  private fallbackSessions: Map<string, TerminalSession> = new Map()

  private get usePty(): boolean {
    return nodePty !== null
  }

  async createSession(id: string, cwd: string): Promise<void> {
    // A conversation may re-open its visible terminal after the panel was
    // hidden. Keep the original process and its working state intact.
    if (this.hasSession(id)) return

    if (this.usePty) {
      const shell = getShell()
      const pty = nodePty!.spawn(shell.command, shell.args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd,
        env: process.env as Record<string, string>,
      })

      const session: PtySession = {
        pty,
        outputCallbacks: [],
        outputBuffer: '',
      }

      pty.onData((data: string) => {
        this.appendOutput(session, data)
        for (const cb of session.outputCallbacks) {
          cb(data)
        }
      })

      this.ptySessions.set(id, session)
    } else {
      const shell = getShell()
      const child = spawn(shell.command, shell.args, {
        cwd,
        env: process.env,
        shell: false,
      })

      const session: TerminalSession = {
        process: child,
        cwd,
        outputCallbacks: [],
        outputBuffer: '',
      }

      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString()
        this.appendOutput(session, text)
        for (const cb of session.outputCallbacks) {
          cb(text)
        }
      })

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString()
        this.appendOutput(session, text)
        for (const cb of session.outputCallbacks) {
          cb(text)
        }
      })

      this.fallbackSessions.set(id, session)
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
    timeout: number = DEFAULT_TIMEOUT
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (this.usePty) {
      return this.executeCommandPty(sessionId, command, timeout)
    }
    return this.executeCommandFallback(sessionId, command, timeout)
  }

  private async executeCommandPty(
    sessionId: string,
    command: string,
    timeout: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const session = this.ptySessions.get(sessionId)
    if (!session) throw new Error(`Terminal session ${sessionId} not found`)

    const isWindows = process.platform === 'win32'
    const unixMarkerText = `EVA_CMD_DONE_${Date.now()}`
    const endMarker = isWindows ? POWERSHELL_PROMPT_MARKER : `\x1e${unixMarkerText}\x1e`
    let output = ''

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        resolve({
          stdout: truncateOutput(output),
          stderr: '[Command timed out]',
          exitCode: -1,
        })
      }, timeout)

      const onData = (data: string): void => {
        output += data
        if (output.includes(endMarker)) {
          clearTimeout(timer)
          cleanup()
          // Remove the end marker from output
          const cleaned = output.replace(endMarker, '').trim()
          resolve({ stdout: truncateOutput(cleaned), stderr: '', exitCode: 0 })
        }
      }

      const cleanup = (): void => {
        const idx = session.outputCallbacks.indexOf(onData)
        if (idx >= 0) session.outputCallbacks.splice(idx, 1)
      }

      session.outputCallbacks.push(onData)
      if (isWindows) {
        // The custom prompt emits an invisible OSC marker after each command.
        // Sending only the user's command avoids triggering PSReadLine's
        // completion behaviour with an artificial trailing command.
        session.pty.write(`${command}\r`)
      } else {
        session.pty.write(`${command}\r\nprintf '\\036%s\\036' '${unixMarkerText}'\r`)
      }
    })
  }

  private async executeCommandFallback(
    sessionId: string,
    command: string,
    timeout: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const session = this.fallbackSessions.get(sessionId)
    if (!session) throw new Error(`Terminal session ${sessionId} not found`)

    return new Promise((resolve, reject) => {
      const shell = getShell()
      const child = spawn(shell.command, [...shell.args, '-c', command], {
        cwd: session.cwd,
        env: process.env,
        timeout,
      })

      let stdout = ''
      let stderr = ''

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      child.on('error', (err) => {
        reject(new Error(`Command failed: ${err.message}`))
      })

      child.on('close', (code) => {
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
        try {
          session.pty.kill()
        } catch {
          // Ignore kill errors
        }
        this.ptySessions.delete(sessionId)
      }
    } else {
      const session = this.fallbackSessions.get(sessionId)
      if (session) {
        try {
          session.process.kill()
        } catch {
          // Ignore kill errors
        }
        this.fallbackSessions.delete(sessionId)
      }
    }
  }

  onOutput(sessionId: string, callback: (data: string) => void): () => void {
    if (this.usePty) {
      const session = this.ptySessions.get(sessionId)
      if (!session) return () => {}
      session.outputCallbacks.push(callback)
      if (session.outputBuffer) callback(session.outputBuffer)
      return () => {
        const idx = session.outputCallbacks.indexOf(callback)
        if (idx >= 0) session.outputCallbacks.splice(idx, 1)
      }
    } else {
      const session = this.fallbackSessions.get(sessionId)
      if (!session) return () => {}
      session.outputCallbacks.push(callback)
      if (session.outputBuffer) callback(session.outputBuffer)
      return () => {
        const idx = session.outputCallbacks.indexOf(callback)
        if (idx >= 0) session.outputCallbacks.splice(idx, 1)
      }
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
