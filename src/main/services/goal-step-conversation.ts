import { v4 as uuidv4 } from 'uuid'
import type { AgentConfig } from '../../shared/types/agent'
import type { Conversation, ChatMessage, ToolCall } from '../../shared/types/conversation'
import type { GoalEvent } from '../agent-engine/goal-planner'
import type { GoalStep, GoalStepHandoff } from '../../shared/types/task'
import { getStorage } from '../storage'
import { sanitizeToolHistory } from '../agent-engine/tool-history'

export function goalStepHandoffPrompt(handoff: GoalStepHandoff, continuation = false): string {
  const dependencies = handoff.dependencyResults.length
    ? handoff.dependencyResults.map((item) => `- ${item.stepId}: ${item.description}\n  Result: ${item.result}`).join('\n')
    : '(No upstream step results.)'
  return [
    `Goal: ${handoff.goal}`,
    `Assigned step: ${handoff.step}`,
    `Workspace: ${handoff.workspacePath || '(not restricted to one workspace)'}`,
    'Acceptance criteria:',
    ...handoff.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    'Upstream handoffs:',
    dependencies,
    continuation
      ? 'Continue this isolated Goal step from the saved child conversation. Re-check the current evidence before taking another action.'
      : 'This is an isolated Goal step conversation. Work only on this step. Do not assume another step completed unless its handoff above says so.',
  ].join('\n')
}

export async function prepareGoalStepConversation(input: {
  parent: Conversation
  agentConfig: AgentConfig
  workspacePath: string
  step: GoalStep
  handoff: GoalStepHandoff
}): Promise<{ conversationId: string; messages: ChatMessage[]; message: ChatMessage }> {
  const existingId = input.step.agentConversationId
  const existing = existingId ? await getStorage().conversations.getConversation(existingId) : null
  const conversation = existing || await getStorage().conversations.createConversation({
    title: `Goal step ${input.step.index + 1}: ${input.step.description.slice(0, 72)}`,
    titleSource: 'manual',
    agentId: input.agentConfig.id,
    mode: 'goal',
    workspaceId: input.parent.workspaceId,
    accessScope: input.parent.accessScope,
    permissionLevel: input.parent.permissionLevel,
    fileAccessGrants: input.parent.fileAccessGrants,
    workspacePath: input.parent.workspacePath || input.workspacePath,
    parentConversationId: input.parent.id,
    goalStepId: input.step.id,
  })
  const continuation = Boolean(existing)
  const message: ChatMessage = {
    id: uuidv4(),
    conversationId: conversation.id,
    role: 'user',
    content: goalStepHandoffPrompt(input.handoff, continuation),
    agentId: input.agentConfig.id,
    agentName: input.agentConfig.name,
    timestamp: Date.now(),
  }
  const history = continuation
    ? sanitizeToolHistory(await getStorage().conversations.getMessages(conversation.id))
    : []
  await getStorage().conversations.addMessage(conversation.id, message)
  await getStorage().conversations.updateConversation(conversation.id, { executionStatus: 'running', executionUpdatedAt: Date.now() })
  return { conversationId: conversation.id, messages: history, message }
}

export async function persistGoalStepEvent(input: {
  step: GoalStep
  conversationId: string
  event: Extract<GoalEvent, { type: 'step_progress' | 'step_tool_call' | 'step_tool_result' | 'step_completed' | 'step_failed' }>
  agentConfig: AgentConfig
}): Promise<void> {
  const { event, conversationId, agentConfig } = input
  if (event.type === 'step_progress') return

  let role: ChatMessage['role'] = 'assistant'
  let content = ''
  let toolCalls: ToolCall[] | undefined
  if (event.type === 'step_tool_call') {
    content = ''
    toolCalls = [event.toolCall]
  } else if (event.type === 'step_tool_result') {
    role = 'tool'
    content = event.result
  } else if (event.type === 'step_completed') {
    content = event.result
  } else if (event.type === 'step_failed') {
    content = `Error: ${event.error}`
  }

  await getStorage().conversations.addMessage(conversationId, {
    id: uuidv4(),
    conversationId,
    role,
    content,
    toolCalls,
    ...(event.type === 'step_tool_result' ? { toolCallId: event.toolCallId } : {}),
    agentId: agentConfig.id,
    agentName: agentConfig.name,
    providerId: agentConfig.providerId,
    providerName: getStorage().config.getProvider(agentConfig.providerId)?.name || agentConfig.providerId,
    model: agentConfig.model,
    timestamp: Date.now(),
  })

  if (event.type === 'step_completed' || event.type === 'step_failed') {
    await getStorage().conversations.updateConversation(conversationId, {
      executionStatus: event.type === 'step_completed' ? 'completed' : 'failed',
      executionUpdatedAt: Date.now(),
    })
  }
}
