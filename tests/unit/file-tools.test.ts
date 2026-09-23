import { describe, expect, it, vi } from 'vitest'
import { createFileTools } from '../../src/main/tools/file-tools'
import type { FileService, TerminalService, ToolContext } from '../../src/main/tools'

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

function context(content: string): { context: ToolContext; writeFile: ReturnType<typeof vi.fn> } {
  const writeFile = vi.fn()
  const fileService: FileService = {
    readFile: vi.fn(async () => content),
    writeFile,
    listDirectory: vi.fn(),
    searchFiles: vi.fn(),
    resolveAuthorizedPath: vi.fn(async (filePath: string) => filePath),
    fileExists: vi.fn(),
    getFileInfo: vi.fn(),
  }
  return { context: { workspacePath: 'C:/workspace', fileService, terminalService }, writeFile }
}

describe('edit_file tool', () => {
  const editFile = createFileTools().find((tool) => tool.definition.name === 'edit_file')!

  it('replaces one exact fragment without overwriting unrelated content', async () => {
    const { context: toolContext, writeFile } = context('const color = "red";\nconst size = 2;\n')

    await expect(editFile.execute({ path: 'src/theme.ts', oldContent: '"red"', newContent: '"blue"' }, toolContext))
      .resolves.toBe('Successfully edited src/theme.ts')

    expect(writeFile).toHaveBeenCalledWith(
      'src/theme.ts',
      'const color = "blue";\nconst size = 2;\n',
      'C:/workspace',
      undefined,
      undefined,
    )
  })

  it('rejects an ambiguous replacement instead of guessing', async () => {
    const { context: toolContext, writeFile } = context('enabled = true\nenabled = true\n')

    await expect(editFile.execute({ path: 'settings.txt', oldContent: 'enabled = true', newContent: 'enabled = false' }, toolContext))
      .rejects.toThrow('occurs more than once')
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('edits the only exact basename match when the requested path is one level off', async () => {
    const { context: toolContext, writeFile } = context('const enabled = true\n')
    const candidate = 'C:/workspace/src/settings.txt'
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('ENOENT: file not found'))
      .mockResolvedValueOnce('const enabled = true\n')
    toolContext.fileService.readFile = read
    toolContext.fileService.searchFiles = vi.fn(async () => [candidate])

    const editFile = createFileTools().find((tool) => tool.definition.name === 'edit_file')!
    await expect(editFile.execute({ path: 'settings.txt', oldContent: 'true', newContent: 'false' }, toolContext))
      .resolves.toBe('Successfully edited C:/workspace/src/settings.txt (resolved from settings.txt)')

    expect(writeFile).toHaveBeenCalledWith(
      candidate,
      'const enabled = false\n',
      'C:/workspace',
      undefined,
      undefined,
    )
  })
})

describe('read_file tool', () => {
  const readFile = createFileTools().find((tool) => tool.definition.name === 'read_file')!

  it('discloses the substituted path when the requested path is one level off', async () => {
    const { context: toolContext } = context('fn main() {}\n')
    const candidate = 'C:/workspace/src/main.rs'
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('ENOENT: file not found'))
      .mockResolvedValueOnce('fn main() {}\n')
    toolContext.fileService.readFile = read
    toolContext.fileService.searchFiles = vi.fn(async () => [candidate])

    const result = await readFile.execute({ path: 'C:/workspace/main.rs' }, toolContext)

    expect(result).toContain('C:/workspace/main.rs was not found')
    expect(result).toContain(candidate)
    expect(result).toContain('fn main() {}\n')
    expect(read).toHaveBeenNthCalledWith(2, candidate, 'C:/workspace', undefined, undefined)
  })

  it('returns the content verbatim when the requested path exists', async () => {
    const { context: toolContext } = context('fn main() {}\n')

    await expect(readFile.execute({ path: 'src/main.rs' }, toolContext)).resolves.toBe('fn main() {}\n')
  })

  it('keeps the substitution notice above the numbered range', async () => {
    const { context: toolContext } = context('alpha\nbeta\ngamma\n')
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('ENOENT: file not found'))
      .mockResolvedValueOnce('alpha\nbeta\ngamma\n')
    toolContext.fileService.readFile = read
    toolContext.fileService.searchFiles = vi.fn(async () => ['C:/workspace/src/lib.rs'])

    const result = await readFile.execute({ path: 'lib.rs', startLine: 2, endLine: 3 }, toolContext)

    expect(result).toContain('C:/workspace/src/lib.rs')
    expect(result).toContain('2\tbeta\n3\tgamma')
  })

  it('reports all exact basename candidates instead of guessing', async () => {
    const { context: toolContext } = context('fn main() {}\n')
    toolContext.fileService.readFile = vi.fn(async () => { throw new Error('ENOENT: file not found') })
    toolContext.fileService.searchFiles = vi.fn(async () => [
      'C:/workspace/src/main.rs',
      'C:/workspace/tests/main.rs',
    ])

    await expect(readFile.execute({ path: 'main.rs' }, toolContext))
      .rejects.toThrow('Candidate paths returned by the workspace search')
    await expect(readFile.execute({ path: 'main.rs' }, toolContext))
      .rejects.toThrow('C:/workspace/tests/main.rs')
  })
})
