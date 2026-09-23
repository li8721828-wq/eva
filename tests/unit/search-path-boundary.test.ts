import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { FileServiceImpl } from '../../src/main/services/file-service'
import { createFileTools } from '../../src/main/tools/file-tools'
import { createSearchTools } from '../../src/main/tools/search-tools'
import type { TerminalService, ToolContext } from '../../src/main/tools'

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

const searchCode = createSearchTools().find((tool) => tool.definition.name === 'search_code')!
const searchFiles = createFileTools().find((tool) => tool.definition.name === 'search_files')!

describe('authorized search traversal', () => {
  let root: string
  let workspace: string
  let outside: string
  let context: ToolContext
  let linkCreated = false

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-search-boundary-'))
    workspace = path.join(root, 'workspace')
    outside = path.join(root, 'outside')
    fs.mkdirSync(workspace)
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'secret.ts'), 'const leaked = "outside"\n')
    fs.writeFileSync(path.join(workspace, 'visible.ts'), 'const visible = "inside"\n')

    const escape = path.join(workspace, 'escape')
    try {
      fs.symlinkSync(outside, escape, process.platform === 'win32' ? 'junction' : 'dir')
      linkCreated = true
    } catch (error: any) {
      // Locked-down Windows policies can refuse link creation; the boundary is
      // still enforced on platforms that allow a link.
      if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
    }

    context = { workspacePath: workspace, fileService: new FileServiceImpl(), terminalService }
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('still finds matches inside the workspace', async () => {
    await expect(searchCode.execute({ query: 'visible' }, context)).resolves.toContain('visible.ts')
  })

  it('does not read file contents through a link that leaves the workspace', async () => {
    if (!linkCreated) return

    await expect(searchCode.execute({ query: 'leaked' }, context)).resolves.toContain('No matches found')
  })

  it('does not list file names reached through a link that leaves the workspace', async () => {
    if (!linkCreated) return

    const result = await searchFiles.execute({ pattern: 'secret' }, context) as string

    expect(result).toContain('No files found')
  })

  it('rejects a link used as the search root', async () => {
    if (!linkCreated) return

    await expect(searchCode.execute({ query: 'leaked', path: 'escape' }, context))
      .rejects.toThrow('not within an authorized folder')
  })
})
