import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { FileServiceImpl } from '../../src/main/services/file-service'

describe('FileServiceImpl access grants', () => {
  let root: string
  let workspace: string
  let readOnlyFolder: string
  let writableFolder: string
  let service: FileServiceImpl

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-file-access-'))
    workspace = path.join(root, 'workspace')
    readOnlyFolder = path.join(root, 'read-only')
    writableFolder = path.join(root, 'writable')
    fs.mkdirSync(workspace)
    fs.mkdirSync(readOnlyFolder)
    fs.mkdirSync(writableFolder)
    fs.writeFileSync(path.join(readOnlyFolder, 'notes.txt'), 'private notes')
    service = new FileServiceImpl()
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('rejects access outside the workspace without a grant', async () => {
    await expect(service.readFile(path.join(readOnlyFolder, 'notes.txt'), workspace)).rejects.toThrow('Access denied')
  })

  it('allows reading but not writing in a read-only grant', async () => {
    const grants = [{ path: readOnlyFolder, access: 'read' as const }]

    await expect(service.readFile(path.join(readOnlyFolder, 'notes.txt'), workspace, grants)).resolves.toBe('private notes')
    await expect(
      service.writeFile(path.join(readOnlyFolder, 'notes.txt'), 'changed', workspace, grants)
    ).rejects.toThrow('Access denied')
  })

  it('allows writing in a read-write grant', async () => {
    const grants = [{ path: writableFolder, access: 'read-write' as const }]

    await service.writeFile(path.join(writableFolder, 'output.txt'), 'generated', workspace, grants)

    await expect(service.readFile(path.join(writableFolder, 'output.txt'), workspace, grants)).resolves.toBe('generated')
  })

  it('allows an explicitly approved full filesystem request', async () => {
    await expect(
      service.readFile(path.join(readOnlyFolder, 'notes.txt'), workspace, [], true)
    ).resolves.toBe('private notes')
  })
})
