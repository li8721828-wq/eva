import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import JSZip from 'jszip'
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

  it('previews selected ZIP entries without extracting files or following archive paths', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-attachment-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'project.zip')
    const zip = new JSZip()
    zip.file('src/notes.md', '# Project\nA useful detail.')
    zip.file('media/icon.bin', Buffer.from('BINARY_CONTENT'))
    zip.file('../escape.md', 'TRAVERSAL_CONTENT')
    zip.file('linked.md', '/another/file', { unixPermissions: 0o120777 })
    await fs.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }))
    const attachment = { path: filePath, name: 'project.zip', size: 0, kind: 'file' as const }

    const context = await buildDocumentAttachmentContext([attachment])

    expect(context).toContain('ZIP archive preview')
    expect(context).toContain('A useful detail.')
    expect(context).toContain('media/icon.bin')
    expect(context).not.toMatch(/BINARY_CONTENT|escape\.md|TRAVERSAL_CONTENT|linked\.md|\/another\/file/)
    expect(await fs.readdir(directory)).toEqual(['project.zip'])
    await expect(buildDocumentAttachmentContext([attachment], { requireComplete: true })).rejects.toThrow('请解压后添加所需文件')
  })

  it('bounds ZIP listing, decompressed entry previews and total excerpts', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-attachment-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'large.zip')
    const zip = new JSZip()
    zip.file('large.md', `${'x'.repeat(4 * 1024 * 1024)}HIDDEN_END`)
    for (let index = 0; index < 40; index += 1) {
      zip.file(`entry-${index}.md`, `ENTRY_${index}\n${'y'.repeat(8192)}`)
    }
    await fs.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))

    const context = await buildDocumentAttachmentContext([{ path: filePath, name: 'large.zip', size: 0, kind: 'file' }])

    expect(context).toContain('9 more files omitted')
    expect(context).toContain('[ZIP entry excerpt truncated]')
    expect(context).toContain('ENTRY_2')
    expect(context).not.toMatch(/HIDDEN_END|ENTRY_3\b/)
    expect(context.length).toBeLessThan(20_000)
  })

  it('reports malformed ZIP metadata and missing attachments alongside readable files', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-attachment-'))
    temporaryDirectories.push(directory)
    const zipPath = path.join(directory, 'corrupt.zip')
    const missingPath = path.join(directory, 'missing.md')
    const notesPath = path.join(directory, 'notes.md')
    const zip = new JSZip()
    zip.file('hidden.txt', 'HIDDEN_ENTRY')
    const data = await zip.generateAsync({ type: 'nodebuffer' })
    // Underreport the directory entry count without removing the entry.
    data.writeUInt32LE(0, data.length - 14)
    await fs.writeFile(zipPath, data)
    await fs.writeFile(notesPath, 'Readable text')

    const context = await buildDocumentAttachmentContext([zipPath, missingPath, notesPath].map((filePath) => ({
      path: filePath, name: path.basename(filePath), size: 0, kind: 'file',
    })))

    expect(context).toContain('requires conversion: corrupt.zip')
    expect(context).toContain('requires conversion: missing.md')
    expect(context).toContain('ask the user to attach a readable copy')
    expect(context).toContain('Readable text')
    expect(context).not.toContain('HIDDEN_ENTRY')
  })
})
