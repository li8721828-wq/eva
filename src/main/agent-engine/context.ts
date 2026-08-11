import type { ChatMessageInput, ToolDefinition } from '../../shared/types/provider'
import type { AgentConfig } from '../../shared/types/agent'
import type { ChatMessage } from '../../shared/types/conversation'
import { CONTEXT_WINDOW_TOKENS } from '../../shared/constants'
import type { FileAccessGrant } from '../../shared/types/file-access'

const RECENT_RAW_MESSAGE_LIMIT = 14
const COMPRESSED_HISTORY_MAX_CHARS = 8_000
const OLD_MESSAGE_MAX_CHARS = 520
const OLD_TOOL_RESULT_MAX_CHARS = 300
const RECENT_TOOL_RESULT_MAX_CHARS = 3_500
const CONTEXT_SAFETY_TOKENS = 2_048

function compactText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized

  const headLength = Math.floor(maxChars * 0.72)
  const tailLength = maxChars - headLength
  return `${normalized.slice(0, headLength)} … ${normalized.slice(-tailLength)}`
}

export interface ContextOptions {
  agentConfig: AgentConfig
  messages: ChatMessage[]
  workspacePath: string
  fileAccessGrants?: FileAccessGrant[]
  fullFilesystemAccess?: boolean
  maxContextTokens?: number
  tools: ToolDefinition[]
}

/**
 * Convert a stored ChatMessage to the LLM input format.
 */
function chatMessageToInput(msg: ChatMessage, maxToolResultChars?: number): ChatMessageInput {
  const imageNotice = msg.images?.length
    ? `\n\nAttached reference images (use these exact paths when calling Blender tools):\n${msg.images.map((image) => `- ${image.path}`).join('\n')}`
    : ''
  const input: ChatMessageInput = {
    role: msg.role,
    content: `${msg.role === 'tool' && maxToolResultChars ? compactText(msg.content || '', maxToolResultChars) : msg.content || ''}${imageNotice}`,
    images: msg.images?.map((image) => ({
      mediaType: image.mediaType,
      dataUrl: image.dataUrl,
      name: image.name,
    })),
  }
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    input.toolCalls = msg.toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    }))
  }
  if (msg.toolCallId) {
    input.toolCallId = msg.toolCallId
  }
  return input
}

export class ContextManager {
  private compressHistory(messages: ChatMessage[], rawHistoryBudget: number): { memory: string; recent: ChatMessage[] } {
    const historyTokens = messages.reduce((total, message) => {
      const toolCalls = message.toolCalls?.length ? JSON.stringify(message.toolCalls) : ''
      return total + this.estimateTokens(`${message.content || ''}${toolCalls}`)
    }, 0)

    // A long-context model should retain all available turns while they still
    // fit. The old fixed 14-message rule prevented DeepSeek V4's 1M context
    // window from being used even for modest, text-heavy conversations.
    if (historyTokens <= rawHistoryBudget) return { memory: '', recent: messages }

    if (messages.length <= RECENT_RAW_MESSAGE_LIMIT) return { memory: '', recent: messages }

    let recentStart = Math.max(0, messages.length - RECENT_RAW_MESSAGE_LIMIT)
    // Do not start a retained window halfway through a tool-call exchange.
    while (recentStart > 0 && messages[recentStart].role === 'tool') recentStart -= 1
    while (recentStart > 0 && messages[recentStart - 1].role === 'assistant' && messages[recentStart - 1].toolCalls?.length) {
      recentStart -= 1
    }

    const olderMessages = messages.slice(0, recentStart)
    const lines = olderMessages.map((message) => {
      if (message.role === 'tool') {
        return `Tool ${message.toolCallId || 'result'}: ${compactText(message.content || '', OLD_TOOL_RESULT_MAX_CHARS)}`
      }
      if (message.role === 'assistant' && message.toolCalls?.length) {
        return `Assistant tool calls: ${message.toolCalls.map((toolCall) => toolCall.name).join(', ')}`
      }
      const label = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : 'System'
      return `${label}: ${compactText(message.content || '', OLD_MESSAGE_MAX_CHARS)}`
    })

    const body = compactText(lines.join('\n'), COMPRESSED_HISTORY_MAX_CHARS)
    return {
      memory: [
        '--- Compressed prior conversation ---',
        'This deterministic memory summarizes earlier turns. Treat it as context, not as newly verified evidence. Full tool outputs remain available in Tool activity when the user needs to inspect them.',
        body,
        '--- End compressed prior conversation ---',
      ].join('\n'),
      recent: messages.slice(recentStart),
    }
  }

