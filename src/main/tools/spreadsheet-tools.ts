import * as XLSX from 'xlsx'
import type { ToolContext, ToolExecutor } from './index'

const MAX_CELLS = 20_000
const MAX_ROWS = 200
const MAX_COLS = 50
const MAX_SHEETS = 20
type CellValue = string | number | boolean | null

function requiredText(value: unknown, name: string, max = 240): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`)
  const text = value.trim()
  if (text.length > max) throw new Error(`${name} must be ${max} characters or fewer.`)
  return text
}

function readRows(value: unknown, name: string): CellValue[][] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ROWS) throw new Error(`${name} must contain 1-${MAX_ROWS} rows.`)
  const rows = value.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length > MAX_COLS) throw new Error(`${name}[${rowIndex}] must contain at most ${MAX_COLS} cells.`)
    return row.map((cell) => {
      if (cell === null || typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') return cell
      throw new Error(`${name} contains an unsupported cell value.`)
    })
  })
  if (rows.reduce((total, row) => total + row.length, 0) > MAX_CELLS) throw new Error(`Workbook input may contain at most ${MAX_CELLS} cells.`)
  return rows
}

async function readWorkbook(context: ToolContext, filePath: string): Promise<XLSX.WorkBook> {
  if (!context.fileService.readBuffer) throw new Error('Spreadsheet binary reading is unavailable in this runtime.')
  return XLSX.read(await context.fileService.readBuffer(filePath, context.workspacePath, context.fileAccessGrants, context.fullFilesystemAccess), { cellFormula: true, cellNF: true, cellText: true })
}

function inspectSheet(workbook: XLSX.WorkBook, sheetName: string, maxRows: number, maxCols: number) {
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) throw new Error(`Sheet not found: ${sheetName}`)
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1')
  const rows: unknown[][] = []
  for (let row = range.s.r; row <= Math.min(range.e.r, range.s.r + maxRows - 1); row += 1) {
    const values: unknown[] = []
    for (let col = range.s.c; col <= Math.min(range.e.c, range.s.c + maxCols - 1); col += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })] as XLSX.CellObject | undefined
      values.push(cell?.f ? `=${cell.f}` : cell?.v ?? null)
    }
    rows.push(values)
  }
  return { sheet: sheetName, range: sheet['!ref'] || 'A1:A1', rows }
}

function sheetName(value: unknown, fallback: string): string {
  const name = typeof value === 'string' && value.trim() ? value.trim() : fallback
  if (name.length > 31 || /[\\/?*\[\]:]/u.test(name)) throw new Error(`Invalid sheet name: ${name}`)
  return name
}

function extendSheetRange(sheet: XLSX.WorkSheet, address: string): void {
  const cell = XLSX.utils.decode_cell(address)
  const range = XLSX.utils.decode_range(sheet['!ref'] || address)
  range.s.r = Math.min(range.s.r, cell.r)
  range.s.c = Math.min(range.s.c, cell.c)
  range.e.r = Math.max(range.e.r, cell.r)
  range.e.c = Math.max(range.e.c, cell.c)
  sheet['!ref'] = XLSX.utils.encode_range(range)
}

export function createSpreadsheetTools(): ToolExecutor[] {
  return [{
    definition: {
      name: 'spreadsheet',
      description: 'Read, create, and update local XLSX/XLS/ODS workbooks. Use inspect before update, preserve existing content unless replacement is requested, and report the output path. Create/update changes require an explicit user request.',
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['inspect', 'create', 'update'], description: 'Workbook operation.' },
          path: { type: 'string', description: 'Input workbook path for inspect/update.' },
          outputPath: { type: 'string', description: 'Output .xlsx path for create/update. Update defaults to input path.' },
          sheet: { type: 'string', description: 'Sheet name for inspect or update.' },
          maxRows: { type: 'number', description: 'Maximum rows returned by inspect (max 200).' },
          maxCols: { type: 'number', description: 'Maximum columns returned by inspect (max 50).' },
          sheets: { type: 'array', description: 'For create: [{ name, rows }], where rows are arrays of cell values.' },
          operations: { type: 'array', description: 'For update: [{ sheet, cell, value }]. Cell uses A1 notation; string values beginning with = are formulas.' },
        },
      },
    },
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
      const action = params.action
      if (action === 'inspect') {
        const inputPath = requiredText(params.path, 'path')
        const workbook = await readWorkbook(context, inputPath)
        const selected = typeof params.sheet === 'string' && params.sheet.trim() ? [params.sheet.trim()] : workbook.SheetNames.slice(0, MAX_SHEETS)
        return JSON.stringify({ path: inputPath, sheets: workbook.SheetNames, data: selected.map((name) => inspectSheet(workbook, name, Math.max(1, Math.min(MAX_ROWS, Number(params.maxRows) || 50)), Math.max(1, Math.min(MAX_COLS, Number(params.maxCols) || 20)))) }, null, 2)
      }
      if (action === 'create') {
        if (!context.fileService.writeBuffer) throw new Error('Spreadsheet binary writing is unavailable in this runtime.')
        const outputPath = requiredText(params.outputPath, 'outputPath')
        if (!/\.xlsx$/iu.test(outputPath)) throw new Error('outputPath must end with .xlsx.')
        if (!Array.isArray(params.sheets) || params.sheets.length === 0 || params.sheets.length > MAX_SHEETS) throw new Error(`sheets must contain 1-${MAX_SHEETS} sheets.`)
        const workbook = XLSX.utils.book_new()
        for (const [index, input] of (params.sheets as unknown[]).entries()) {
          if (!input || typeof input !== 'object') throw new Error(`sheets[${index}] must be an object.`)
          const item = input as Record<string, unknown>
          XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(readRows(item.rows, `sheets[${index}].rows`)), sheetName(item.name, `Sheet${index + 1}`))
        }
        const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' }) as Buffer
        await context.fileService.writeBuffer(outputPath, buffer, context.workspacePath, context.fileAccessGrants, context.fullFilesystemAccess)
        return JSON.stringify({ action, status: 'created', path: outputPath, sheets: workbook.SheetNames, bytes: buffer.length }, null, 2)
      }
      if (action === 'update') {
        if (!context.fileService.writeBuffer) throw new Error('Spreadsheet binary writing is unavailable in this runtime.')
        const inputPath = requiredText(params.path, 'path')
        const outputPath = typeof params.outputPath === 'string' && params.outputPath.trim()
          ? params.outputPath.trim()
          : /\.xlsx$/iu.test(inputPath) ? inputPath : inputPath.replace(/\.[^.\\/]+$/u, '.xlsx')
        if (!/\.xlsx$/iu.test(outputPath)) throw new Error('outputPath must end with .xlsx.')
        if (!Array.isArray(params.operations) || params.operations.length === 0 || params.operations.length > MAX_CELLS) throw new Error(`operations must contain 1-${MAX_CELLS} items.`)
        const workbook = await readWorkbook(context, inputPath)
        for (const [index, operation] of (params.operations as unknown[]).entries()) {
          if (!operation || typeof operation !== 'object') throw new Error(`operations[${index}] must be an object.`)
          const item = operation as Record<string, unknown>
          const name = requiredText(item.sheet, `operations[${index}].sheet`, 31)
          const cell = requiredText(item.cell, `operations[${index}].cell`, 20).toUpperCase()
          if (!/^[A-Z]{1,3}[1-9][0-9]*$/u.test(cell)) throw new Error(`Invalid cell address: ${cell}`)
          const sheet = workbook.Sheets[name]
          if (!sheet) throw new Error(`Sheet not found: ${name}`)
          const value = item.value
          if (!(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) throw new Error(`operations[${index}].value has an unsupported type.`)
          sheet[cell] = typeof value === 'string' && value.startsWith('=') ? { t: 'n', f: value.slice(1), v: 0 } : { t: value === null ? 'z' : typeof value === 'number' ? 'n' : typeof value === 'boolean' ? 'b' : 's', v: value }
          extendSheetRange(sheet, cell)
        }
        const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' }) as Buffer
        await context.fileService.writeBuffer(outputPath, buffer, context.workspacePath, context.fileAccessGrants, context.fullFilesystemAccess)
        return JSON.stringify({ action, status: 'updated', inputPath, path: outputPath, operations: (params.operations as unknown[]).length, bytes: buffer.length }, null, 2)
      }
      throw new Error('action must be inspect, create, or update.')
    },
  }]
}
