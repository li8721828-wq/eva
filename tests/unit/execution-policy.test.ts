import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { createLocalExecutionPolicy, executionApproval, resolveExecutionAutomation } from '../../src/main/services/execution-policy'
import { DEFAULT_AUTOMATION_CONFIG } from '../../src/shared/types/automation'
import { ToolDispatcher } from '../../src/main/services/tool-dispatcher'
import { ToolRegistry, type ToolContext } from '../../src/main/tools'
import { GoalPlanner } from '../../src/main/agent-engine/goal-planner'
import { TeamOrchestrator } from '../../src/main/agent-engine/team-orchestrator'
import { ContextManager } from '../../src/main/agent-engine/context'
import { currentSandboxScope } from '../../src/main/services/sandbox/scope'
import { AgentRunner } from '../../src/main/agent-engine/agent-runner'
import { createTerminalTools } from '../../src/main/tools/terminal-tools'
vi.mock('../../src/main/services/activity-log', () => ({ recordActivity: vi.fn() }))
vi.mock('../../src/main/services/supplier-pricing-service', () => ({ ensureProviderPricing: async () => {} }))
vi.mock('../../src/main/services/usage-pricing-service', () => ({ resolveConnectionPricingMode: () => ({}), resolveRateCardUsageCost: () => ({}) }))

