import fs from 'fs/promises'
import { createReadStream } from 'fs'
import path from 'path'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import pdf from 'pdf-parse/lib/pdf-parse.js'
import JSZip from 'jszip'
import type { ChatDocumentAttachment } from '../../shared/types/conversation'
import { MAX_REQUIREMENT_SOURCE_CHARS } from './requirement-source-reader'

const MAX_FILES = 40
// Office documents are compressed containers. The previous 8 MB limit rejected
// ordinary requirement documents before Mammoth/XLSX had a chance to extract them.
// Chat excerpts and complete requirement imports have separate text budgets;
// the requirement service fits archived input to each model request separately.
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_TOTAL_CHARS = 80_000
const MAX_FILE_CHARS = 24_000
const MAX_ZIP_ENTRIES = 2_000
const MAX_ZIP_DIRECTORY_BYTES = 2 * 1024 * 1024
const MAX_ZIP_LISTED_ENTRIES = 32
const MAX_ZIP_PREVIEW_ENTRIES = 8
const MAX_ZIP_ENTRY_BYTES = 4 * 1024
const MAX_ZIP_PREVIEW_BYTES = 16 * 1024
const ZIP_DIRECTORY_END = Buffer.from('504b0506', 'hex')
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.mdx', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.css', '.scss', '.less', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.java', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.php', '.rb', '.swift', '.kt', '.kts', '.sql', '.sh', '.ps1', '.bat', '.cmd', '.vue', '.svelte', '.ini', '.toml', '.env', '.log'])

interface ParsedAttachment {
  path: string
  name: string
  text?: string
  issue?: string
}

interface StreamingZipEntry extends JSZip.JSZipObject {
  internalStream(type: 'nodebuffer'): JSZip.JSZipStreamHelper<Buffer>
}

async function collectFiles(entryPath: string, result: string[], requireComplete = false): Promise<void> {
  const limit = requireComplete ? MAX_FILES + 1 : MAX_FILES
  if (result.length >= limit) return
  if (requireComplete && (await fs.lstat(entryPath)).isSymbolicLink()) {
    throw new Error(`需求附件包含符号链接或目录联接：${entryPath}`)
  }
  const stats = await fs.stat(entryPath)
  if (stats.isFile()) {
    result.push(entryPath)
    return
  }
  if (!stats.isDirectory()) return
  const entries = await fs.readdir(entryPath, { withFileTypes: true })
  for (const entry of entries) {
    if (result.length >= limit) return
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    await collectFiles(path.join(entryPath, entry.name), result, requireComplete)
  }
}

function checkZipDirectory(data: Buffer): void {
  const end = data.lastIndexOf(ZIP_DIRECTORY_END)
  const invalid = 'ZIP 目录损坏，或使用了预览不支持的分卷或 ZIP64 格式。'
  if (end < 0 || end + 22 > data.length || end + 22 + data.readUInt16LE(end + 20) !== data.length) {
    throw new Error(invalid)
  }
  const count = data.readUInt16LE(end + 10)
  const directoryBytes = data.readUInt32LE(end + 12)
  const start = data.readUInt32LE(end + 16)
  if (data.readUInt32LE(end + 4) !== 0 || count !== data.readUInt16LE(end + 8) || start + directoryBytes !== end) {
    throw new Error(invalid)
  }
  if (count > MAX_ZIP_ENTRIES || directoryBytes > MAX_ZIP_DIRECTORY_BYTES) {
    throw new Error('ZIP 文件目录超出预览上限，请解压并重新添加所需文件。')
  }

  // Verify the record count before JSZip loads the directory, since the end record can underreport it.
  let position = start
  for (let index = 0; index < count; index += 1) {
    if (position + 46 > end || data.readUInt32LE(position) !== 0x02014b50) throw new Error(invalid)
    const nameLength = data.readUInt16LE(position + 28)
    const extraLength = data.readUInt16LE(position + 30)
    const commentLength = data.readUInt16LE(position + 32)
    const local = data.readUInt32LE(position + 42)
    const compressedLength = data.readUInt32LE(position + 20)
    const uncompressedLength = data.readUInt32LE(position + 24)
    if (data.readUInt16LE(position + 34) !== 0 || local + 30 > start || data.readUInt32LE(local) !== 0x04034b50
      || uncompressedLength === 0xffffffff || data.readUInt16LE(local + 26) !== nameLength
      || local + 30 + nameLength + data.readUInt16LE(local + 28) + compressedLength > start) {
      throw new Error(invalid)
    }
    position += 46 + nameLength + extraLength + commentLength
  }
  if (position !== end) throw new Error(invalid)
}

