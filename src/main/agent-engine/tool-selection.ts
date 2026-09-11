import type { ToolDefinition } from '../../shared/types/provider'

export const REQUEST_ADDITIONAL_TOOLS = 'request_additional_tools'

export const REQUEST_ADDITIONAL_TOOLS_DEFINITION: ToolDefinition = {
  name: REQUEST_ADDITIONAL_TOOLS,
  description: 'Request additional tools that are already authorized for this agent when the currently available tools cannot complete the user request. Request only the smallest relevant set. The system grants only tools in this agent\'s allowed set.',
  parameters: {
    type: 'object',
    properties: {
      toolNames: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Names of additional authorized tools needed.' },
      reason: { type: 'string', description: 'Brief explanation of why the current tool set is insufficient.' },
    },
    required: ['toolNames'],
  },
}

const READ_FILE_TOOLS = new Set(['read_file', 'list_directory', 'search_files', 'search_code', 'search_by_regex', 'project_search', 'project_index_status'])
const WRITE_FILE_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch', 'delete_file', 'rename_file'])
const TERMINAL_TOOLS = new Set(['execute_command', 'open_terminal', 'read_terminal', 'write_terminal', 'close_terminal'])
const WEB_TOOLS = new Set(['web_search', 'read_web_page', 'browser_control'])
const SPREADSHEET_TOOLS = new Set(['spreadsheet'])
const ORCHESTRATION_TOOLS = new Set(['delegate_to_team', 'delegate_to_model_pool', 'run_task', 'run_goal', 'create_execution_plan', 'manage_goal', 'apply_spec_template'])

function matchesRequest(text: string, expressions: RegExp[]): boolean {
  return expressions.some((expression) => expression.test(text))
}

/**
 * Select a deliberately small first tool set. This is a hint, never an
 * authorization boundary: the model may request more from its existing
 * allowed catalog through request_additional_tools.
 */
export function selectInitialTools(
  allTools: ToolDefinition[],
  request: string,
  hasSpreadsheetAttachment: boolean,
  priorToolNames: string[] = [],
): ToolDefinition[] {
  const normalized = request.toLowerCase()
  const selected = new Set<string>()

  if (hasSpreadsheetAttachment || matchesRequest(normalized, [/\b(?:xlsx|xls|ods|csv|spreadsheet|excel)\b/i, /表格|工作簿|单元格|公式/])) {
    for (const name of SPREADSHEET_TOOLS) selected.add(name)
  }
  if (matchesRequest(normalized, [/\b(?:file|folder|directory|repo|repository|code|source|read|inspect|search)\b/i, /文件|目录|文件夹|代码|源码|项目|仓库|读取|查看|检查|搜索|检索/])) {
    for (const name of READ_FILE_TOOLS) selected.add(name)
  }
  if (matchesRequest(normalized, [/\b(?:write|edit|modify|create|implement|fix|refactor|patch|delete|rename)\b/i, /写入|修改|编辑|创建|实现|修复|重构|补丁|删除|重命名/])) {
    for (const name of WRITE_FILE_TOOLS) selected.add(name)
  }
  if (matchesRequest(normalized, [/\b(?:terminal|shell|command|powershell|cmd|npm|pnpm|yarn|build|test|git)\b/i, /终端|命令|构建|编译|测试|运行|提交|推送/])) {
    for (const name of TERMINAL_TOOLS) selected.add(name)
  }
  if (matchesRequest(normalized, [/\b(?:web|internet|online|latest|news|url|website|browser|weather|research)\b/i, /联网|网络|网页|搜索引擎|最新|新闻|网址|网站|浏览器|查一下|调研|天气/])) {
    for (const name of WEB_TOOLS) selected.add(name)
  }
  if (matchesRequest(normalized, [/\b(?:team|agent|delegate|plan|goal|multi-agent|orchestrat)\b/i, /团队|智能体|多智能体|分工|委派|规划|计划|目标|协作/])) {
    for (const name of ORCHESTRATION_TOOLS) selected.add(name)
  }
  if (matchesRequest(normalized, [/runtime|diagnostic|health|系统内省|运行状态|诊断|健康检查/i])) selected.add('inspect_runtime')

  // Explicit tool names are useful for power users and generated task prompts.
  for (const tool of allTools) {
    if (new RegExp(`\\b${tool.name.replace(/_/g, '[ _-]?')}\\b`, 'i').test(request)) selected.add(tool.name)
  }
  for (const name of priorToolNames) selected.add(name)

  const initial = allTools.filter((tool) => selected.has(tool.name))
  const discoveryTool: ToolDefinition = {
    ...REQUEST_ADDITIONAL_TOOLS_DEFINITION,
    description: `${REQUEST_ADDITIONAL_TOOLS_DEFINITION.description} Loading is automatic and does not request new user approval. Authorized tool names: ${allTools.map((tool) => tool.name).join(', ')}. Existing action permissions still apply.`,
  }
  if (initial.length === 0) {
    return allTools.length > 0 ? [discoveryTool] : []
  }
  return [
    ...initial,
    ...(initial.length < allTools.length ? [discoveryTool] : []),
  ]
}

export function expandToolSet(
  activeTools: ToolDefinition[],
  allTools: ToolDefinition[],
  requestedNames: unknown,
): { tools: ToolDefinition[]; granted: string[]; unavailable: string[] } {
  const names = Array.isArray(requestedNames)
    ? requestedNames.filter((name): name is string => typeof name === 'string').map((name) => name.trim()).filter(Boolean)
    : []
  const activeNames = new Set(activeTools.map((tool) => tool.name))
  const allowedByName = new Map(allTools.map((tool) => [tool.name, tool]))
  const granted: string[] = []
  const unavailable: string[] = []
  const additions: ToolDefinition[] = []

  for (const name of names) {
    const tool = allowedByName.get(name)
    if (!tool) {
      unavailable.push(name)
    } else if (!activeNames.has(name)) {
      activeNames.add(name)
      additions.push(tool)
      granted.push(name)
    }
  }

  const tools = [...activeTools, ...additions]
  const remaining = allTools.some((tool) => !activeNames.has(tool.name))
  return {
    tools: remaining && !activeNames.has(REQUEST_ADDITIONAL_TOOLS)
      ? [...tools, REQUEST_ADDITIONAL_TOOLS_DEFINITION]
      : tools.filter((tool) => tool.name !== REQUEST_ADDITIONAL_TOOLS || remaining),
    granted,
    unavailable,
  }
}

export function isFastSynthesisReadTool(name: string): boolean {
  // Directory/search results commonly identify the next file to read, so they
  // remain in the bounded loop. A concrete read is usually sufficient to
  // synthesize immediately.
  return ['read_file', 'read_terminal', 'read_web_page', 'inspect_runtime'].includes(name)
}
