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
}

function context(content: string): { context: ToolContext; writeFile: ReturnType<typeof vi.fn> } {
  const writeFile = vi.fn()
  const fileService: FileService = {
    readFile: vi.fn(async () => content),
    writeFile,
    listDirectory: vi.fn(),
    searchFiles: vi.fn(),
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
})