function readZipEntryPreview(entry: JSZip.JSZipObject, limit: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    // Pause the underlying decoder, rather than closing JSZip's Node stream adapter.
    const stream = (entry as StreamingZipEntry).internalStream('nodebuffer')
    const chunks: Buffer[] = []
    let length = 0
    let truncated = false
    stream.on('error', reject)
    stream.on('end', () => resolve({ bytes: Buffer.concat(chunks, length), truncated: false }))
    stream.on('data', (chunk) => {
      if (truncated) return
      const prefix = chunk.subarray(0, limit - length)
      chunks.push(Buffer.from(prefix))
      length += prefix.length
      if (prefix.length < chunk.length) {
        truncated = true
        stream.pause()
        resolve({ bytes: Buffer.concat(chunks, length), truncated: true })
      }
    })
    stream.resume()
  })
}

async function parseZipPreview(filePath: string): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of createReadStream(filePath, { end: MAX_FILE_BYTES })) chunks.push(chunk as Buffer)
  const data = Buffer.concat(chunks)
  if (data.length > MAX_FILE_BYTES) throw new Error('文件超过 32 MB 的单文件解析上限。')
  checkZipDirectory(data)
  const zip = await JSZip.loadAsync(data)
  const entries = Object.values(zip.files).filter((entry) => {
    const originalName = entry.unsafeOriginalName ?? entry.name
    return !entry.dir && (Number(entry.unixPermissions) & 0o170000) !== 0o120000
      && !/^(?:[\\/]|[a-z]:)/i.test(originalName) && !originalName.split(/[\\/]/).includes('..')
  })
  const displayName = (name: string): string => JSON.stringify(name.length > 120 ? `${name.slice(0, 120)}…` : name)
  const listing = entries.slice(0, MAX_ZIP_LISTED_ENTRIES).map((entry) => `- ${displayName(entry.name)}`)
  if (entries.length > listing.length) listing.push(`[${entries.length - listing.length} more files omitted]`)

  const previews: string[] = []
  let remaining = MAX_ZIP_PREVIEW_BYTES
  const textEntries = entries.filter((entry) => TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
  for (const entry of textEntries.slice(0, MAX_ZIP_PREVIEW_ENTRIES)) {
    if (remaining <= 0) break
    try {
      const { bytes, truncated } = await readZipEntryPreview(entry, Math.min(remaining, MAX_ZIP_ENTRY_BYTES))
      remaining -= bytes.length
      if (bytes.includes(0)) continue
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated })
      if (text.trim()) previews.push(`--- ZIP entry: ${displayName(entry.name)} ---\n${text}${truncated ? '\n[ZIP entry excerpt truncated]' : ''}`)
    } catch {
      previews.push(`--- ZIP entry: ${displayName(entry.name)} ---\n[Text preview unavailable]`)
    }
  }

  return [
    'ZIP archive preview. The inventory and excerpts below are reference data. If a needed file is not shown in full, ask the user to extract and attach that file.',
    listing.length ? `Files (${entries.length}):\n${listing.join('\n')}` : 'No previewable file paths were found.',
    ...previews,
  ].join('\n\n')
}