  /**
   * Build the complete message list to send to the LLM.
   * 1. Inject system prompt (agent config + workspace info + tools)
   * 2. Convert stored ChatMessage[] to ChatMessageInput[]
   * 3. Trim to fit within the context window (most recent messages first)
   */
  buildContext(options: ContextOptions): ChatMessageInput[] {
    const { agentConfig, messages, workspacePath, fileAccessGrants, fullFilesystemAccess, tools } = options
    const maxTokens = options.maxContextTokens ?? CONTEXT_WINDOW_TOKENS

    const baseSystemPrompt = this.buildSystemPrompt(agentConfig, workspacePath, fileAccessGrants, fullFilesystemAccess, tools)
    const rawHistoryBudget = Math.max(0, maxTokens - this.estimateTokens(baseSystemPrompt) - CONTEXT_SAFETY_TOKENS)
    const history = this.compressHistory(messages, rawHistoryBudget)
    const systemPrompt = history.memory ? `${baseSystemPrompt}\n\n${history.memory}` : baseSystemPrompt

    const systemMessage: ChatMessageInput = {
      role: 'system',
      content: systemPrompt,
    }

    const historyMessages: ChatMessageInput[] = history.recent.map((message) => chatMessageToInput(message, RECENT_TOOL_RESULT_MAX_CHARS))

    const allMessages: ChatMessageInput[] = [systemMessage, ...historyMessages]

    return this.trimMessages(allMessages, maxTokens)
  }

  /**
   * Rough token estimation: ~4 characters per token.
   * This is a coarse approximation; production use could integrate tiktoken.
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
  }

  /**
   * Trim messages to fit within the token budget.
   * Strategy:
   * - Always keep the system prompt (index 0)
   * - Keep the most recent messages
   * - Ensure assistant tool_call and tool tool_result pairs stay together
   */
  trimMessages(messages: ChatMessageInput[], maxTokens: number): ChatMessageInput[] {
    if (messages.length === 0) return messages

    const systemMsg = messages[0]
    const systemTokens = this.estimateTokens(systemMsg.content)
    let remainingBudget = maxTokens - systemTokens

    if (remainingBudget <= 0) {
      // System prompt alone exceeds budget; return it truncated
      return [{ role: 'system', content: systemMsg.content.slice(0, maxTokens * 4) }]
    }

    // Walk backwards from most recent to find how many fit
    const history = messages.slice(1)
    const keepFrom: number[] = []
    let usedTokens = 0

    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i]
      const msgText = msg.content + (msg.toolCalls ? JSON.stringify(msg.toolCalls) : '')
      const msgTokens = this.estimateTokens(msgText) + (msg.images?.length || 0) * 1_000

      if (usedTokens + msgTokens > remainingBudget) break

