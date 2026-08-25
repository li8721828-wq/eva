import type { ToolExecutor, ToolContext } from './index'
import { conversationTerminalSessionId } from '../../shared/terminal-session'
import { setConversationTerminalVisibility } from '../services/terminal-panel-controller'

const MAX_OUTPUT_LENGTH = 10_000
const failedCommandsBySession = new Map<string, string>()

function commandGuardError(command: string): string | undefined {
  // In PowerShell pipeline script blocks, `.Property` is parsed as a command.
  // The current pipeline item must be referenced as `$_.Property` instead.
  const missingPipelineVariable = /\b(?:Where-Object|ForEach-Object|%|\?)\s*\{[^}]*?(?<!\$)\.[A-Za-z_][\w-]*/i.test(command)
  if (missingPipelineVariable) {
    return 'Command blocked before execution: this PowerShell pipeline uses `.Property` inside a script block. Use `$_.Property` (for example, `Where-Object { $_.Extension -match \'\\.ts$\' }`) and submit a corrected command.'
  }
  return undefined
}

function commandFailed(result: { stdout: string; stderr: string; exitCode: number }): boolean {
  return result.exitCode !== 0
    || /(?:commandnotfoundexception|not recognized as|无法将.+识别为|categoryinfo\s*:.*(?:error|objectnotfound))/i.test(`${result.stdout}\n${result.stderr}`)
}

export function createTerminalTools(): ToolExecutor[] {
  return [openTerminalTool, readTerminalTool, writeTerminalTool, executeCommandTool, closeTerminalTool]
}

const openTerminalTool: ToolExecutor = {
  definition: {
    name: 'open_terminal',
    description: 'Open Eva\'s built-in controlled terminal for the current conversation. The user can see it in Eva\'s right panel, and subsequent terminal reads or commands use this same shell.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  async execute(_params: Record<string, unknown>, context: ToolContext): Promise<string> {
    if (!context.conversationId) return 'Opening a controlled terminal requires an active conversation.'
    const sessionId = conversationTerminalSessionId(context.conversationId)
    await context.terminalService.createSession(sessionId, context.workspacePath || process.cwd())
    setConversationTerminalVisibility(context.conversationId, true)
    return 'Opened this conversation\'s controlled terminal in Eva.'
  },
}

const readTerminalTool: ToolExecutor = {
  definition: {
    name: 'read_terminal',
    description: 'Read the recent output from this conversation\'s controlled terminal. This terminal is private to the current conversation and is shared with its visible terminal panel.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  async execute(_params: Record<string, unknown>, context: ToolContext): Promise<string> {
    if (!context.conversationId) return 'Terminal output is available only inside a conversation.'
    const output = context.terminalService.getOutput(conversationTerminalSessionId(context.conversationId))
    return output ? truncateOutput(output) : '(This conversation has no terminal output yet.)'
  },
}

const writeTerminalTool: ToolExecutor = {
  definition: {
    name: 'write_terminal',
    description: 'Type text into this conversation\'s controlled terminal in Eva. Set submit=true to press Enter and run the typed command. This is the direct way to control Eva\'s visible built-in terminal, not a desktop keyboard action.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type into the terminal' },
        submit: { type: 'boolean', description: 'Whether to press Enter after typing (default false)' },
      },
      required: ['text'],
    },
  },
  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    if (!context.conversationId) return 'Writing to a controlled terminal requires an active conversation.'
    const text = typeof params.text === 'string' ? params.text : ''
    if (!text) return 'Terminal text is required.'

    const sessionId = conversationTerminalSessionId(context.conversationId)
    const submitted = params.submit === true
    if (submitted) {
      const guardError = commandGuardError(text)
      if (guardError) return guardError
    }
    await context.terminalService.createSession(sessionId, context.workspacePath || process.cwd())
    setConversationTerminalVisibility(context.conversationId, true)
    context.terminalService.writeInput(sessionId, submitted ? `${text}\r` : text)
    return submitted
      ? 'Typed the text and pressed Enter in this conversation\'s visible terminal.'
      : 'Typed the text in this conversation\'s visible terminal.'
  },
}

const executeCommandTool: ToolExecutor = {
  definition: {
    name: 'execute_command',
    description:
      'Execute a shell command in this conversation\'s visible controlled terminal and return the output. The command and output are shared with Eva\'s right-side terminal panel, so the user can see the action. Use for scripts, installs, builds, system automation, and other terminal work. For direct terminal typing without waiting for output, use write_terminal instead.',
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
    const command = typeof params.command === 'string' ? params.command.trim() : ''
    if (!command) return 'Command execution requires a non-empty command.'

    // An explicit conversation terminal tool grant authorizes control of that
    // visible shell. It is distinct from unrestricted background shell access.
    // One-off calls have no conversation-owned terminal and still require the
    // broader filesystem permission.
    if (!context.fullFilesystemAccess && !context.conversationId) {
      return 'Command execution requires Full filesystem access. Workspace-only and authorized-folder conversations can use file tools, but cannot run an unrestricted local shell.'
    }

    const timeout = Math.min((params.timeout as number) ?? 30_000, 120_000)

    const sessionId = context.conversationId
      ? conversationTerminalSessionId(context.conversationId)
      : `tool_cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const cwd = (params.cwd as string) || context.workspacePath
    const guardError = commandGuardError(command)
    if (guardError) return guardError

    const priorFailure = failedCommandsBySession.get(sessionId)
    if (priorFailure === command) {
      return 'Command blocked: the identical command already failed in this terminal session. Inspect and correct it before retrying; do not submit the same command again.'
    }

    try {
      await context.terminalService.createSession(sessionId, cwd)
      if (context.conversationId) {
        setConversationTerminalVisibility(context.conversationId, true)
      }
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
      if (commandFailed(result)) failedCommandsBySession.set(sessionId, command)
      else failedCommandsBySession.delete(sessionId)
      return truncateOutput(output)
    } catch (err) {
      return `Command execution failed: ${(err as Error).message}`
    } finally {
      // Conversation terminals persist so later tool calls and the visible
      // terminal continue in the same shell. One-off legacy calls still clean up.
      if (!context.conversationId) {
        try {
          context.terminalService.destroySession(sessionId)
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  },
}

const closeTerminalTool: ToolExecutor = {
  definition: {
    name: 'close_terminal',
    description: 'Close this conversation\'s controlled terminal in Eva. This ends only this conversation\'s shell process and does not affect other conversations.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  async execute(_params: Record<string, unknown>, context: ToolContext): Promise<string> {
    if (!context.conversationId) return 'Closing a controlled terminal requires an active conversation.'
    const sessionId = conversationTerminalSessionId(context.conversationId)
    failedCommandsBySession.delete(sessionId)
    context.terminalService.destroySession(sessionId)
    setConversationTerminalVisibility(context.conversationId, false)
    return 'Closed this conversation\'s controlled terminal.'
  },
}

function truncateOutput(output: string): string {
  if (output.length > MAX_OUTPUT_LENGTH) {
    const truncated = output.slice(0, MAX_OUTPUT_LENGTH)
    return `${truncated}\n\n... [Output truncated: ${output.length} chars total, showing first ${MAX_OUTPUT_LENGTH}]`
  }
  return output
}
