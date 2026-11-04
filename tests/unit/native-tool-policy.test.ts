import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { NativeToolPolicy } from '../../src/main/agent-engine/native-tool-policy'
import { createLocalExecutionPolicy, executionApproval } from '../../src/main/services/execution-policy'
import { rejectAllPendingApprovalsForConversation, resolvePendingApproval, setApprovalRelay } from '../../src/main/services/tool-approval-policy'

vi.mock('../../src/main/services/activity-log', () => ({ recordActivity: vi.fn() }))

const sandbox = vi.hoisted(() => ({
  evaluateSandboxPath: vi.fn(() => ({ allowed: true, reason: '' })),
  evaluateSandboxCommand: vi.fn(() => ({ allowed: true, reason: '' })),
  wrapCommandForSandbox: vi.fn(async (command: string, args: string[]) => ({
    command: 'sandbox-wrapper',
    args: [command, ...args],
    envOverrides: {},
    profile: 'test-profile',
  })),
}))
vi.mock('../../src/main/services/sandbox', () => sandbox)

describe('native tool permission boundary', () => {
  async function setup(
    options: Partial<ConstructorParameters<typeof NativeToolPolicy>[0]> = {},
  ) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-native-policy-'))
    const workspace = path.join(root, 'workspace')
    await fs.mkdir(workspace)
    const approve = vi.fn(async () => ({ approved: true }))
    const policy = new NativeToolPolicy({
      engine: 'pi',
      allowedTools: ['read_file', 'write_file', 'execute_command'],
      workspacePath: workspace,
      signal: new AbortController().signal,
      sandbox: null,
      approve,
      ...options,
    })
    return {
      root,
      workspace,
      policy,
      approve,
      close: () =>
        fs.rm(root, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        }),
    }
  }
  it('checks real paths so a workspace junction cannot grant access outside the workspace', async () => {
    const f = await setup()
    try {
      const outside = path.join(f.root, 'outside')
      await fs.mkdir(outside)
      await fs.writeFile(path.join(outside, 'secret.txt'), 'not permitted')
      await fs.symlink(
        outside,
        path.join(f.workspace, 'link'),
        process.platform === 'win32' ? 'junction' : 'dir',
      )
      await expect(
        f.policy.authorize({
          id: 'r',
          name: 'read',
          arguments: { path: 'link/secret.txt' },
        }),
      ).rejects.toThrow('Access denied')
      expect(f.approve).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  })
  it('does not permit writes through a read-only folder grant', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-native-grant-'))
    const f = await setup({
      fileAccessGrants: [{ path: root, access: 'read' }],
    })
    try {
      await expect(
        f.policy.authorize({
          id: 'w',
          name: 'write',
          arguments: { path: path.join(root, 'x.txt'), content: 'x' },
        }),
      ).rejects.toThrow('Access denied')
    } finally {
      await f.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
  it('denies native capabilities missing from the assigned Eva agent', async () => {
    const f = await setup({ allowedTools: ['read_file'] })
    try {
      await expect(
        f.policy.authorize({
          id: 'w',
          name: 'write',
          arguments: { path: 'x', content: 'x' },
        }),
      ).rejects.toThrow('not authorized')
    } finally {
      await f.close()
    }
  })
  it('rechecks cancellation after an asynchronous approval', async () => {
    const abort = new AbortController()
    const f = await setup({
      signal: abort.signal,
      approve: async () => {
        abort.abort()
        return { approved: true }
      },
    })
    try {
      await expect(
        f.policy.authorize({ id: 'r', name: 'read', arguments: { path: 'x' } }),
      ).rejects.toThrow('cancelled')
    } finally {
      await f.close()
    }
  })
  it('applies the sandbox before granting a native shell operation and wraps the actual argv', async () => {
    const f = await setup({
      sandbox: {
        workspacePath: '',
        fileAccessGrants: [],
        extraAllowedPaths: [],
        allowNetwork: false,
        level: 'strict',
      },
    })
    try {
      const call = {
        id: 's',
        name: 'powershell',
        arguments: { command: 'Get-Date' },
      }
      await f.policy.authorize(call)
      expect(sandbox.evaluateSandboxCommand).toHaveBeenCalledWith(
        'Get-Date',
        expect.anything(),
      )
      const plan = await f.policy.processPlan(
        call,
        ['pwsh', '-Command', 'Get-Date'],
        f.workspace,
      )
      expect(plan).toMatchObject({
        command: 'sandbox-wrapper',
        args: ['pwsh', '-Command', 'Get-Date'],
        profile: 'test-profile',
      })
    } finally {
      await f.close()
    }
  })
  it('denies bootstrap access to any path except the workspace directory', async () => {
    const f = await setup()
    try {
      await f.policy.recheckPath(undefined, f.workspace)
      await expect(
        f.policy.recheckPath(undefined, path.join(f.workspace, 'x')),
      ).rejects.toThrow('bootstrap')
    } finally {
      await f.close()
    }
  })
  it.each([
    ['pi', 'safe'], ['pi', 'off'],
    ['deepseek-harness', 'safe'], ['deepseek-harness', 'off'],
  ] as const)('%s raw filesystem grant without a full-access conversation keeps the %s approval policy', async (engine, approvalPolicy) => {
    const f = await setup({ engine, fullFilesystemAccess: true })
    const conversationId = `full-filesystem-${engine}-${approvalPolicy}`
    const relay = vi.fn((card) => {
      expect(card.detail).toBe(`Workspace: ${f.workspace}`)
      expect(card.category).toBe('workspace-write')
      resolvePendingApproval(card.id, false, 'Denied in test')
      return true
    })
    setApprovalRelay(conversationId, relay)
    try {
      const execution = createLocalExecutionPolicy({ toolApproval: { policy: approvalPolicy, timeoutMs: 1000 } }, { conversationId, window: null })
      const policy = new NativeToolPolicy({
        engine, allowedTools: ['write_file'], workspacePath: f.workspace,
        fullFilesystemAccess: true, sandbox: null,
        signal: new AbortController().signal, approve: executionApproval(execution),
      })
      const key = engine === 'pi' ? 'path' : 'file_path'
      const outsideWorkspace = path.join(f.root, 'outside.html')
      const operation = policy.authorize({ id: 'write', name: 'write', arguments: { [key]: outsideWorkspace, content: 'test' } })
      if (approvalPolicy === 'off') {
        await expect(operation).resolves.toMatchObject({ [key]: outsideWorkspace })
        expect(relay).not.toHaveBeenCalled()
      } else {
        await expect(operation).rejects.toThrow('Denied in test')
        expect(relay).toHaveBeenCalledOnce()
      }
    } finally {
      rejectAllPendingApprovalsForConversation(conversationId, 'cleanup')
      setApprovalRelay(conversationId, null)
      await f.close()
    }
  })
})