describe('execution policy composition', () => {
  it('propagates runner.abort through the dispatcher and terminal tool to an executing command', async () => {
    const registry = new ToolRegistry()
    for (const tool of createTerminalTools()) registry.register(tool)
    let started!: () => void
    const startedCommand = new Promise<void>(resolve => { started = resolve })
    let commandSignal: AbortSignal | undefined
    const executeCommand = vi.fn((_id, _command, _timeout, _cwd, signal: AbortSignal) => new Promise(resolve => {
      commandSignal = signal
      started()
      signal.addEventListener('abort', () => resolve({ stdout: '', stderr: 'cancelled', exitCode: -1 }), { once: true })
    }))
    const runner = new AgentRunner({
      agentConfig: { id: 'cancel', name: 'Test', role: 'coder', tools: ['execute_command'], model: 'test-model', providerId: 'test', maxIterations: 2, systemPrompt: '', temperature: 0 } as any,
      provider: { id: 'test', type: 'custom', supportsReasoning: () => false, async *chat() { yield { content: '', finishReason: 'tool_calls', toolCalls: [{ index: 0, id: 'run', name: 'execute_command', arguments: '{"command":"long-running"}' }] } } } as any,
      toolRegistry: registry, contextManager: new ContextManager(), workspacePath: process.cwd(), fullFilesystemAccess: true,
      fileService: {} as any, terminalService: { createSession: async () => {}, executeCommand, destroySession: vi.fn() } as any,
    })
    const completion = (async () => {
      for await (const _event of runner.run({ messages: [], newMessage: { id: 'user', role: 'user', conversationId: 'cancel', content: 'run command', timestamp: 0 } })) { /* drain the real runner */ }
    })()
    await startedCommand
    runner.abort()
    await completion
    expect(commandSignal?.aborted).toBe(true)
    expect(executeCommand).toHaveBeenCalledTimes(1)
  })
  it.each([['goal', true], ['goal', false], ['team', true], ['team', false]] as const)('%s child inherits sandbox and approval decision=%s', async (kind, approved) => {
    const execute = vi.fn(async () => {
      expect(currentSandboxScope()).toMatchObject({ level: 'strict', allowNetwork: false })
      return 'written'
    })
    const registry = new ToolRegistry()
    registry.register({ definition: { name: 'write_file', description: 'Write', parameters: { type: 'object' } }, execute })
    let calls = 0
    const provider = {
      id: 'test', type: 'custom', supportsReasoning: () => false,
      async *chat() {
        if (calls++ === 0) yield { content: '', finishReason: 'tool_calls', toolCalls: [{ index: 0, id: 'write', name: 'write_file', arguments: '{}' }] }
        else yield { content: approved ? 'Written.' : 'Denied.', finishReason: 'stop' }
      },
    }
    const agent = { id: 'test', name: 'Test', role: 'coder', tools: ['write_file'], model: 'test-model', providerId: 'test', maxIterations: 2, systemPrompt: '', temperature: 0 }
    const requestToolApproval = vi.fn(async () => ({ approved, message: approved ? undefined : 'Denied by user' }))
    const base = {
      agentConfig: agent, provider, toolRegistry: registry, contextManager: new ContextManager(),
      workspacePath: process.cwd(), fileService: {}, terminalService: {}, requestToolApproval,
      automation: resolveExecutionAutomation({ sandbox: { ...DEFAULT_AUTOMATION_CONFIG.sandbox, level: 'strict', allowNetwork: false } }),
    }
    const events = kind === 'goal'
      ? (new GoalPlanner(base as any) as any).executeStep({ id: 'step', index: 0, description: 'Update', status: 'pending' }, [], 'Update')
      : (new TeamOrchestrator({ ...base, leader: agent, workers: [agent], providerForAgent: () => provider } as any) as any).executeSubtask({ id: 'sub', planId: 'plan', title: 'Update', description: 'Update', dependencies: [], status: 'pending' }, agent, { id: 'plan', goal: 'Update', subtasks: [] }, new Map())
    for await (const _event of events) { /* exercise real child runner */ }
    expect(requestToolApproval).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(approved ? 1 : 0)
    expect(currentSandboxScope()).toBeNull()
  })
  it('upgrades disabled approvals when sandbox is strict, including headless execution', async () => {
    const policy = createLocalExecutionPolicy({
      ...DEFAULT_AUTOMATION_CONFIG,
      sandbox: { ...DEFAULT_AUTOMATION_CONFIG.sandbox, level: 'strict' },
      toolApproval: { policy: 'off', timeoutMs: 1000 },
    }, { conversationId: 'headless', window: null })
    expect(policy.automation.toolApproval.policy).toBe('safe')
    expect((await policy.requestToolApproval({ toolCall: { id: 'write', name: 'write_file', arguments: {} }, workspacePath: 'C:/a' })).approved).toBe(false)
  })

  it('fails closed when a configured write has no approval channel', async () => {
    const approve = executionApproval({ automation: resolveExecutionAutomation() })!
    expect((await approve({ toolCall: { id: 'write', name: 'write_file', arguments: {} }, workspacePath: 'C:/a' })).approved).toBe(false)
    expect((await approve({ toolCall: { id: 'read', name: 'read_file', arguments: {} }, workspacePath: 'C:/a' })).approved).toBe(true)
  })

  it('keeps plan mode read-only even with a permissive approval callback', async () => {
    const callback = vi.fn(async () => ({ approved: true }))
    const approve = executionApproval({ automation: resolveExecutionAutomation({ mode: 'plan' }), requestToolApproval: callback })!
    expect((await approve({ toolCall: { id: 'write', name: 'write_file', arguments: {} }, workspacePath: 'C:/a' })).approved).toBe(false)
    expect(callback).not.toHaveBeenCalled()
  })

  it('never executes a tool when cancellation arrives during approval', async () => {
    const controller = new AbortController()
    const execute = vi.fn(async () => 'written')
    const registry = new ToolRegistry()
    registry.register({ definition: { name: 'write_file', description: '', parameters: { type: 'object' } }, execute })
    const dispatcher = new ToolDispatcher({ toolRegistry: registry, agentTools: ['write_file'], requestToolApproval: async () => { controller.abort(); return { approved: true } } })
    const result = await dispatcher.dispatch({ id: 'write', name: 'write_file', arguments: {}, context: { workspacePath: 'C:/a' } as ToolContext, signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(execute).not.toHaveBeenCalled()
  })

  it('requires explicit policy wiring at every production runner and orchestrator construction', () => {
    let checked = 0
    function visitDirectory(folder: string): void {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const filename = path.join(folder, entry.name)
        if (entry.isDirectory()) { visitDirectory(filename); continue }
        if (!entry.name.endsWith('.ts')) continue
        const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
        function visit(node: ts.Node): void {
          if (ts.isNewExpression(node) && ['AgentRunner', 'GoalPlanner', 'TeamOrchestrator'].includes(node.expression.getText(source))) {
            checked++
            const object = node.arguments?.[0]
            expect(object && ts.isObjectLiteralExpression(object), filename).toBeTruthy()
            if (object && ts.isObjectLiteralExpression(object)) {
              const factory = object.properties.some(p => ts.isSpreadAssignment(p) && p.expression.getText(source).startsWith('createLocalExecutionPolicy('))
              const fields = object.properties.map(p => p.name?.getText(source))
              expect(factory || (fields.includes('automation') && fields.includes('requestToolApproval')), `${filename}:${source.getLineAndCharacterOfPosition(node.pos).line + 1}`).toBe(true)
            }
          }
          ts.forEachChild(node, visit)
        }
        visit(source)
      }
    }
    visitDirectory(path.resolve('src/main'))
    expect(checked).toBeGreaterThanOrEqual(11)
  })
})
