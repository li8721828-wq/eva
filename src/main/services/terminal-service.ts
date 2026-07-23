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

function getShell(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      command: process.env.COMSPEC || 'powershell.exe',
      args: process.env.COMSPEC ? [] : ['-NoLogo'],
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
}

export class TerminalServiceImpl implements TerminalService {
  private ptySessions: Map<string, PtySession> = new Map()
  private fallbackSessions: Map<string, TerminalSession> = new Map()

  private get usePty(): boolean {
    return nodePty !== null
  }

  async createSession(id: string, cwd: string): Promise<void> {
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
      }

      pty.onData((data: string) => {
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
        session.outputBuffer += text
        for (const cb of session.outputCallbacks) {
          cb(text)
        }
      })

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString()
        session.outputBuffer += text
        for (const cb of session.outputCallbacks) {
          cb(text)
        }
      })

      this.fallbackSessions.set(id, session)
    }
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

    const endMarker = `\x00EVA_CMD_DONE_${Date.now()}\x00`
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
      // Send command followed by echo of the end marker
      const isWindows = process.platform === 'win32'
      const echoCmd = isWindows
        ? `echo ${endMarker}`
        : `echo '${endMarker}'`
      session.pty.write(`${command}\r\n${echoCmd}\r\n`)
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
      return () => {
        const idx = session.outputCallbacks.indexOf(callback)
        if (idx >= 0) session.outputCallbacks.splice(idx, 1)
      }
    } else {
      const session = this.fallbackSessions.get(sessionId)
      if (!session) return () => {}
      session.outputCallbacks.push(callback)
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
