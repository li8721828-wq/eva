import type { Conversation, ToolCall } from '../../shared/types/conversation'
import type { TaskArtifactItem, TaskArtifactRun, TaskRunSnapshot } from '../../shared/types/task'

function stringArgument(toolCall: ToolCall, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = toolCall.arguments[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function itemFromToolCall(toolCall: ToolCall): TaskArtifactItem {
  return {
    id: toolCall.id,
    kind: 'tool',
    title: toolCall.name.replaceAll('_', ' '),
    detail: toolCall.isError ? toolCall.result : undefined,
    isError: Boolean(toolCall.isError),
  }
}

function collectToolArtifacts(toolCalls: ToolCall[]): Pick<TaskArtifactRun, 'sources' | 'files' | 'tools'> {
  const sources: TaskArtifactItem[] = []
  const files: TaskArtifactItem[] = []
  const tools: TaskArtifactItem[] = []

  for (const toolCall of toolCalls) {
    tools.push(itemFromToolCall(toolCall))
    if (toolCall.name === 'web_search') {
      const query = stringArgument(toolCall, 'query') || 'Web search'
      sources.push({
        id: `source-${toolCall.id}`,
        kind: 'source',
        title: query,
        detail: 'Search query',
        result: toolCall.result,
        isError: Boolean(toolCall.isError),
      })
    }
    if (toolCall.name === 'read_web_page') {
      const url = stringArgument(toolCall, 'url', 'href') || 'Web page'
      sources.push({
        id: `page-${toolCall.id}`,
        kind: 'source',
        title: url,
        detail: 'Read web page',
        url,
        result: toolCall.result,
        isError: Boolean(toolCall.isError),
      })
    }
    if ((toolCall.name === 'write_file' || toolCall.name === 'edit_file') && !toolCall.isError) {
      const filePath = stringArgument(toolCall, 'path', 'filePath', 'file_path') || 'Generated file'
      files.push({
        id: `file-${toolCall.id}`,
        kind: 'file',
        title: filePath.split(/[\\/]/).filter(Boolean).pop() || filePath,
        detail: 'Written by this task',
        path: filePath,
      })
    }
  }

  return {
    sources: mergeArtifacts(sources, (item) => `${item.detail || ''}:${item.url || item.title}`),
    files: mergeArtifacts(files, (item) => item.path || item.title),
    tools: mergeArtifacts(tools, (item) => `${item.title}:${item.isError ? 'error' : 'success'}`),
  }
}

function mergeArtifacts(
  items: TaskArtifactItem[],
  keyFor: (item: TaskArtifactItem) => string,
): TaskArtifactItem[] {
  const merged = new Map<string, TaskArtifactItem>()
  for (const item of items) {
    const key = keyFor(item)
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { ...item, count: 1 })
      continue
    }
    merged.set(key, {
      ...existing,
      count: (existing.count || 1) + 1,
      // The most recent result is generally the useful one for a repeated
      // read/search/write, while the count preserves the full audit signal.
      result: item.result || existing.result,
      isError: existing.isError && item.isError,
    })
  }
  return [...merged.values()]
}

/**
 * Converts durable task snapshots into a project-friendly results index.
 * The original snapshot remains the source of truth; no model output is copied.
 */
export function toTaskArtifactRun(snapshot: TaskRunSnapshot, conversation: Conversation): TaskArtifactRun {
  const goal = snapshot.goal || snapshot.progress?.goal || snapshot.plan?.goal || conversation.title || 'Untitled task'
  const goalSteps = snapshot.progress?.steps || []
  const teamSteps = snapshot.plan?.subtasks || []
  const steps: TaskArtifactItem[] = goalSteps.length > 0
    ? goalSteps.map((step) => ({
      id: step.id,
      kind: 'step',
      title: step.description,
      status: step.status,
      result: step.result,
    }))
    : teamSteps.map((step) => ({
      id: step.id,
      kind: 'step',
      title: step.title,
      detail: step.assignedAgentName ? `${step.assignedAgentName}${step.assignedModel ? ` · ${step.assignedModel}` : ''}` : step.description,
      status: step.status,
      result: step.result,
    }))
  const toolCalls = goalSteps.length > 0
    ? goalSteps.flatMap((step) => step.toolCalls || [])
    : teamSteps.flatMap((step) => step.toolCalls || [])
  const artifacts = collectToolArtifacts(toolCalls)

  return {
    conversationId: conversation.id,
    conversationTitle: conversation.title || 'Untitled task',
    agentId: conversation.agentId,
    workspaceId: conversation.workspaceId,
    kind: snapshot.kind,
    status: snapshot.status,
    goal,
    summary: snapshot.summary || snapshot.progress?.summary,
    error: snapshot.error,
    updatedAt: snapshot.updatedAt,
    steps,
    ...artifacts,
    checkpoints: snapshot.checkpoints || [],
  }
}
