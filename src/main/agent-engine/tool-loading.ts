import type { ToolDefinition } from '../../shared/types/provider'

const WORKSPACE_DISCOVERY_TOOLS = new Set([
  'read_file',
  'list_directory',
  'file_info',
  'search_files',
  'search_code',
  'search_by_regex',
  'project_search',
  'project_index_status',
])

const FILE_MUTATION_TOOLS = new Set(['edit_file', 'write_file'])
const TERMINAL_TOOLS = new Set(['execute_command', 'open_terminal', 'read_terminal', 'write_terminal', 'close_terminal'])
const DESKTOP_TOOLS = new Set(['desktop_observe', 'desktop_session', 'mouse_control', 'keyboard_control', 'browser_control', 'form_fill_workflow'])
const BLENDER_TOOLS = new Set(['blender_inspect_scene', 'blender_run_script', 'blender_model_from_reference', 'blender_render_review', 'blender_open_gui'])
const ORCHESTRATION_TOOLS = new Set(['delegate_to_team', 'delegate_to_model_pool', 'run_task', 'run_goal', 'manage_goal', 'create_execution_plan', 'apply_spec_template'])
const WEB_TOOLS = new Set(['web_search', 'read_web_page'])

export const TOOL_SEARCH_DEFINITION: ToolDefinition = {
  name: 'tool_search',
  description: 'Find and load tools from the deferred tool catalog. Use this only when the required capability is not in the currently loaded tools. Returns up to five matching tools that remain available in later turns.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Capability or task to find, for example "search public web" or "inspect Blender scene".' },
    },
    required: ['query'],
  },
}

/** Claude Code keeps a small set of core tools loaded and defers the rest. */
export const CORE_TOOL_NAMES = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'list_directory',
  'search_files',
  'execute_command',
])
const TOOL_SEARCH_MAX_RESULTS = 5
const TOOL_SEARCH_UPFRONT_LIMIT = 10

function byNames(available: ToolDefinition[], names: Set<string>): ToolDefinition[] {
  return available.filter((tool) => names.has(tool.name))
}

function includesAny(value: string, pattern: RegExp): boolean {
  return pattern.test(value)
}

export interface DeferredToolState {
  initial: ToolDefinition[]
  deferred: ToolDefinition[]
}

export function createDeferredToolState(availableTools: ToolDefinition[]): DeferredToolState {
  if (availableTools.length <= TOOL_SEARCH_UPFRONT_LIMIT) return { initial: availableTools, deferred: [] }
  const initial = availableTools.filter((tool) => CORE_TOOL_NAMES.has(tool.name))
  const deferred = availableTools.filter((tool) => !CORE_TOOL_NAMES.has(tool.name))
  return {
    initial: [...initial, ...(deferred.length ? [TOOL_SEARCH_DEFINITION] : [])],
    deferred,
  }
}

export function searchDeferredTools(query: string, definitions: ToolDefinition[], limit = TOOL_SEARCH_MAX_RESULTS): ToolDefinition[] {
  const terms = query.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1)
  if (!terms.length) return []
  return definitions
    .map((definition, index) => {
      const haystack = `${definition.name} ${definition.description}`.toLocaleLowerCase()
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? (definition.name.toLocaleLowerCase().includes(term) ? 3 : 1) : 0), 0)
      return { definition, score, index }
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((entry) => entry.definition)
}

export function formatToolSearchResult(query: string, matches: ToolDefinition[]): string {
  if (!matches.length) return `No deferred tools matched "${query}". Try a concrete capability or tool name.`
  return `Loaded ${matches.length} tool(s) for "${query}":\n${matches.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n')}`
}

export interface ToolLoadingPlan {
  initial: ToolDefinition[]
  followUp: (calledToolNames: string[]) => ToolDefinition[]
}

/**
 * Keep tool schemas proportional to the task. The model receives only a
 * relevant first-stage set, then gains mutation or interaction tools after it
 * has obtained the prerequisite evidence. Unknown custom tools retain their
 * previous behavior and are sent as configured.
 */
