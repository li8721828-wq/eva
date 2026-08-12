export type ToolRiskLevel = 'read' | 'write' | 'system' | 'network'

export interface ToolCatalogEntry {
  id: string
  label: string
  description: string
  category: 'Files' | 'Search' | 'Execution' | 'Internet' | 'Integrations'
  risk: ToolRiskLevel
}

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  { id: 'read_file', label: 'Read file', description: 'Read an authorized file or exact line range.', category: 'Files', risk: 'read' },
  { id: 'list_directory', label: 'List directory', description: 'List files and folders in an authorized location.', category: 'Files', risk: 'read' },
  { id: 'file_info', label: 'File information', description: 'Read file metadata such as size and modification time.', category: 'Files', risk: 'read' },
  { id: 'edit_file', label: 'Edit file', description: 'Safely replace one exact, unique text fragment in an authorized file.', category: 'Files', risk: 'write' },
  { id: 'write_file', label: 'Write file', description: 'Create or update files in an authorized location.', category: 'Files', risk: 'write' },
  { id: 'search_files', label: 'Find files', description: 'Find files by name within an authorized location.', category: 'Search', risk: 'read' },
  { id: 'search_code', label: 'Search code', description: 'Find literal text and references in workspace file contents.', category: 'Search', risk: 'read' },
  { id: 'search_by_regex', label: 'Regex search', description: 'Search workspace files with a regular expression.', category: 'Search', risk: 'read' },
  { id: 'project_search', label: 'Project metadata', description: 'Query persisted symbols, imports, terms, API, data, and configuration metadata.', category: 'Search', risk: 'read' },
  { id: 'project_index_status', label: 'Project index status', description: 'Show persisted metadata coverage and synchronization status.', category: 'Search', risk: 'read' },
  { id: 'web_search', label: 'Web search', description: 'Allow this agent to query the active search service. Requires a configured Brave, Tavily, or SearXNG provider.', category: 'Internet', risk: 'network' },
  { id: 'read_web_page', label: 'Read web page', description: 'Read a public HTTP(S) webpage. Local and private network addresses are blocked.', category: 'Internet', risk: 'network' },
  { id: 'execute_command', label: 'Run command', description: 'Execute a terminal command in the workspace.', category: 'Execution', risk: 'system' },
  { id: 'mouse_control', label: 'Mouse control', description: 'Move, click, double-click, or scroll only on a recent visible-desktop observation. Semantic targets use Windows hit-tested click points when available, all visible taskbars are supported, and movement adapts for fast, balanced, or precise actions. Eva can minimize itself, while closing Eva requires explicit user authorization. Requires Full filesystem access.', category: 'Execution', risk: 'system' },
  { id: 'desktop_observe', label: 'Desktop observer', description: 'Capture the visible foreground Windows surface and every visible taskbar as structured names, roles, bounds, states, and click points. Hidden/background windows and password values are never exposed. Requires Full filesystem access.', category: 'Execution', risk: 'system' },
  { id: 'keyboard_control', label: 'Keyboard control', description: 'Type into a focused visible control or press navigation keys after a recent desktop observation. The foreground window is revalidated and typed content is not returned. Requires Full filesystem access.', category: 'Execution', risk: 'system' },
  { id: 'desktop_session', label: 'Desktop control session', description: 'Bound a multi-step visible-desktop workflow to one conversation with an objective, action budget, pause/resume, timeout, and step record. Requires Full filesystem access.', category: 'Execution', risk: 'system' },
  { id: 'browser_control', label: 'Browser control', description: 'Open and interact with an isolated visible browser session using accessible page selectors. Login, CAPTCHA, passwords, and final submission remain user-controlled.', category: 'Execution', risk: 'system' },
  { id: 'form_fill_workflow', label: 'Form/table fill workflow', description: 'Analyze and fill explicit fields in a browser session. It never submits the final form and requires a review before confirmation.', category: 'Integrations', risk: 'system' },
  { id: 'blender_inspect_scene', label: 'Inspect Blender scene', description: 'Read a compact summary of a configured Blender project.', category: 'Integrations', risk: 'read' },
  { id: 'blender_run_script', label: 'Run Blender script', description: 'Run an approved bpy script through the configured Blender Connector.', category: 'Integrations', risk: 'system' },
  { id: 'blender_model_from_reference', label: 'Model from reference images', description: 'Create a new editable .blend model from attached visual references.', category: 'Integrations', risk: 'system' },
  { id: 'blender_render_review', label: 'Render Blender review', description: 'Render front, side, and three-quarter previews for visual model review.', category: 'Integrations', risk: 'system' },
  { id: 'blender_open_gui', label: 'Open Blender interface', description: 'Launch Blender and open an authorized .blend file for interactive viewing or editing.', category: 'Integrations', risk: 'system' },
]

// Increment when built-in agent tool defaults change so persisted built-ins
// receive the newly shipped capability on the next application start.
export const TOOL_CATALOG_VERSION = 17
