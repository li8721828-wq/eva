import { BrowserWindow, dialog } from 'electron'
import type { ToolApprovalDecision, ToolApprovalRequest } from '../agent-engine/agent-runner'
import { recordActivity } from './activity-log'
import { isAllowedRemoteTerminalCommand } from './remote-command-policy'

interface RemoteToolPolicyContext {
  conversationId: string
  workspaceId?: string
}

function buildOperationSummary(request: ToolApprovalRequest): { title: string; detail: string } {
  if (request.toolCall.name === 'write_file' || request.toolCall.name === 'edit_file') {
    const path = String(request.toolCall.arguments.path || '(missing path)')
    const content = String(request.toolCall.arguments.newContent || request.toolCall.arguments.content || '')
    const preview = content.replace(/\s+/g, ' ').slice(0, 180)
    return {
      title: 'QQ remote file write request',
      detail: `Workspace: ${request.workspacePath}\nFile: ${path}\nContent: ${content.length} characters${preview ? `\nPreview: ${preview}` : ''}`,
    }
  }

  const command = String(request.toolCall.arguments.command || '(missing command)')
  return {
    title: 'QQ remote terminal command request',
    detail: `Workspace: ${request.workspacePath}\nCommand: ${command}`,
  }
}

async function showLocalApproval(title: string, detail: string): Promise<boolean> {
  const parent = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())
  if (!parent) return false
  const result = await dialog.showMessageBox(parent, {
    type: 'warning',
    title,
    message: 'A QQ remote request needs local approval.',
    detail,
    buttons: ['Deny', 'Allow once'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  return result.response === 1
}

/**
 * Remote QQ conversations are read-only until an operation is approved locally.
 * Terminal commands must also match the intentionally narrow allowlist.
 */
export function createRemoteToolApproval(context: RemoteToolPolicyContext): (request: ToolApprovalRequest) => Promise<ToolApprovalDecision> {
  return async (request) => {
    if (request.toolCall.name !== 'write_file' && request.toolCall.name !== 'edit_file' && request.toolCall.name !== 'execute_command') {
      return { approved: true }
    }

    if (request.toolCall.name === 'execute_command') {
      const command = String(request.toolCall.arguments.command || '')
      if (!isAllowedRemoteTerminalCommand(command)) {
        await recordActivity({
          category: 'permission',
          action: 'qq.command_blocked',
          status: 'error',
          summary: 'Blocked a QQ terminal command that is outside the remote allowlist.',
          conversationId: context.conversationId,
          workspaceId: context.workspaceId,
        })
        return {
          approved: false,
          message: 'This terminal command is blocked by the QQ remote security policy. Use the local Eva terminal for custom commands.',
        }
      }
    }

    const operation = buildOperationSummary(request)
    await recordActivity({
      category: 'permission',
      action: 'qq.tool_approval_requested',
      status: 'info',
      summary: `Waiting for local approval: ${request.toolCall.name}.`,
      conversationId: context.conversationId,
      workspaceId: context.workspaceId,
    })

    const approved = await showLocalApproval(operation.title, operation.detail)
    await recordActivity({
      category: 'permission',
      action: approved ? 'qq.tool_approved' : 'qq.tool_rejected',
      status: approved ? 'success' : 'error',
      summary: `${approved ? 'Approved' : 'Rejected'} QQ remote ${request.toolCall.name} locally.`,
      conversationId: context.conversationId,
      workspaceId: context.workspaceId,
    })

    return approved
      ? { approved: true }
      : { approved: false, message: 'This QQ remote operation was rejected on the local computer.' }
  }
}
