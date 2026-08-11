import type { ToolExecutor, ToolContext } from './index'

const MAX_OUTPUT_LENGTH = 10_000

export function createTerminalTools(): ToolExecutor[] {
  return [executeCommandTool]
}

const executeCommandTool: ToolExecutor = {
  definition: {
    name: 'execute_command',
    description:
      'Execute a shell command in the terminal and return the output. Use for scripts, installs, builds, system automation, and other terminal work. For a user-requested visible desktop-control workflow, prefer desktop tools first; use a command-based fallback only after explaining it and obtaining the user\'s confirmation.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: {
          type: 'string',
          description: 'Working directory for the command (defaults to workspace root)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default 30000, max 120000)',
        },
      },
      required: ['command'],
    },
  },
  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    const command = params.command as string

    // A shell cannot be constrained to a directory by its working directory alone:
    // commands can still read, write, or execute outside it. Do not present
    // workspace-only access as a sandbox when it is not one.
    if (!context.fullFilesystemAccess) {
      return 'Command execution requires Full filesystem access. Workspace-only and authorized-folder conversations can use file tools, but cannot run an unrestricted local shell.'
    }

    const timeout = Math.min((params.timeout as number) ?? 30_000, 120_000)

    // Create a dedicated session for command execution
    const sessionId = `tool_cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const cwd = (params.cwd as string) || context.workspacePath

    try {
      await context.terminalService.createSession(sessionId, cwd)
      const result = await context.terminalService.executeCommand(sessionId, command, timeout)

      const parts: string[] = []

      if (result.stdout) {
        parts.push(result.stdout)
      }
      if (result.stderr) {
        parts.push(`[stderr]\n${result.stderr}`)
      }
      if (result.exitCode !== 0) {
        parts.push(`[exit code: ${result.exitCode}]`)
      }

      const output = parts.join('\n') || '(no output)'
      return truncateOutput(output)
    } catch (err) {
      return `Command execution failed: ${(err as Error).message}`
    } finally {
      try {
        context.terminalService.destroySession(sessionId)
      } catch {
        // Ignore cleanup errors
      }
    }
  },
}

function truncateOutput(output: string): string {
  if (output.length > MAX_OUTPUT_LENGTH) {
    const truncated = output.slice(0, MAX_OUTPUT_LENGTH)
    return `${truncated}\n\n... [Output truncated: ${output.length} chars total, showing first ${MAX_OUTPUT_LENGTH}]`
  }
  return output
}
