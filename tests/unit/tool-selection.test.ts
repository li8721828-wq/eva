import { describe, expect, it } from 'vitest'
import { expandToolSet, REQUEST_ADDITIONAL_TOOLS, selectInitialTools } from '../../src/main/agent-engine/tool-selection'
import type { ToolDefinition } from '../../src/shared/types/provider'

const tools: ToolDefinition[] = [
  { name: 'read_file', description: '', parameters: {} },
  { name: 'write_file', description: '', parameters: {} },
  { name: 'web_search', description: '', parameters: {} },
  { name: 'execute_command', description: '', parameters: {} },
  { name: 'spreadsheet', description: '', parameters: {} },
]

describe('dynamic tool selection', () => {
  it('starts a file request with only relevant capabilities plus discovery', () => {
    const selected = selectInitialTools(tools, '读取并修改项目里的 README 文件', false)
    expect(selected.map((tool) => tool.name)).toEqual(expect.arrayContaining(['read_file', 'write_file', REQUEST_ADDITIONAL_TOOLS]))
    expect(selected.map((tool) => tool.name)).not.toContain('web_search')
  })

  it('keeps vague requests small while allowing an authorized expansion', () => {
    const selected = selectInitialTools(tools, '帮我处理一下这个问题', false)
    expect(selected.map((tool) => tool.name)).toEqual([REQUEST_ADDITIONAL_TOOLS])
    expect(selected[0].description).toContain('Authorized tool names: read_file, write_file, web_search, execute_command, spreadsheet')
    expect(selected[0].description).toContain('does not request new user approval')

    const expanded = expandToolSet(selected, tools, ['web_search', 'not_authorized'])
    expect(expanded.granted).toEqual(['web_search'])
    expect(expanded.unavailable).toEqual(['not_authorized'])
    expect(expanded.tools.map((tool) => tool.name)).toContain('web_search')
    expect(expanded.tools.map((tool) => tool.name)).not.toContain('not_authorized')
  })

  it('selects the spreadsheet tool for spreadsheet attachments', () => {
    const selected = selectInitialTools(tools, '汇总这些文件', true)
    expect(selected.map((tool) => tool.name)).toContain('spreadsheet')
  })
})
