import { buildPlanChecklist, type PlanChecklist } from '../../../../shared/plan-checklist'
import type { ProgressUpdate } from '../../../../shared/types/conversation'
import {
  ACP_UPDATE,
  type AcpContentBlock,
  type AcpPlanEntry,
  type AcpSessionNotification,
  type AcpSessionUpdate,
  type AcpToolCall,
  type AcpToolCallStatus,
} from './protocol'

/**
 * Eva's app-server events are shaped for its own renderer. These helpers
 * re-express them as ACP `session/update` payloads and nothing else: no I/O, no
 * state, so the translation can be read and tested without a socket.
 */

export function textBlock(text: string): AcpContentBlock {
  return { type: 'text', text }
}

export function messageChunk(sessionId: string, messageId: string, text: string): AcpSessionNotification {
  return { sessionId, update: { sessionUpdate: ACP_UPDATE.AGENT_MESSAGE_CHUNK, messageId, content: textBlock(text) } }
}

export function thoughtChunk(sessionId: string, text: string): AcpSessionNotification {
  return { sessionId, update: { sessionUpdate: ACP_UPDATE.AGENT_THOUGHT_CHUNK, content: textBlock(text) } }
}

const TOOL_LABELS: Record<string, string> = {
  read_file: '读取文件',
  list_directory: '列出目录',
  search_files: '搜索文件',
  search_code: '搜索代码',
  search_by_regex: '正则搜索',
  file_info: '查看文件信息',
  write_file: '写入文件',
  edit_file: '编辑文件',
  execute_command: '执行命令',
  write_terminal: '终端执行',
  read_terminal: '读取终端',
  web_search: '联网搜索',
  read_web_page: '读取网页',
  create_execution_plan: '制定执行计划',
}

/**
 * Search term, command, path or URL: an ACP client shows this as the tool line.
 * `query` comes first because only search tools carry it, and `search_code`
 * pairs it with a directory in `path`.
 */
const TOOL_TITLE_TARGETS = ['query', 'command', 'path', 'file_path', 'url', 'pattern', 'directory'] as const

export function toolCallTitle(toolName: string, args: Record<string, unknown> | undefined): string {
  const label = TOOL_LABELS[toolName] || toolName
  const target = TOOL_TITLE_TARGETS.map((key) => args?.[key]).find((value): value is string => typeof value === 'string' && value.trim().length > 0)
  const text = (target ?? '').trim()
  if (!text) return label
  return `${label} ${text.length > 160 ? `${text.slice(0, 160)}…` : text}`
}

export function toolCallKind(toolName: string): AcpToolCall['kind'] {
  if (toolName === 'execute_command' || toolName === 'write_terminal' || toolName === 'read_terminal') return 'execute'
  if (toolName === 'write_file' || toolName === 'edit_file') return 'edit'
  if (toolName === 'read_file' || toolName === 'list_directory' || toolName.startsWith('search')) return 'read'
  if (toolName === 'web_search' || toolName === 'read_web_page') return 'fetch'
  return 'other'
}

export function toolCallUpdate(sessionId: string, toolCallId: string, title: string, toolName: string): AcpSessionNotification {
  const call: AcpToolCall = { toolCallId, title, kind: toolCallKind(toolName), status: 'in_progress' as AcpToolCallStatus }
  return { sessionId, update: { sessionUpdate: ACP_UPDATE.TOOL_CALL, toolCall: call } }
}

export function toolCallFinished(sessionId: string, toolCallId: string, isError: boolean): AcpSessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: ACP_UPDATE.TOOL_CALL_UPDATE,
      toolCallId,
      status: isError ? 'failed' : 'completed',
    },
  }
}

export function planUpdate(sessionId: string, checklist: PlanChecklist, streaming: boolean): AcpSessionNotification | undefined {
  if (!checklist.items.length) return undefined
  const activeIndex = streaming ? checklist.items.find((item) => !item.done)?.index : undefined
  const entries: AcpPlanEntry[] = checklist.items.map((item) => ({
    content: item.text,
    priority: 'medium',
    status: item.done ? 'completed' : item.index === activeIndex ? 'in_progress' : 'pending',
  }))
  return { sessionId, update: { sessionUpdate: ACP_UPDATE.PLAN, entries } }
}

/**
 * The plan an ACP client should see right now, derived from the same progress
 * reports the desktop checklist is built from. A step report with no plan yet
 * produces nothing, and `overflowStepCount` has no ACP counterpart, so it is
 * carried as a thought chunk instead of being dropped silently.
 */
export function projectPlan(
  sessionId: string,
  progressUpdates: ProgressUpdate[],
  streaming: boolean,
): AcpSessionNotification[] {
  const checklist = buildPlanChecklist(progressUpdates)
  if (!checklist) return []
  const updates: AcpSessionNotification[] = []
  const plan = planUpdate(sessionId, checklist, streaming)
  if (plan) updates.push(plan)
  if (checklist.overflowStepCount > 0) {
    const lastStep = [...progressUpdates].reverse().find((update) => update.kind === 'step')
    if (lastStep) updates.push(thoughtChunk(sessionId, `该步骤没有可勾选的计划条目（计划外汇报 ${checklist.overflowStepCount} 条）：${lastStep.content}`))
  }
  return updates
}