export function createProgressiveToolPlan(
  availableTools: ToolDefinition[],
  request: string,
): ToolLoadingPlan {
  const normalized = request.toLocaleLowerCase()
  const hasKnownTools = availableTools.some((tool) =>
    WORKSPACE_DISCOVERY_TOOLS.has(tool.name)
      || FILE_MUTATION_TOOLS.has(tool.name)
      || TERMINAL_TOOLS.has(tool.name)
      || DESKTOP_TOOLS.has(tool.name)
      || BLENDER_TOOLS.has(tool.name)
      || ORCHESTRATION_TOOLS.has(tool.name)
      || WEB_TOOLS.has(tool.name),
  )

  // Do not remove capabilities from custom agents whose tools are not in the
  // built-in catalog. Those tools have no safe local intent classifier.
  if (!hasKnownTools) {
    return { initial: availableTools, followUp: () => availableTools }
  }

  const wantsWeb = includesAny(normalized, /天气|新闻|最新|当前|今天|today|weather|news|search|搜索|查询|调研|资料|网页|web/)
  const wantsResearch = includesAny(normalized, /调研|研究|资料|对比|来源|论文|research|compare|source|read.*web|网页内容/)
  const wantsFileWork = includesAny(normalized, /文件|代码|项目|目录|仓库|源码|file|code|project|folder|repository/)
  const wantsDirectoryListing = includesAny(normalized, /桌面|文件夹|目录|哪些文件|列出.*文件|list directory|folder contents/)
  const wantsDeepWorkspaceInspection = includesAny(normalized, /代码|项目|仓库|源码|搜索|引用|实现|修复|code|project|repository|search|reference|implement|fix/)
  const wantsMutation = includesAny(normalized, /修改|改造|修复|实现|新增|删除|重构|写入|创建|编辑|change|fix|implement|add|delete|refactor|write|edit|create/)
  const wantsTerminal = includesAny(normalized, /终端|命令|运行|构建|打包|测试|安装|磁盘|硬盘|c盘|[a-z]:?盘|存储空间|磁盘空间|剩余空间|空间占用|磁盘占用|内存情况|disk(?:\s+space|\s+usage)?|drive|storage(?:\s+space)?|terminal|command|run|build|test|install/)
  const wantsDesktop = includesAny(normalized, /浏览器|点击|打开应用|表单|电脑控制|鼠标|键盘|desktop control|browser|click|form|mouse|keyboard/)
    || (includesAny(normalized, /桌面|desktop/) && !wantsDirectoryListing && !wantsFileWork)
  const wantsBlender = includesAny(normalized, /blender|建模|渲染|模型场景/)
  const wantsOrchestration = includesAny(normalized, /goal|目标模式|复杂任务|任务拆解|子任务|计划|plan|delegate|agent team/)

  let initial: ToolDefinition[]
  if (wantsBlender) {
    initial = byNames(availableTools, new Set([...BLENDER_TOOLS].filter((name) => name === 'blender_inspect_scene' || name === 'blender_model_from_reference')))
  } else if (wantsDesktop) {
    initial = byNames(availableTools, new Set(['desktop_observe', 'desktop_session', 'browser_control']))
  } else if (wantsTerminal) {
    initial = byNames(availableTools, new Set([...WORKSPACE_DISCOVERY_TOOLS, 'execute_command', 'read_terminal']))
  } else if (wantsFileWork || wantsMutation) {
    initial = wantsDirectoryListing && !wantsDeepWorkspaceInspection
      ? byNames(availableTools, new Set(['list_directory']))
      : byNames(availableTools, WORKSPACE_DISCOVERY_TOOLS)
  } else if (wantsWeb) {
    initial = byNames(availableTools, wantsResearch ? WEB_TOOLS : new Set(['web_search']))
  } else if (wantsOrchestration) {
    initial = byNames(availableTools, ORCHESTRATION_TOOLS)
  } else {
    // Normal chat should not pay for tool schemas. The model can answer
    // directly; explicit task wording above opts into tools.
    initial = []
  }

  // If the heuristic found a task category but this agent lacks that category,
  // retain the configured tools rather than making an otherwise capable agent
  // unable to act.
  if (!initial.length && (wantsWeb || wantsFileWork || wantsMutation || wantsTerminal || wantsDesktop || wantsBlender || wantsOrchestration)) {
    initial = availableTools
  }

  return {
    initial,
    followUp(calledToolNames: string[]): ToolDefinition[] {
      const called = new Set(calledToolNames)

      // A lightweight lookup such as weather needs only an evidence-to-answer
      // pass. Dropping schemas here avoids resending every configured tool.
      if (called.has('web_search') && !wantsResearch) return []

      if (called.has('read_file') || called.has('list_directory') || called.has('search_files') || called.has('search_code') || called.has('search_by_regex') || called.has('project_search')) {
        if (wantsMutation) return byNames(availableTools, new Set([...WORKSPACE_DISCOVERY_TOOLS, ...FILE_MUTATION_TOOLS]))
        if (called.has('list_directory') && !wantsDeepWorkspaceInspection) return []
        return initial
      }

      if (called.has('edit_file') || called.has('write_file')) {
        // Verification must remain available after writes.
        return byNames(availableTools, new Set(['read_file', 'file_info']))
      }

      if (Array.from(called).some((name) => TERMINAL_TOOLS.has(name))) return byNames(availableTools, TERMINAL_TOOLS)
      if (Array.from(called).some((name) => DESKTOP_TOOLS.has(name))) return byNames(availableTools, DESKTOP_TOOLS)
      if (Array.from(called).some((name) => BLENDER_TOOLS.has(name))) return byNames(availableTools, BLENDER_TOOLS)
      if (Array.from(called).some((name) => ORCHESTRATION_TOOLS.has(name))) return []
      return initial
    },
  }
}
