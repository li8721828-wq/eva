import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildDocumentAttachmentContext } from '../../src/main/services/document-attachment-service'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('document attachment context', () => {
  it('reads plain-text attachments into the local model context', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-attachment-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'notes.md')
    await fs.writeFile(filePath, '# Notes\nA useful detail.', 'utf8')

    const context = await buildDocumentAttachmentContext([{ path: filePath, name: 'notes.md', size: 24, kind: 'file' }])

    expect(context).toContain('Attached file: notes.md')
    expect(context).toContain('A useful detail.')
  })

  it('marks unhandled files for conversion instead of inventing their contents', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-attachment-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'archive.bin')
    await fs.writeFile(filePath, 'binary', 'utf8')

    const context = await buildDocumentAttachmentContext([{ path: filePath, name: 'archive.bin', size: 6, kind: 'file' }])

    expect(context).toContain('requires conversion')
    expect(context).toContain('Do not claim its contents until conversion succeeds.')
  })
})
