import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { createSpreadsheetTools } from '../../src/main/tools/spreadsheet-tools'

describe('spreadsheet tool', () => {
  it('creates, inspects, and updates an xlsx workbook', async () => {
    let stored = Buffer.alloc(0)
    const fileService = {
      readBuffer: async () => stored,
      writeBuffer: async (_path: string, content: Buffer) => { stored = content },
    }
    const context = { workspacePath: 'C:/workspace', fileService: fileService as never, terminalService: {} as never }
    const tool = createSpreadsheetTools()[0]

    const created = JSON.parse(String(await tool.execute({ action: 'create', outputPath: 'report.xlsx', sheets: [{ name: 'Summary', rows: [['Name', 'Total'], ['Eva', 3]] }] }, context)))
    expect(created.status).toBe('created')
    const inspected = JSON.parse(String(await tool.execute({ action: 'inspect', path: 'report.xlsx' }, context)))
    expect(inspected.data[0].rows[1]).toEqual(['Eva', 3])

    const updated = JSON.parse(String(await tool.execute({ action: 'update', path: 'report.xlsx', outputPath: 'updated.xlsx', operations: [{ sheet: 'Summary', cell: 'B3', value: '=SUM(B2:B2)' }] }, context)))
    expect(updated.status).toBe('updated')
    const workbook = XLSX.read(stored, { cellFormula: true })
    expect(workbook.Sheets.Summary.B3.f).toBe('SUM(B2:B2)')
  })
})
