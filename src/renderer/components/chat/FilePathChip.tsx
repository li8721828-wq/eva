import type { MouseEvent as ReactMouseEvent } from 'react'
import { FileCode2, FileSpreadsheet, FileText } from 'lucide-react'
import { filePathExtension } from '@/lib/file-path-chip'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { pushToast } from '@/stores/use-toast-store'
import { useWorkspaceStore } from '@/stores/use-workspace-store'

const SPREADSHEET_EXTENSIONS = new Set(['csv', 'xls', 'xlsx'])
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'hpp', 'cs',
  'rb', 'php', 'sh', 'bash', 'ps1', 'sql', 'css', 'scss', 'less', 'vue', 'svelte', 'prisma',
  'graphql', 'zig', 'kt', 'swift', 'lua',
])

function resolveWorkspacePath(conversationId?: string): string {
  const conversation = conversationId
    ? useChatStore.getState().conversations.find((entry) => entry.id === conversationId)
    : undefined
  const workspacePath = conversation?.workspaceId
    ? useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === conversation.workspaceId)?.path || ''
    : ''
  return workspacePath || useAppStore.getState().workspacePath
}

function isAbsoluteLikePath(text: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('/') || text.startsWith('\\')
}

function chipIcon(text: string) {
  const extension = filePathExtension(text)
  if (SPREADSHEET_EXTENSIONS.has(extension)) return FileSpreadsheet
  if (CODE_EXTENSIONS.has(extension)) return FileCode2
  return FileText
}

export function FilePathChip({ text, conversationId }: { text: string; conversationId?: string }) {
  const Icon = chipIcon(text)

  const openInEditor = async () => {
    const workspacePath = resolveWorkspacePath(conversationId)
    if (!workspacePath && !isAbsoluteLikePath(text)) {
      pushToast({ kind: 'warning', title: '未配置工作区', description: '先打开一个工作区文件夹，才能预览相对路径文件。' })
      return
    }
    try {
      const content = await window.eva.file.read(text, workspacePath)
      if (content.startsWith('[Binary file:')) {
        pushToast({ kind: 'info', title: '二进制文件无法预览', description: text })
        return
      }
      const appStore = useAppStore.getState()
      appStore.setCurrentFile({ path: text, content, language: filePathExtension(text) })
      appStore.setRightPanelVisible(true)
      appStore.setRightPanelTab('editor')
    } catch (error) {
      pushToast({ kind: 'error', title: '无法打开文件', description: error instanceof Error ? error.message : String(error) })
    }
  }

  const openSystemMenu = (event: ReactMouseEvent) => {
    event.preventDefault()
    void window.eva.file.showContextMenu({ path: text, workspacePath: resolveWorkspacePath(conversationId), isDirectory: false })
  }

  return (
    <button
      type="button"
      className="markdown-file-chip"
      title="在编辑器中打开 · 右键查看更多"
      onClick={() => void openInEditor()}
      onContextMenu={openSystemMenu}
    >
      <Icon aria-hidden="true" className="markdown-file-chip__icon" />
      <span className="markdown-file-chip__path">{text}</span>
    </button>
  )
}
