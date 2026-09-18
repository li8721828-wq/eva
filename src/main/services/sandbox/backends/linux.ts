import { spawn } from 'child_process'
import type { SandboxBackend, SandboxContext, SandboxDecision, WrappedCommand } from '../types'
import { buildBubblewrapArgs, type ProfileInputs } from '../profile-builder'
import { defaultCommandDecision, pathDecision } from './darwin'

/**
 * Linux backend: wraps every spawned process with `bwrap` (bubblewrap). The
 * binary is NOT shipped with most distros — `probe()` must check that it is
 * on PATH. When `bwrap` is missing the index falls back to the noop backend
 * and surfaces the error in the sandbox status report.
 */
export class LinuxBubblewrapBackend implements SandboxBackend {
  readonly name = 'linux-bubblewrap'
  readonly platform: NodeJS.Platform = 'linux'

  async probe(): Promise<{ available: boolean; error: string | null }> {
    if (process.platform !== 'linux') return { available: false, error: 'not running on Linux' }
    return new Promise<{ available: boolean; error: string | null }>((resolve) => {
      const child = spawn('bwrap', ['--version'], { stdio: 'ignore' })
      child.on('error', (error) => resolve({ available: false, error: error.message }))
      child.on('exit', (code) => {
        if (code === 0) resolve({ available: true, error: null })
        else resolve({ available: false, error: `bwrap exited with code ${code}` })
      })
    })
  }

  async wrap(command: string, args: string[], context: SandboxContext): Promise<WrappedCommand> {
    const profileInputs: ProfileInputs = {
      workspacePath: context.workspacePath,
      extraAllowedPaths: context.extraAllowedPaths,
      allowNetwork: context.allowNetwork,
    }
    const bwrapArgs = buildBubblewrapArgs(profileInputs)
    return {
      command: 'bwrap',
      args: [...bwrapArgs, '--', command, ...args],
      envOverrides: {},
      profile: bwrapArgs.join(' '),
    }
  }

  evaluateCommand(commandLine: string, context: SandboxContext): SandboxDecision {
    return defaultCommandDecision(commandLine, context, this.name)
  }

  evaluatePath(targetPath: string, operation: 'read' | 'write', context: SandboxContext): SandboxDecision {
    return pathDecision(targetPath, operation, context, this.name)
  }
}
