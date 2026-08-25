import fs from 'fs/promises'
import path from 'path'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import pdf from 'pdf-parse/lib/pdf-parse.js'
import type { ChatDocumentAttachment } from '../../shared/types/conversation'

const MAX_FILES = 40
// Office documents are compressed containers. The previous 8 MB limit rejected
// ordinary requirement documents before Mammoth/XLSX had a chance to extract them.
// Extracted text is still bounded by MAX_TOTAL_CHARS before it reaches a model.
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_TOTAL_CHARS = 80_000
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.mdx', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.css', '.scss', '.less', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.java', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.php', '.rb', '.swift', '.kt', '.kts', '.sql', '.sh', '.ps1', '.bat', '.cmd', '.vue', '.svelte', '.ini', '.toml', '.env', '.log'])

interface ParsedAttachment {
  path: string
  name: string
  text?: string
  issue?: string
}

async function collectFiles(entryPath: string, result: string[]): Promise<void> {
  if (result.length >= MAX_FILES) return
  const stats = await fs.stat(entryPath)
  if (stats.isFile()) {
    result.push(entryPath)
    return
  }
  if (!stats.isDirectory()) return
  const entries = await fs.readdir(entryPath, { withFileTypes: true })
  for (const entry of entries) {
    if (result.length >= MAX_FILES) return
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    await collectFiles(path.join(entryPath, entry.name), result)
  }
}

async function parseFile(filePath: string): Promise<ParsedAttachment> {
  const name = path.basename(filePath)
  const extension = path.extname(name).toLowerCase()
  const stats = await fs.stat(filePath)
  if (stats.size > MAX_FILE_BYTES) return { path: filePath, name, issue: '文件超过 32 MB 的单文件解析上限。' }

  try {
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

export async function buildDocumentAttachmentContext(attachments: ChatDocumentAttachment[] | undefined): Promise<string> {
  if (!attachments?.length) return ''
  const filePaths: string[] = []
  for (const attachment of attachments) {
    try {
      await collectFiles(attachment.path, filePaths)
    } catch (error) {
      filePaths.push(attachment.path)
    }
  }

  const parsed = await Promise.all(filePaths.slice(0, MAX_FILES).map(parseFile))
  let remainingChars = MAX_TOTAL_CHARS
  const sections = parsed.map((item) => {
    if (item.text !== undefined) {
      const text = item.text.slice(0, remainingChars)
      remainingChars -= text.length
      return `--- Attached file: ${item.name}\nPath: ${item.path}\n${text}\n--- End attached file ---`
    }
    return `--- Attached file requires conversion: ${item.name}\nPath: ${item.path}\nDirect extraction was unavailable: ${item.issue}\nFirst inspect the file and use an available local conversion or extraction method. Do not claim its contents until conversion succeeds.\n--- End attachment notice ---`
  })

  const truncated = filePaths.length >= MAX_FILES ? `\nOnly the first ${MAX_FILES} files from the selected attachments were included.` : ''
  return `\n\n${sections.join('\n\n')}${truncated}`
}
