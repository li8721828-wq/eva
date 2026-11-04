import { Agent } from '@earendil-works/pi-agent-core'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import {
  collectModel,
  piRequest,
  piUsage,
  toPiMessage,
  resultText,
  zeroUsage,
} from './model-codecs.mjs'

const sdkRoot = import.meta.resolve('@earendil-works/pi-coding-agent')
// Import the pinned native runtime modules without starting CLI/TUI services.
const sdk = Object.assign(
  {},
  ...(await Promise.all(
    [
      './core/tools/index.js',
      './core/session-manager.js',
      './core/compaction/index.js',
    ].map((file) => import(new URL(file, sdkRoot))),
  )),
)
const { buildSystemPrompt } = await import(
  new URL('./core/system-prompt.js', sdkRoot)
)
const { createLocalShellOperations } = await import(
  new URL('./core/tools/bash.js', sdkRoot)
)
const { getShellConfig, getPowerShellConfig } = await import(
  new URL('./utils/shell.js', sdkRoot)
)

export async function runPi(config, bridge) {
  const model = {
    id: config.model.id,
    name: config.model.id,
    api: 'openai-completions',
    provider: 'eva-transport',
    baseUrl: '',
    reasoning: config.model.reasoning,
    input: config.model.vision ? ['text', 'image'] : ['text'],
    cost: zeroUsage().cost,
    contextWindow: config.model.contextWindow,
    maxTokens: config.model.maxTokens,
  }
  const active = new AsyncLocalStorage(),
    native = [],
    dispatched = new Set(),
    attempts = new Map(),
    invalidArguments = new Map()
  if (config.capabilities.read)
    native.push(sdk.createReadTool(config.workspacePath))
  if (config.capabilities.write)
    native.push(sdk.createWriteTool(config.workspacePath))
  if (config.capabilities.edit)
    native.push(sdk.createEditTool(config.workspacePath))
  if (config.capabilities.list)
    native.push(sdk.createLsTool(config.workspacePath))
  if (config.capabilities.shell) {
    const windows = process.platform === 'win32'
    const operations = {
      exec: async (command, cwd, options) => {
        const shell = windows ? getPowerShellConfig() : getShellConfig()
        // Preserve createLocalPowerShellOperations' native UTF-8 preamble.
        const nativeCommand = windows
          ? `try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n${command}`
          : command
        const argv = [
          shell.shell,
          ...shell.args,
          ...(shell.commandTransport === 'stdin' ? [] : [nativeCommand]),
        ]
        const plan = await bridge.rpc('process-plan', {
          id: active.getStore().id,
          argv,
          cwd,
        })
        if (plan.error) throw new Error(plan.error)
        const args =
          shell.commandTransport === 'stdin'
            ? plan.args
            : plan.args.slice(0, -1)
        const backend = createLocalShellOperations(
          windows ? 'PowerShell' : 'bash',
          () => ({
            shell: plan.command,
            args,
            commandTransport: shell.commandTransport,
          }),
        )
        return backend.exec(nativeCommand, plan.cwd, {
          ...options,
          env: { ...options.env, ...plan.envOverrides },
        })
      },
    }
    native.push(
      windows
        ? sdk.createPowerShellTool(config.workspacePath, {
            operations,
            exposeSessionEnvironment: false,
          })
        : sdk.createBashTool(config.workspacePath, {
            operations,
            exposeSessionEnvironment: false,
          }),
    )
  }
  const tools = native.map((tool) => ({
    ...tool,
    execute: async (id, args, signal, onUpdate) => {
      dispatched.add(id)
      const gate = await bridge.rpc('native-start', {
        id,
        name: tool.name,
        arguments: args,
      })
      let result
      try {
        if (!gate.approved) throw new Error(gate.error)
        result = await active.run({ id }, () =>
          tool.execute(id, gate.arguments, signal, onUpdate),
        )
      } catch (error) {
        result = {
          content: [{ type: 'text', text: error.message }],
          details: {},
          isError: true,
        }
      }
      await bridge.rpc('native-result', {
        id,
        result: resultText(result.content),
        isError: Boolean(result.isError),
      })
      return result
    },
  }))
  for (const tool of config.extensions)
    tools.push({
      ...tool,
      label: tool.name,
      execute: async (id, args) => {
        dispatched.add(id)
        const result = await bridge.rpc('extension', {
          id,
          name: tool.name,
          arguments: args,
        })
        return {
          content: [
            { type: 'text', text: result.result },
            ...(result.modelImages || []).map((image) => ({
              type: 'image',
              mimeType: image.mediaType,
              data: image.dataUrl.split(',')[1],
            })),
          ],
          details: {},
          isError: result.isError,
        }
      },
    })
  const stream = (_model, context, _options, purpose = 'turn') => {
    const events = createAssistantMessageEventStream()
    void (async () => {
      let message
      try {
        message = {
          role: 'assistant',
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [],
          usage: zeroUsage(),
          timestamp: Date.now(),
          stopReason: 'stop',
        }
        events.push({ type: 'start', partial: message })
        const request = piRequest(context)
        if (!config.model.vision)
          for (const message of request.messages)
            if (message.images?.length) {
              delete message.images
              message.content +=
                '\nThe selected model cannot inspect the returned image. Do not claim visual verification or guess coordinates.'
            }
        const response = await collectModel(
          bridge.model({
            ...request,
            purpose,
            maxTokens: _options?.maxTokens,
            temperature: _options?.temperature,
          }),
          (chunk) => {
            if (!chunk.content) return
            let index = message.content.findIndex(
              (block) => block.type === 'text',
            )
            if (index < 0) {
              index = message.content.length
              message.content.push({ type: 'text', text: '' })
              events.push({
                type: 'text_start',
                contentIndex: index,
                partial: message,
              })
            }
            message.content[index].text += chunk.content
            events.push({
              type: 'text_delta',
              contentIndex: index,
              delta: chunk.content,
              partial: message,
            })
          },
        )
        for (const call of response.toolCalls) {
          if (call.argumentError)
            invalidArguments.set(call.id, call.argumentError)
          else invalidArguments.delete(call.id)
        }
        message = {
          role: 'assistant',
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [
            ...(response.content
              ? [{ type: 'text', text: response.content }]
              : []),
            ...(response.reasoning
              ? [{ type: 'thinking', thinking: response.reasoning }]
              : []),
            ...response.toolCalls.map((call) => ({
              type: 'toolCall',
              id: call.id,
              name: call.name,
              arguments: call.argumentError
                ? { __invalid_json__: call.rawArguments }
                : call.arguments,
              ...(call.argumentError
                ? { rawArguments: call.rawArguments }
                : {}),
            })),
          ],
          usage: piUsage(response.usage),
          timestamp: Date.now(),
          stopReason:
            response.finishReason === 'length'
              ? 'length'
              : response.toolCalls.length
                ? 'toolUse'
                : 'stop',
        }
        events.push({ type: 'done', reason: message.stopReason, message })
      } catch (error) {
        message = {
          role: 'assistant',
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [],
          usage: zeroUsage(),
          timestamp: Date.now(),
          stopReason: bridge.signal.aborted ? 'aborted' : 'error',
          errorMessage: error.message,
        }
        events.push({
          type: 'error',
          reason: message.stopReason,
          error: message,
        })
      }
      events.end(message)
    })()
    return events
  }
  if (config.sessionDirectory)
    fs.mkdirSync(config.sessionDirectory, { recursive: true })
  const session = config.sessionDirectory
    ? sdk.SessionManager.continueRecent(
        config.workspacePath,
        config.sessionDirectory,
      )
    : sdk.SessionManager.inMemory(config.workspacePath)
  bridge.event({
    type: 'session',
    data: { resumed: config.resumeSession && session.getEntryCount() > 0 },
  })
  const history = (
    config.resumeSession && !session.getEntryCount()
      ? config.fullHistory
      : config.history
  ).filter((message) => message.role !== 'system')
  for (const message of history.slice(0, -1))
    session.appendMessage(toPiMessage(message, model))
  const agent = new Agent({
    initialState: {
      model,
      tools,
      systemPrompt: buildSystemPrompt({
        cwd: config.workspacePath,
        selectedTools: tools.map((tool) => tool.name),
        appendSystemPrompt: config.instructions,
        toolGuidelines: {
          [process.platform === 'win32' ? 'powershell' : 'bash']: [],
        },
        contextFiles: config.projectContext || [],
      }),
      messages: session.buildSessionContext().messages,
    },
    streamFn: stream,
    beforeToolCall: ({ toolCall }) =>
      invalidArguments.has(toolCall.id)
        ? { block: true, reason: invalidArguments.get(toolCall.id) }
        : undefined,
    prepareRequest: async ({ context }, signal) => {
      if (
        context.messages.reduce(
          (total, message) => total + sdk.estimateTokens(message),
          0,
        ) <
        model.contextWindow * 0.75
      )
        return
      const settings = {
        ...sdk.DEFAULT_COMPACTION_SETTINGS,
        reserveTokens: Math.min(
          sdk.DEFAULT_COMPACTION_SETTINGS.reserveTokens,
          Math.floor(model.contextWindow / 4),
        ),
        keepRecentTokens: Math.min(
          sdk.DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
          Math.floor(model.contextWindow / 4),
        ),
      }
      const preparation = sdk.prepareCompaction(session.getBranch(), settings)
      if (!preparation) return
      bridge.event({ type: 'compaction_start' })
      const result = await sdk.compact(
        preparation,
        model,
        undefined,
        undefined,
        undefined,
        signal,
        undefined,
        (m, c, o) => stream(m, c, o, 'compaction'),
      )
      session.appendCompaction(
        result.summary,
        result.firstKeptEntryId,
        result.tokensBefore,
        result.details,
        false,
        result.usage,
      )
      bridge.event({
        type: 'compaction_end',
        data: { tokensBefore: result.tokensBefore },
      })
      return {
        context: {
          ...context,
          messages: session.buildSessionContext().messages,
        },
      }
    },
  })
  let messageNumber = 0
  let messageId
  agent.subscribe(async (event) => {
    if (event.type === 'message_start' && event.message.role === 'assistant') {
      messageId = `pi-message-${++messageNumber}`
      bridge.event({ type: 'message_start', messageId })
    }
    if (
      event.type === 'message_update' &&
      event.assistantMessageEvent.type === 'text_delta'
    )
      bridge.event({
        type: 'text_delta',
        messageId,
        content: event.assistantMessageEvent.delta,
      })
    if (event.type === 'message_end' && event.message.role === 'assistant')
      bridge.event({
        type: 'message_end',
        messageId,
        content: resultText(event.message.content),
        data: { finishReason: event.message.stopReason },
      })
    if (
      ['agent_start', 'agent_end', 'turn_start', 'turn_end'].includes(
        event.type,
      )
    )
      bridge.event({ type: event.type })
    if (event.type === 'tool_execution_update')
      bridge.event({
        type: 'tool_update',
        toolCallId: event.toolCallId,
        name: event.toolName,
        content: resultText(event.partialResult?.content || []),
      })
    if (event.type === 'message_end' && event.message.role !== 'system')
      session.appendMessage(event.message)
    if (event.type === 'tool_execution_start')
      attempts.set(event.toolCallId, event.args)
    if (
      event.type === 'tool_execution_end' &&
      !dispatched.has(event.toolCallId)
    ) {
      await bridge.rpc('tool-rejected', {
        id: event.toolCallId,
        name: event.toolName,
        arguments: attempts.get(event.toolCallId) || {},
        result: resultText(event.result.content),
      })
    }
  })
  const cancel = () => agent.abort()
  bridge.signal.addEventListener('abort', cancel, { once: true })
  try {
    if (bridge.signal.aborted) throw new Error('Cancelled')
    bridge.initialized()
    await agent.prompt(
      toPiMessage(history.at(-1) || { role: 'user', content: '' }, model),
    )
    const last = agent.state.messages.findLast(
      (message) => message.role === 'assistant',
    )
    if (last?.stopReason === 'error' || last?.stopReason === 'aborted')
      throw new Error(last.errorMessage || last.stopReason)
    return {
      content: resultText(last?.content || []),
      finishReason: last?.stopReason === 'length' ? 'length' : 'stop',
    }
  } finally {
    bridge.signal.removeEventListener('abort', cancel)
  }
}
