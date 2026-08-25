import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '../../src/shared/types/provider'
import { createProgressiveToolPlan } from '../../src/main/agent-engine/tool-loading'

const tools = (names: string[]): ToolDefinition[] => names.map((name) => ({ name, description: name, parameters: {} }))

describe('createProgressiveToolPlan', () => {
  it('loads only web search for a current weather lookup and removes schemas for synthesis', () => {
    const plan = createProgressiveToolPlan(tools(['web_search', 'read_web_page', 'read_file', 'execute_command']), '目前北京天气')

    expect(plan.initial.map((tool) => tool.name)).toEqual(['web_search'])
    expect(plan.followUp(['web_search'])).toEqual([])
  })

  it('loads workspace inspection before file mutation and then enables editing', () => {
    const plan = createProgressiveToolPlan(tools(['read_file', 'search_code', 'edit_file', 'write_file', 'execute_command']), '修改这个项目的代码')

    expect(plan.initial.map((tool) => tool.name)).toEqual(['read_file', 'search_code'])
    expect(plan.followUp(['read_file']).map((tool) => tool.name)).toEqual(['read_file', 'search_code', 'edit_file', 'write_file'])
  })

  it('uses one directory tool then removes schemas for a simple folder listing', () => {
    const plan = createProgressiveToolPlan(tools(['list_directory', 'read_file', 'search_code', 'project_search']), '目前桌面有哪些文件呢')

    expect(plan.initial.map((tool) => tool.name)).toEqual(['list_directory'])
    expect(plan.followUp(['list_directory'])).toEqual([])
  })

  it('offers the command tool for local disk and storage inspection', () => {
    const plan = createProgressiveToolPlan(tools(['execute_command', 'read_terminal', 'read_file']), '可以帮我查看 C 盘的磁盘空间吗')

    expect(plan.initial.map((tool) => tool.name)).toEqual(['execute_command', 'read_terminal', 'read_file'])
  })

  it('keeps unknown custom tools unchanged', () => {
    const available = tools(['inspect'])
    const plan = createProgressiveToolPlan(available, 'inspect the result')

    expect(plan.initial).toEqual(available)
    expect(plan.followUp(['inspect'])).toEqual(available)
  })
})