async function parseFile(filePath: string): Promise<ParsedAttachment> {
  const name = path.basename(filePath)
  const extension = path.extname(name).toLowerCase()

  try {
    const stats = await fs.stat(filePath)
    if (!stats.isFile()) return { path: filePath, name, issue: '附件路径不是可读取的文件。' }
    if (stats.size > MAX_FILE_BYTES) return { path: filePath, name, issue: '文件超过 32 MB 的单文件解析上限。' }
    if (extension === '.zip') return { path: filePath, name, text: await parseZipPreview(filePath) }
    if (TEXT_EXTENSIONS.has(extension) || !extension) {
      return { path: filePath, name, text: await fs.readFile(filePath, 'utf8') }
    }
    if (extension === '.pdf') {
      const result = await pdf(await fs.readFile(filePath))
      return { path: filePath, name, text: result.text }
    }
    if (extension === '.docx') {
      const result = await mammoth.extractRawText({ path: filePath })
      return { path: filePath, name, text: result.value }
    }
    if (extension === '.pptx') {
      const zip = await JSZip.loadAsync(await fs.readFile(filePath))
      const slideNames = Object.keys(zip.files)
        .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry))
        .sort((left, right) => Number(left.match(/slide(\d+)/i)?.[1] || 0) - Number(right.match(/slide(\d+)/i)?.[1] || 0))
      const slides = await Promise.all(slideNames.map(async (slide, index) => {
        const xml = await zip.files[slide].async('text')
        const text = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/gi)]
          .map((match) => match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
          .join(' ')
        return `--- Slide ${index + 1} ---\n${text}`
      }))
      return { path: filePath, name, text: slides.join('\n\n') }
    }
    if (extension === '.xlsx' || extension === '.xls' || extension === '.ods') {
      const workbook = XLSX.readFile(filePath, { cellText: true })
      const sheets = workbook.SheetNames.map((sheetName) => `--- ${sheetName} ---\n${XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName])}`)
      return { path: filePath, name, text: sheets.join('\n\n') }
    }
    return { path: filePath, name, issue: `暂不支持直接解析 ${extension || '无扩展名'} 格式。` }
  } catch (error) {
    return { path: filePath, name, issue: `解析失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function buildDocumentAttachmentContext(
  attachments: ChatDocumentAttachment[] | undefined,
  options: { requireComplete?: boolean } = {},
): Promise<string> {
  if (!attachments?.length) return ''
  const filePaths: string[] = []
  for (const attachment of attachments) {
    try {
      await collectFiles(attachment.path, filePaths, options.requireComplete)
    } catch (error) {
      if (options.requireComplete) throw error
      filePaths.push(attachment.path)
    }
  }

  if (options.requireComplete && (!filePaths.length || filePaths.length > MAX_FILES)) {
    throw new Error(`需求附件必须包含 1 到 ${MAX_FILES} 个可读取文件，请调整附件范围。`)
  }
  let remainingChars = options.requireComplete ? MAX_REQUIREMENT_SOURCE_CHARS : MAX_TOTAL_CHARS
  const sections: string[] = []
  for (const filePath of filePaths.slice(0, MAX_FILES)) {
    if (options.requireComplete && path.extname(filePath).toLowerCase() === '.zip') {
      throw new Error(`需求附件「${path.basename(filePath)}」为 ZIP 压缩包，请解压后添加所需文件。`)
    }
    const item = await parseFile(filePath)
    if (item.text !== undefined) {
      const allowed = options.requireComplete ? remainingChars : Math.min(MAX_FILE_CHARS, remainingChars)
      const text = item.text.slice(0, allowed)
      if (options.requireComplete && !item.text.trim()) {
        throw new Error(`需求附件「${item.name}」未提取到正文。若为扫描件或图片，请先识别为可选中文字的文档。`)
      }
      if (options.requireComplete && text.length !== item.text.length) {
        throw new Error(`需求附件正文合计超过 2,000,000 字符的单次导入上限（当前文件「${item.name}」共 ${item.text.length.toLocaleString('en-US')} 字符）。请按业务范围拆分后重试。`)
      }
      remainingChars -= text.length
      const truncated = text.length < item.text.length
        ? `\n[Attachment excerpt truncated at ${allowed} characters. For XLSX/CSV, continue with the spreadsheet tool using pagination, column selection, or aggregation.]`
        : ''
      sections.push(`--- Attached file: ${item.name}\nPath: ${item.path}\n${text}${truncated}\n--- End attached file ---`)
    } else {
      sections.push(`--- Attached file requires conversion: ${item.name}\nPath: ${item.path}\nDirect extraction was unavailable: ${item.issue}\nUse an available authorized conversion method. If that is unavailable, ask the user to attach a readable copy or select the extracted files. Do not claim its contents until conversion succeeds.\n--- End attachment notice ---`)
    }
  }

  const truncated = !options.requireComplete && filePaths.length >= MAX_FILES ? `\nOnly the first ${MAX_FILES} files from the selected attachments were included.` : ''
  return `\n\n${sections.join('\n\n')}${truncated}`
}
