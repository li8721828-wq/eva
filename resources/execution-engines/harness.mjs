import { Context } from '@deepseek-ai/cordis'
import Session from '@deepseek-ai/dsh-session'
import Projection from '@deepseek-ai/dsh-session-projection'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Agents from '@deepseek-ai/dsh-agent'
import Tools from '@deepseek-ai/dsh-tools'
import Llm, {
  LlmAdapter,
  LlmError,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  createUserMessage,
  isAgentLoopRequest,
} from '@deepseek-ai/dsh-llm'
import Loop from '@deepseek-ai/dsh-agent-loop'
import LocalFs from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import LocalPwsh from '@deepseek-ai/dsh-pwsh-local'
import LocalBash from '@deepseek-ai/dsh-bash-local'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Compaction from '@deepseek-ai/dsh-compaction-basic'
import Attachments from '@deepseek-ai/dsh-attachment-local'
import * as FsTools from '@deepseek-ai/dsh-tool-fs'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as PwshTool from '@deepseek-ai/dsh-tool-pwsh'
import * as BashTool from '@deepseek-ai/dsh-tool-bash'
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { harnessStream, resultText } from './model-codecs.mjs'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Retry from '@deepseek-ai/dsh-llm-retry'
import * as Todo from '@deepseek-ai/dsh-tool-todo'
import * as Checkpoints from '@deepseek-ai/dsh-session-checkpoint-policy'
import Goal from '@deepseek-ai/dsh-goal'
import * as GoalDriver from '@deepseek-ai/dsh-goal-round-driver'
import * as GoalTools from '@deepseek-ai/dsh-tool-goal'
import { installWindowsPublicationRetry } from './windows-fs-compat.mjs'

