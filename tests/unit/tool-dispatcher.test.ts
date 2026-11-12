import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ToolDispatcher } from '../../src/main/services/tool-dispatcher'
import { FileServiceImpl } from '../../src/main/services/file-service'
import { ToolRegistry, type FileService, type TerminalService, type ToolContext } from '../../src/main/tools'
import { createFileTools } from '../../src/main/tools/file-tools'

function context(): ToolContext {
  const fileService: FileService = {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    listDirectory: vi.fn(),
    searchFiles: vi.fn(),
    resolveAuthorizedPath: vi.fn(async (filePath: string) => filePath),
    fileExists: vi.fn(),
    getFileInfo: vi.fn(),
  }
  const terminalService: TerminalService = {
    createSession: vi.fn(),
    hasSession: vi.fn(),
    getOutput: vi.fn(),
    executeCommand: vi.fn(),
    writeInput: vi.fn(),
    resize: vi.fn(),
    destroySession: vi.fn(),
    onOutput: vi.fn(() => () => undefined),
    checkSandboxCommand: vi.fn(() => null),
  }
  return { workspacePath: 'C:/workspace', fileService, terminalService }
}

describe('ToolDispatcher', () => {
  it('continues a denied external read only after scoped approval, without changing the conversation grants', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-dispatch-access-'))
    try {
      const workspacePath = path.join(root, 'workspace')
      const external = path.join(root, 'external.txt')
      await fs.mkdir(workspacePath)
      await fs.writeFile(external, 'external contents')
      const registry = new ToolRegistry()
      for (const tool of createFileTools()) registry.register(tool)
      const fileService = new FileServiceImpl()
      const dispatchContext = { ...context(), workspacePath, fileService, fileAccessGrants: [] }
      const request = { id: 'external-read', name: 'read_file', arguments: { path: external }, context: dispatchContext }
      const approve = vi.fn()
        .mockResolvedValueOnce({ approved: true })
        .mockResolvedValueOnce({ approved: true, fileAccessApproved: true })
      const dispatcher = new ToolDispatcher({ toolRegistry: registry, agentTools: ['read_file'], requestToolApproval: approve })
      expect((await dispatcher.dispatch(request)).isError).toBe(true)
      expect((await dispatcher.dispatch({ ...request, id: 'approved-read' }))).toMatchObject({
        result: 'external contents',
        isError: false,
      })
      expect(approve).toHaveBeenCalledTimes(2)
      expect(approve).toHaveBeenLastCalledWith(expect.objectContaining({
        fileAccess: { path: await fs.realpath(external), operation: 'read', directory: false },
      }))
      expect(dispatchContext.fileAccessGrants).toEqual([])
      await expect(fileService.readFile(external, workspacePath)).rejects.toThrow('Access denied')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a tool that is not enabled without executing it', async () => {
    const execute = vi.fn(async () => 'should not run')
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: 'write_file', description: 'Write a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
      execute,
    })

    const result = await new ToolDispatcher({ toolRegistry: registry, agentTools: [] }).dispatch({
      id: 'call-1', name: 'write_file', arguments: { path: 'out.txt', content: 'x' }, context: context(),
    })

    expect(result.isError).toBe(true)
    expect(result.result).toContain('not permitted')
    expect(result.protocol?.status).toBe('rejected')
    expect(execute).not.toHaveBeenCalled()
  })

  it('validates arguments before asking for approval or executing', async () => {
    const requestApproval = vi.fn(async () => ({ approved: true }))
    const execute = vi.fn(async () => 'ok')
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      execute,
    })

    const result = await new ToolDispatcher({ toolRegistry: registry, agentTools: ['read_file'], requestToolApproval: requestApproval }).dispatch({
      id: 'call-2', name: 'read_file', arguments: { path: 42 }, context: context(),
    })

    expect(result.isError).toBe(true)
    expect(result.result).toContain('must be a string')
    expect(requestApproval).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('runs an approved tool and returns a structured execution protocol', async () => {
    const requestApproval = vi.fn(async () => ({ approved: true }))
    const registry = new ToolRegistry()
    registry.register({
      definition: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      execute: async (params) => `read ${params.path}`,
    })

    const result = await new ToolDispatcher({ toolRegistry: registry, agentTools: ['read_file'], requestToolApproval: requestApproval }).dispatch({
      id: 'call-3', name: 'read_file', arguments: { path: 'src/main.ts' }, context: context(),
    })

    expect(result).toMatchObject({ result: 'read src/main.ts', isError: false })
    expect(result.protocol).toMatchObject({ kind: 'observation', status: 'observed', data: { tool: 'read_file' } })
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      toolCall: expect.objectContaining({ id: 'call-3', name: 'read_file' }),
      workspacePath: 'C:/workspace',
    }))
  })
})