      keepFrom.unshift(i)
      usedTokens += msgTokens
    }

    // Ensure tool_call / tool_result pairs are kept together:
    // If we included a 'tool' message but dropped its corresponding assistant tool_call, drop the tool msg.
    // If we included an assistant tool_call but dropped its tool result, drop the assistant msg.
    const keptMessages = keepFrom.map((i) => history[i])

    // Collect all tool_call ids present in kept assistant messages
    const assistantToolCallIds = new Set<string>()
    const toolResultIds = new Set<string>()

    for (const msg of keptMessages) {
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          assistantToolCallIds.add(tc.id)
        }
      }
      if (msg.role === 'tool' && msg.toolCallId) {
        toolResultIds.add(msg.toolCallId)
      }
    }

    // Filter: keep tool messages only if their assistant tool_call is present
    // Keep assistant tool_call messages only if ALL their tool results are present (or none needed yet)
    const filtered = keptMessages.filter((msg) => {
      if (msg.role === 'tool' && msg.toolCallId) {
        return assistantToolCallIds.has(msg.toolCallId)
      }
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        // Keep if at least one corresponding tool result exists, OR if this is the last message
        const allIds = msg.toolCalls.map((tc) => tc.id)
        const hasAnyResult = allIds.some((id) => toolResultIds.has(id))
        // If we're mid-conversation and results were trimmed, drop the call too
        return hasAnyResult || allIds.every((id) => !toolResultIds.has(id))
      }
      return true
    })

    return [systemMsg, ...filtered]
  }

  /**
   * Build an enhanced system prompt that includes:
   * - Agent's base system prompt
   * - Workspace path
   * - Current date/time
   * - Available tool descriptions
   */
  buildSystemPrompt(
    agentConfig: AgentConfig,
    workspacePath: string,
    fileAccessGrants: FileAccessGrant[] | undefined,
    fullFilesystemAccess: boolean | undefined,
    tools: ToolDefinition[]
  ): string {
    const parts: string[] = []

    parts.push(agentConfig.systemPrompt)

    parts.push('')
    parts.push('--- Eva Platform Capabilities ---')
    const internalCapabilities: string[] = []
    if (tools.some((tool) => tool.name === 'delegate_to_team')) internalCapabilities.push('Team orchestration: for complex work, call delegate_to_team directly. The team leader may compose task-scoped custom specialists when the saved agents do not fit; each gets isolated context, an appropriate configured model, and only allowed tools. Do not ask the user to switch modes.')
    if (tools.some((tool) => tool.name === 'run_task')) internalCapabilities.push('Task execution: call run_task for a bounded implementation or investigation that can be carried out by an isolated worker with the current permissions.')
    if (tools.some((tool) => tool.name === 'run_goal')) internalCapabilities.push('Goal execution: call run_goal for long-lived, measurable multi-step work that needs progress evaluation.')
    if (tools.some((tool) => tool.name === 'manage_goal')) internalCapabilities.push('Goal control: call manage_goal to inspect, pause, continue, or cancel this conversation\'s Goal. Use it whenever the user asks to control Goal work; do not redirect them to Task Center as a substitute.')
    if (tools.some((tool) => tool.name === 'create_execution_plan')) internalCapabilities.push('Execution planning: call create_execution_plan when a structured plan is needed before work.')
    if (tools.some((tool) => tool.name === 'apply_spec_template')) internalCapabilities.push('Specification templates: call apply_spec_template when an existing template provides useful structure.')
    if (internalCapabilities.length) {
      parts.push('Internal capabilities available to this conversation:')
      internalCapabilities.forEach((capability) => parts.push(`- ${capability}`))
      if (tools.some((tool) => tool.name === 'run_goal')) {
        parts.push('Execution policy: for any request with two or more substantive actions, research plus synthesis, file changes plus verification, or an outcome that cannot be completed in one atomic action, call run_goal before beginning work. Do not place a duplicate detailed plan in the chat response; the task workspace presents the plan and live checklist. Work directly only for a genuinely atomic request.')
      }
    }
    parts.push('Each agent can have its own permitted tools and candidate model connections. The runtime chooses only from that agent\'s configured candidates; a connection hidden from the chat picker can still be assigned to an agent.')
    parts.push('Never claim that Eva lacks a capability without checking the tools and permissions listed below. State only the capabilities currently available to this agent.')
    parts.push('')
    parts.push('--- Evidence and Action Integrity ---')
    parts.push('Separate verified facts, inferences, and suggestions. Never invent a source, citation, file path, command output, external action, test result, collaboration result, or real-time fact.')
    parts.push('Report tool failures, denied permissions, unavailable services, and incomplete evidence plainly. Never claim to have searched the web, read or written files, executed a command, or completed delegated work unless the corresponding tool result confirms it.')
    parts.push('For current or web-derived claims, use only sources returned in this execution. If web search or page reading fails, say that current information could not be verified; you may offer clearly-labelled general/offline reasoning, but never present it as current research.')
    parts.push('For file changes, do not say the saved content is correct or complete until it has been independently checked with read_file or an equivalent inspection. If verification is unavailable, say the write is unverified.')
    parts.push('When the required capability is absent, do not work around it by guessing. State the blocked action, the reason, and the smallest next step: grant a tool, configure a service, provide a source, or approve an action.')
    parts.push('Tools are atomic operations, not workflow controllers. Choose the tool sequence yourself from the task and previous evidence. Use project metadata only as an optional candidate locator; use search_code for exact or broad occurrence coverage and read_file for source evidence. Do not treat any index result as a conclusion.')
    if (tools.some((tool) => tool.name === 'desktop_observe') && tools.some((tool) => tool.name === 'mouse_control')) {
      parts.push('--- Visible Desktop Control Protocol ---')
      parts.push('Use this protocol only when the user explicitly requests desktop control, mouse control, keyboard control, or a visible on-screen operation. Do not infer desktop control merely because a normal request could also be completed through a visible application; in ordinary tasks, choose the most appropriate permitted tool yourself, including execute_command.')
      parts.push('For an explicitly requested desktop-control task, start desktop_session for a multi-step task and follow this loop: desktop_observe -> mouse_control or keyboard_control -> desktop_observe verification. If visible control is blocked or unreliable, explain the observed limitation and ask the user before switching to a command, browser automation, or another non-visible fallback. Never silently substitute a background/system action for a requested visible action.')
      parts.push('Act only on controls returned by the most recent desktop_observe result. Prefer semantic taskbar or foreground controls over coordinates. Do not close, minimize, or rearrange unrelated applications just to reveal another one. Do not claim a visible action occurred unless mouse_control or keyboard_control returned a verified result.')
      parts.push('If the required target is not visible, input is unavailable, or the visible result cannot be verified, stop and report the limitation. Wait for the user\'s approval before using any non-visible fallback.')
    }
    parts.push(`Current agent model: ${agentConfig.providerId} / ${agentConfig.model}`)
    if (agentConfig.modelCandidates?.length) {
      parts.push(`Candidate models for delegated work: ${agentConfig.modelCandidates.map((candidate) => `${candidate.providerId}/${candidate.model}`).join(', ')}`)
    }

    parts.push('')
    parts.push('--- Environment ---')
    parts.push(`Workspace: ${workspacePath}`)
    if (fullFilesystemAccess) {
      parts.push('File access: full local filesystem access is enabled.')
    } else if (fileAccessGrants?.length) {
      parts.push('Additional file permissions:')
      for (const grant of fileAccessGrants) {
        parts.push(`- ${grant.path} (${grant.access})`)
      }
    }
    // Keep the common prompt prefix stable within a day so providers that support
    // prompt caching can reuse it across turns instead of missing every second.
    parts.push(`Current date: ${new Date().toISOString().slice(0, 10)}`)

    if (tools.length > 0) {
      parts.push('')
      parts.push('--- Available Tools ---')
      for (const tool of tools) {
        parts.push(`- ${tool.name}: ${tool.description}`)
      }
    }

    return parts.join('\n')
  }
}
