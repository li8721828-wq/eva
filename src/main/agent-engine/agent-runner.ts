import type { LLMProvider } from '../providers/base-provider'
import type { ToolExecutor, ToolContext, ToolRegistry, FileService, TerminalService } from '../tools'
import type { AgentConfig, AgentEvent } from '../../shared/types/agent'
import type { ChatMessage } from '../../shared/types/conversation'
import type { ToolDefinition, ChatMessageInput, ChatChunk } from '../../shared/types/provider'
import { ContextManager } from './context'
import { DEFAULT_MAX_ITERATIONS } from '../../shared/constants'
import type { FileAccessGrant } from '../../shared/types/file-access'

export interface AgentRunnerConfig {
  agentConfig: AgentConfig
  provider: LLMProvider
  toolRegistry: ToolRegistry
  contextManager: ContextManager
  maxIterations?: number
  workspacePath: string
  fileAccessGrants?: FileAccessGrant[]
  fullFilesystemAccess?: boolean
  fileService: FileService
  terminalService: TerminalService
}

export interface RunParams {
  messages: ChatMessage[]
  newMessage: string
}

interface CompletedToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export class AgentRunner {
  private config: AgentRunnerConfig
  private abortController: AbortController | null = null
  private isRunning = false

  constructor(config: AgentRunnerConfig) {
    this.config = config
  }

  /**
   * Execute the ReAct (Reason-Act) loop.
   *
   * Flow per iteration:
   *  1. Build/update context messages
   *  2. Stream LLM response → yield real-time text_delta events
   *  3. If no tool_calls → yield { type: 'done' } and stop
   *  4. If tool_calls → yield text (full reasoning), execute each tool,
   *     yield tool_call / tool_result events, append to history, loop
   *  5. Abort or max-iterations → stop
   */
  async *run(params: RunParams): AsyncGenerator<AgentEvent> {
    if (this.isRunning) {
      yield { type: 'error', error: 'AgentRunner is already running' }
      return
    }

    this.isRunning = true
    this.abortController = new AbortController()

    try {
      const { agentConfig, toolRegistry, contextManager, workspacePath, fileAccessGrants, fullFilesystemAccess } = this.config
      const maxIter = this.config.maxIterations ?? agentConfig.maxIterations ?? DEFAULT_MAX_ITERATIONS

      // Tool definitions filtered by agent's allowed tool list
      const toolDefs: ToolDefinition[] = toolRegistry.getDefinitionsByNames(agentConfig.tools)

      // Build initial context: system prompt + history + new user message
      const userMessage: ChatMessage = {
        id: '__pending_user_msg__',
        conversationId: '',
        role: 'user',
        content: params.newMessage,
        timestamp: Date.now(),
      }
      const allHistory = [...params.messages, userMessage]

      let messages: ChatMessageInput[] = contextManager.buildContext({
        agentConfig,
        messages: allHistory,
        workspacePath,
        fileAccessGrants,
        fullFilesystemAccess,
        tools: toolDefs,
      })

      // ── ReAct loop ──────────────────────────────────────────────────────────
      for (let iteration = 0; iteration < maxIter; iteration++) {
        if (this.abortController.signal.aborted) {
          yield { type: 'done', content: '' }
          return
        }

        // Call LLM (yields real-time text_delta events to caller)
        const response = yield* this.executeLLMCall(messages, toolDefs)

        const hasToolCalls = response.toolCalls.length > 0

        // If the assistant produced text AND is about to call tools,
        // emit the full reasoning text so the renderer has a stable snapshot
        // before potentially long-running tool executions.
        if (hasToolCalls && response.content) {
          yield { type: 'text', content: response.content }
        }

        // No tool calls → the model is done reasoning
        if (!hasToolCalls) {
          yield { type: 'done', content: response.content }
          return
        }

        // Execute each tool call sequentially
        const toolResults = new Map<string, { result: string; isError: boolean }>()

        for (const toolCall of response.toolCalls) {
          // Emit tool_call event
          yield {
            type: 'tool_call',
            toolCall: {
              id: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.arguments,
            },
          }

          // Execute the tool
          const toolContext: ToolContext = {
            workspacePath,
            fileAccessGrants,
            fullFilesystemAccess,
            fileService: this.config.fileService,
            terminalService: this.config.terminalService,
          }
          const result = await this.executeTool(toolCall, toolContext)
          toolResults.set(toolCall.id, result)

          // Emit tool_result event
          yield {
            type: 'tool_result',
            toolResult: {
              toolCallId: toolCall.id,
              name: toolCall.name,
              result: result.result,
              isError: result.isError,
            },
          }
        }

        // Append assistant tool_calls + tool results to message history
        messages = this.appendToolMessages(messages, response.toolCalls, toolResults)
      }

      // Exceeded max iterations
      yield { type: 'error', error: `Maximum iterations (${maxIter}) reached` }
      yield { type: 'done', content: '' }
    } catch (err: any) {
      if (this.abortController?.signal.aborted) {
        yield { type: 'done', content: '' }
      } else {
        const errorMsg = err?.message ?? String(err)
        yield { type: 'error', error: errorMsg }
        yield { type: 'done', content: '' }
      }
    } finally {
      this.isRunning = false
      this.abortController = null
    }
  }

