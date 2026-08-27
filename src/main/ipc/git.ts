import { BrowserWindow } from 'electron'
import { trustedIpcMain as ipcMain } from './trusted-ipc'
import { IPC } from '../../shared/ipc-channels'
import { getStorage } from '../storage'
import { GitWorktreeService } from '../services/git-worktree-service'

const gitWorktrees = new GitWorktreeService()

export function registerGitHandlers(): void {
  ipcMain.handle(IPC.GIT_STATUS, async (_event, conversationId: string) => {
    const conversation = await getStorage().conversations.getConversation(conversationId)
    if (!conversation) throw new Error('Conversation not found.')
    const workspace = conversation.workspaceId ? await getStorage().workspaces.get(conversation.workspaceId) : null
    return gitWorktrees.status(conversation.gitRepositoryPath || workspace?.path || conversation.workspacePath, conversation)
  })

  ipcMain.handle(IPC.GIT_SWITCH_BRANCH, async (event, conversationId: string, branch: string) => {
    const conversation = await getStorage().conversations.getConversation(conversationId)
    if (!conversation) throw new Error('Conversation not found.')
    const workspace = conversation.workspaceId ? await getStorage().workspaces.get(conversation.workspaceId) : null
    const updates = await gitWorktrees.switchBranch(conversation, workspace?.path || conversation.workspacePath, branch)
    await getStorage().conversations.updateConversation(conversationId, updates)
    const updated = await getStorage().conversations.getConversation(conversationId)
    BrowserWindow.fromWebContents(event.sender)?.webContents.send(IPC.CONVERSATION_CHANGED, conversationId)
    return updated
  })
}