export async function runHarness(config, bridge) {
  const ctx = new Context(),
    active = new AsyncLocalStorage()
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-harness-'))
  let failure,
    lastAssistant,
    lastFinishReason = 'stop'
  const dispatched = new Set()
  const present = (name, args, result) => {
    try {
      const tool = ctx.tools.get(name)
      return result
        ? tool?.presentResult?.(args, result)
        : tool?.presentCall?.(args)
    } catch {
      return undefined
    }
  }
  try {
    for (const Service of [Session, Projection, Prompt, Agents, Tools, Llm])
      await ctx.plugin(Service, {})
    class ConfinedFs extends LocalFs {
      async resolve(value, options) {
        const target = await super.resolve(value, options)
        const decision = await bridge.rpc('path-check', {
          id: active.getStore()?.id,
          path: this.processPath(target),
          operation: 'read',
        })
        if (decision.error) throw new Error(decision.error)
        return target
      }
      async writeText(target, ...args) {
        const decision = await bridge.rpc('path-check', {
          id: active.getStore()?.id,
          path: this.processPath(target),
          operation: 'write',
        })
        if (decision.error) throw new Error(decision.error)
        return super.writeText(target, ...args)
      }
      async editText(target, ...args) {
        const decision = await bridge.rpc('path-check', {
          id: active.getStore()?.id,
          path: this.processPath(target),
          operation: 'write',
        })
        if (decision.error) throw new Error(decision.error)
        return super.editText(target, ...args)
      }
    }
    await ctx.plugin(ConfinedFs, { cwd: config.workspacePath })
    await installWindowsPublicationRetry(ctx.fs, bridge.signal)
    await ctx.plugin(WorkingDirectory, {
      defaultDirectory: config.workspacePath,
    })
    await ctx.plugin(Attachments, {
      dshHome: config.sessionDirectory
        ? path.join(config.sessionDirectory, 'assets')
        : scratch,
    })
    if (config.sessionDirectory) {
      await ctx.plugin(Persistence, {
        root: path.join(config.sessionDirectory, 'sessions'),
      })
      await ctx.plugin(Checkpoints, {})
    }
    class Bridge extends LlmAdapter {
      async resolveModel(provider, id) {
        return {
          provider,
          id,
          name: id,
          context: { contextWindow: config.model.contextWindow },
          inputModalities: config.model.vision ? ['text', 'image'] : ['text'],
          defaultMaxTokens: config.model.maxTokens,
        }
      }
      async *stream(options) {
        const messages = []
        let pendingImages = []
        if (options.system)
          messages.push({ role: 'system', content: options.system })
        for (const message of options.messages) {
          const images = []
          for (const block of message.content)
            if (block.type === 'image' && !block.offloaded) {
              const stored = await ctx.attachments.readImage(
                block.attachment,
                options.signal,
              )
              images.push({
                mediaType: stored.ref.mediaType,
                name: stored.ref.name,
                dataUrl: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`,
              })
            }
          const role = message.role === 'developer' ? 'system' : message.role
          if (role !== 'tool' && pendingImages.length) {
            messages.push({
              role: 'user',
              content: 'Images returned by completed native tools.',
              images: pendingImages,
            })
            pendingImages = []
          }
          if (role === 'tool') pendingImages.push(...images)
          messages.push({
            role,
            content: resultText(message.content),
            ...(images.length && role !== 'tool' ? { images } : {}),
            ...(role === 'tool' ? { toolCallId: message.source.callId } : {}),
            ...(role === 'assistant'
              ? {
                  reasoningContent: message.content
                    .filter((b) => b.type === 'reasoning')
                    .map((b) => b.text)
                    .join(''),
                  toolCalls: message.content
                    .filter((b) => b.type === 'tool-call')
                    .map((call) => ({
                      id: call.id,
                      name: call.name,
                      arguments: (() => {
                        try {
                          return JSON.parse(call.arguments)
                        } catch {
                          return {}
                        }
                      })(),
                      rawArguments: call.arguments,
                    })),
                }
              : {}),
          })
        }
        if (pendingImages.length)
          messages.push({
            role: 'user',
            content: 'Images returned by completed native tools.',
            images: pendingImages,
          })
        try {
          yield* harnessStream(
            bridge.model({
              messages,
              tools: options.tools || [],
              maxTokens: options.maxTokens,
              temperature: options.temperature,
              purpose: isAgentLoopRequest(options) ? 'turn' : 'compaction',
            }),
            (response) => {
              if (isAgentLoopRequest(options))
                lastFinishReason = response.finishReason
            },
          )
        } catch (error) {
          const code =
            /(?:context.{0,25}(?:length|window|limit)|maximum.{0,20}tokens)/i.test(
              error.message,
            )
              ? CONTEXT_WINDOW_EXCEEDED_CODE
              : error.status >= 500
                ? 'SERVER'
                : {
                    auth_failed: 'AUTH',
                    rate_limited: 'RATE_LIMIT',
                    timeout: 'TIMEOUT',
                    network: 'TRANSPORT',
                  }[error.code] || 'PROVIDER_ERROR'
          throw new LlmError(error.message, code, { status: error.status })
        }
      }
    }
    ctx.llm.registerAdapter(['eva-transport'], new Bridge())
    if (config.instructions)
      ctx.systemPrompt.section({
        name: 'eva-user-context',
        order: 0,
        text: config.instructions,
        interpolate: false,
      })
    for (const [index, file] of (config.projectContext || []).entries())
      ctx.systemPrompt.section({
        name: `project-instructions-${index}`,
        order: 10 + index,
        text: `Project instructions from ${file.path}:\n${file.content}`,
        interpolate: false,
      })
    await ctx.plugin(FsTools, {
      read: config.capabilities.read,
      write: config.capabilities.write,
      edit: config.capabilities.edit,
      readImage: config.capabilities.read && config.model.vision,
    })
    await ctx.plugin(FsPolicy, {})
    if (config.capabilities.plan)
      await ctx.plugin(Todo, { allowParallelInProgress: true })
    if (config.capabilities.goal) {
      await ctx.plugin(Goal, {})
      await ctx.plugin(GoalDriver, {})
      await ctx.plugin(GoalTools, {})
    }
    const nativeNames = new Set([
      'todo_write',
      'create_goal',
      'get_goal',
      'update_goal',
      'read',
      'read_image',
      'write',
      'edit',
      'pwsh',
      'bash',
    ])
    if (config.capabilities.shell) {
      await ctx.plugin(LocalSubprocess, {})
      await ctx.plugin(ShellEnv, {})
      const Base = process.platform === 'win32' ? LocalPwsh : LocalBash
      class ConfinedShell extends Base {
        async execute(spec) {
          const plan = await bridge.rpc('process-plan', {
            id: active.getStore().id,
            argv: this.argv(spec),
            cwd: spec.workdir,
          })
          if (plan.error) throw new Error(plan.error)
          const env = { ...spec.env, ...plan.envOverrides }
          return this.executeArgv({ ...spec, workdir: plan.cwd, env }, [
            plan.command,
            ...plan.args,
          ])
        }
      }
      await ctx.plugin(ConfinedShell, { cwd: config.workspacePath })
      await ctx.plugin(process.platform === 'win32' ? PwshTool : BashTool, {
        enableRunInBackground: false,
      })
    }
    for (const tool of config.extensions)
      ctx.tools.register({
        ...tool,
        output: {
          schema: { type: 'object' },
          render: (_args, value) => [
            { type: 'text', text: value.result },
            ...(value.imageRefs || []).map((attachment) => ({
              type: 'image',
              attachment,
            })),
          ],
        },
        execute: async (args, execution) => {
          if (!args || typeof args !== 'object' || Array.isArray(args))
            throw new Error('Native tool arguments must be a JSON object')
          dispatched.add(execution.callId)
          const result = await bridge.rpc('extension', {
            id: execution.callId,
            name: tool.name,
            arguments: args,
          })
          if (result.isError) throw new Error(result.result)
          const imageRefs = []
          for (const image of result.modelImages || [])
            imageRefs.push(
              await ctx.attachments.saveImage({
                data: Buffer.from(image.dataUrl.split(',')[1], 'base64'),
                mediaType: image.mediaType,
                name: image.name,
              }),
            )
          return { result: result.result, isError: result.isError, imageRefs }
        },
        isConcurrencySafe: () => false,
      })
    ctx.on('tools/execute', async (execution, next) => {
      if (!nativeNames.has(execution.name)) return next()
      if (
        !execution.arguments ||
        typeof execution.arguments !== 'object' ||
        Array.isArray(execution.arguments)
      )
        return next()
      dispatched.add(execution.callId)
      const gate = await bridge.rpc('native-start', {
        id: execution.callId,
        name: execution.name,
        arguments: execution.arguments,
        callView: present(execution.name, execution.arguments),
      })
      let result
      try {
        if (!gate.approved) throw new Error(gate.error)
        result = await active.run({ id: execution.callId }, next)
      } catch (error) {
        result = {
          isError: true,
          error: { message: error.message },
          content: [{ type: 'text', text: error.message }],
        }
      }
      return result
    })
    ctx.on('tools/result', (execution, result) => {
      // This notification is after native schema, policy and output finalization.
      // Reporting from tools/execute would miss a later native policy rejection.
      if (dispatched.has(execution.callId) && nativeNames.has(execution.name)) {
        void bridge
          .rpc('native-result', {
            id: execution.callId,
            result: resultText(result.content),
            isError: Boolean(result.isError),
            resultView: present(execution.name, execution.arguments, result),
          })
          .catch(() => {})
      } else if (!dispatched.has(execution.callId) && result.isError) {
        void bridge
          .rpc('tool-rejected', {
            id: execution.callId,
            name: execution.name,
            arguments: execution.arguments,
            result: resultText(result.content),
          })
          .catch(() => {})
      } else if (dispatched.has(execution.callId)) {
        bridge.event({
          type: 'tool_end',
          toolCallId: execution.callId,
          name: execution.name,
          content: resultText(result.content),
          data: {
            isError: Boolean(result.isError),
            implementation: 'eva-extension',
          },
        })
      }
    })
    await ctx.plugin(TokenMeter, {})
    await ctx.plugin(Compaction, {
      headroomTokens: Math.min(
        8192,
        Math.floor(config.model.contextWindow / 16),
      ),
      thresholdRatio: 0.75,
      retainRatio: 0.2,
    })
    await ctx.plugin(Retry, {})
    await ctx.plugin(Loop, { agents: [] })
    ctx.on('agent/error', (event) => {
      failure = event.error
    })
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'goal/change') {
        const owner = ctx.agents.get(_session.id)
        const state = owner && ctx.goals.get(owner)
        bridge.event({ type: 'goal', data: state ? { ...state } : {} })
      }
      if (event.type === 'assistant/message') lastAssistant = event.data.message
      const types = {
        'turn/start': 'turn_start',
        'turn/end': 'turn_end',
        'step/start': 'step_start',
        'step/end': 'step_end',
        'compaction/start': 'compaction_start',
        'compaction/end': 'compaction_end',
        'llm/retry': 'retry',
        'llm/retry-started': 'retry_started',
        'todo/write': 'todo',
      }
      if (types[event.type]) {
        const data = { ...event.data }
        // No model transcripts or private failure payloads enter the renderer feed.
        delete data.failure
        bridge.event({ type: types[event.type], data })
      }
    })
    ctx.on('agent/assistant-stream', ({ frame }) => {
      const messageId = frame.attemptId
      if (frame.type === 'start')
        bridge.event({
          type: 'message_start',
          messageId,
          data: { turn: frame.turn, step: frame.step },
        })
      if (frame.type === 'chunk' && frame.chunk.type === 'text-delta')
        bridge.event({
          type: 'text_delta',
          messageId,
          content: frame.chunk.text,
        })
      if (frame.type === 'end')
        bridge.event({
          type: 'message_end',
          messageId,
          data: {
            outcome: frame.outcome.kind,
            eventType: frame.outcome.eventType,
          },
        })
    })
    const agentOptions = {
      provider: 'eva-transport',
      model: config.model.id,
      maxTokens: config.model.maxTokens,
    }
    const canResume =
      config.sessionDirectory &&
      config.resumeSession &&
      (await ctx.sessionPersistence.stat('eva-session'))
    const handle = canResume
      ? await ctx.agents.resume({
          resumeSessionId: 'eva-session',
          agentOptions,
        })
      : await ctx.agents.create({
          sessionId: 'eva-session',
          meta: { cwd: config.workspacePath },
          agentOptions,
        })
    bridge.event({ type: 'session', data: { resumed: Boolean(canResume) } })
    const toBlocks = async (message) => {
      const blocks = [{ type: 'text', text: message.content || '' }]
      for (const image of message.images || [])
        if (image.dataUrl)
          blocks.push({
            type: 'image',
            attachment: await ctx.attachments.saveImage({
              data: Buffer.from(image.dataUrl.split(',')[1], 'base64'),
              mediaType: image.mediaType,
              name: image.name,
            }),
          })
      return blocks
    }
    const history = (
      config.resumeSession && !canResume ? config.fullHistory : config.history
    ).filter((message) => message.role !== 'system')
    for (const message of history.slice(0, -1)) {
      // Imported history has no Harness provider stream to replay. Preserve it
      // explicitly as historical context rather than inventing native events.
      const calls = message.toolCalls?.length
        ? `\nHistorical tool requests: ${JSON.stringify(message.toolCalls)}`
        : ''
      const label =
        message.role === 'tool'
          ? `Historical tool result ${message.toolCallId}`
          : `Historical ${message.role} message`
      handle.agent.session.append(
        'user/message',
        createUserMessage({
          source: { kind: 'user' },
          content: [
            {
              type: 'text',
              text: `${label} (reference only; do not execute):\n${message.content}${calls}`,
            },
            ...(await toBlocks(message)).slice(1),
          ],
        }),
        { surfaceOp: 'append' },
      )
    }
    const cancel = () => handle.agent.cancel({ kind: 'user' })
    bridge.signal.addEventListener('abort', cancel, { once: true })
    try {
      if (bridge.signal.aborted) throw new Error('Cancelled')
      bridge.initialized()
      handle.agent.followup(
        createUserMessage({
          source: { kind: 'user' },
          content: await toBlocks(history.at(-1) || { content: '' }),
        }),
      )
      await handle.agent.whenIdle()
      if (failure) throw failure
      // The native session surface is authoritative, including compaction.
      if (!lastAssistant)
        lastAssistant = handle.agent.session
          .snapshotEvents()
          .findLast((event) => event.type === 'assistant/message')?.data.message
      return {
        content: resultText(lastAssistant?.content || []),
        finishReason: lastFinishReason,
      }
    } finally {
      bridge.signal.removeEventListener('abort', cancel)
      await ctx.parallel('session/flush', handle.agent.session)
      await handle.dispose()
    }
  } finally {
    await ctx.fiber.dispose()
    if (
      path.dirname(scratch) !== path.resolve(os.tmpdir()) ||
      !path.basename(scratch).startsWith('eva-harness-')
    )
      throw new Error('Unexpected Harness scratch directory')
    await fs.rm(scratch, { recursive: true, force: true })
  }
}