  /** Abort the current execution. */
  abort(): void {
    if (this.abortController && !this.abortController.signal.aborted) {
      this.abortController.abort()
    }
  }

  /** Whether the runner is currently executing. */
  get running(): boolean {
    return this.isRunning
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  /**
   * Execute a single LLM call with streaming.
   *
   * - Yields `AgentEvent { type: 'text', content: delta }` for each text chunk.
   * - Accumulates tool_call fragments (OpenAI sends arguments as partial JSON strings).
   * - Returns the full accumulated content, completed tool_calls, and finish reason.
   */
  private async *executeLLMCall(
    messages: ChatMessageInput[],
    tools: ToolDefinition[]
  ): AsyncGenerator<AgentEvent, { content: string; toolCalls: CompletedToolCall[]; finishReason: string }> {
    const { agentConfig, provider } = this.config
    const signal = this.abortController?.signal

    const stream: AsyncIterable<ChatChunk> = provider.chat(
      {
        model: agentConfig.model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        temperature: agentConfig.temperature,
        stream: true,
      },
      signal
    )

    let content = ''
    let finishReason = ''

    // Tool call accumulation state (keyed by chunk index)
    const tcAccumulator: Map<number, { id: string; name: string; argsStr: string }> = new Map()

    for await (const chunk of stream) {
      // Check abort between chunks
      if (signal?.aborted) break

      // ── Text content ──────────────────────────────────────────────────────
      if (chunk.content) {
        content += chunk.content
        // Yield real-time text delta to the caller
        yield { type: 'text', content: chunk.content }
      }

      // ── Tool call fragments ───────────────────────────────────────────────
      if (chunk.toolCalls) {
        for (const tc of chunk.toolCalls) {
          let acc = tcAccumulator.get(tc.index)
          if (!acc) {
            acc = { id: tc.id ?? '', name: tc.name ?? '', argsStr: '' }
            tcAccumulator.set(tc.index, acc)
          }
          if (tc.id) acc.id = tc.id
          if (tc.name) acc.name = tc.name
          if (tc.arguments !== undefined) acc.argsStr += tc.arguments
        }
      }

      if (chunk.finishReason) {
        finishReason = chunk.finishReason
      }
    }

    // Parse accumulated tool calls
    const toolCalls: CompletedToolCall[] = []
    const sortedEntries = Array.from(tcAccumulator.entries()).sort(([a], [b]) => a - b)

    for (const [, acc] of sortedEntries) {
      let parsedArgs: Record<string, unknown> = {}
      if (acc.argsStr.trim()) {
        try {
          parsedArgs = JSON.parse(acc.argsStr)
        } catch {
          parsedArgs = { _raw: acc.argsStr }
        }
      }
      toolCalls.push({
        id: acc.id,
        name: acc.name,
        arguments: parsedArgs,
      })
    }

    return { content, toolCalls, finishReason }
  }

  /**
   * Execute a single tool call.
   *
   * 1. Look up the tool in the registry
   * 2. Check the agent is allowed to use it
   * 3. Execute, catching errors and returning them as-is (not thrown)
   */
  private async executeTool(
    toolCall: CompletedToolCall,
    toolContext: ToolContext
  ): Promise<{ result: string; isError: boolean }> {
    const tool: ToolExecutor | undefined = this.config.toolRegistry.get(toolCall.name)

    if (!tool) {
      return { result: `Error: Tool '${toolCall.name}' not found in registry.`, isError: true }
    }

    if (!this.config.agentConfig.tools.includes(toolCall.name)) {
      return {
        result: `Error: Tool '${toolCall.name}' is not permitted for this agent.`,
        isError: true,
      }
    }

    try {
      const result = await tool.execute(toolCall.arguments, toolContext)
      return { result, isError: false }
    } catch (err: any) {
      return { result: `Error: ${err?.message ?? String(err)}`, isError: true }
    }
  }

  /**
   * Append assistant's tool_call message and tool result messages to history.
   * The assistant message carries all tool_calls from one LLM response;
   * each tool gets its own tool-role message with the corresponding toolCallId.
   */
  private appendToolMessages(
    messages: ChatMessageInput[],
    toolCalls: CompletedToolCall[],
    toolResults: Map<string, { result: string; isError: boolean }>
  ): ChatMessageInput[] {
    const updated = [...messages]

    // Assistant message that issued the tool calls
    updated.push({
      role: 'assistant',
      content: '',
      toolCalls: toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      })),
    })

    // One tool message per tool_call result
    for (const tc of toolCalls) {
      const tr = toolResults.get(tc.id)
      updated.push({
        role: 'tool',
        content: tr?.result ?? '',
        toolCallId: tc.id,
      })
    }

    return updated
  }
}
