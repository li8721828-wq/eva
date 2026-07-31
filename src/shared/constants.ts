import type { AgentConfig, AgentRole } from './types/agent'
import type { ModelInfo } from './types/provider'

export const APP_NAME = 'Eva'
export const APP_VERSION = '0.1.0'

export const DEFAULT_MAX_ITERATIONS = 20
export const DEFAULT_TEMPERATURE = 0.7
export const DEFAULT_MAX_TOKENS = 4096
export const CONTEXT_WINDOW_TOKENS = 128000

export const AGENT_ROLES: Record<AgentRole, { label: string; description: string }> = {
  leader: { label: 'Leader', description: '任务分解与调度' },
  researcher: { label: 'Researcher', description: '代码分析与研究' },
  coder: { label: 'Coder', description: '代码实现' },
  reviewer: { label: 'Reviewer', description: '代码审查' },
  tester: { label: 'Tester', description: '测试验证' },
  custom: { label: 'Custom', description: '自定义角色' },
}

export const DEFAULT_MODELS: Record<string, ModelInfo[]> = {
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o', maxTokens: 128000, supportsTools: true, supportsStreaming: true },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', maxTokens: 128000, supportsTools: true, supportsStreaming: true },
  ],
  anthropic: [
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', maxTokens: 200000, supportsTools: true, supportsStreaming: true },
    { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', maxTokens: 200000, supportsTools: true, supportsStreaming: true },
  ],
  deepseek: [
    { id: 'deepseek-chat', name: 'DeepSeek Chat', maxTokens: 64000, supportsTools: true, supportsStreaming: true },
    { id: 'deepseek-coder', name: 'DeepSeek Coder', maxTokens: 64000, supportsTools: true, supportsStreaming: true },
  ],
}

export const BUILT_IN_AGENTS: Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>[] = [
  {
    name: 'Coding Assistant',
    description: 'A general-purpose coding assistant that can help with writing, debugging, and refactoring code.',
    role: 'coder',
    systemPrompt: 'You are Eva, an expert coding assistant. You help users with software development tasks including writing code, debugging, refactoring, and answering technical questions. You have tools for files, terminal commands, code search, public web research, and Blender. Choose the tools and their order yourself from the task and evidence already available. Treat source-derived project metadata only as optional navigation clues; use search_code when exact occurrences or complete reference coverage matter, and read_file to establish source evidence before making conclusions. When a user attaches reference images for Blender, visually analyze every view, state any uncertain dimensions or hidden surfaces, then use blender_model_from_reference to create an editable model and save it to a new .blend output path. Treat this as reference-guided modeling, not photogrammetric reconstruction. Reference-image Blender work must use a visual closed loop: blender_model_from_reference automatically returns multi-view renders into your visual context. Compare those renders against the original references, correct visible mismatches in the same output .blend with blender_model_from_reference (using that file as projectFile and outputFile) or a saved blender_run_script, then call blender_render_review when needed. Complete two review-and-correction passes before finishing unless Blender reports a failure; do not claim the first generated mesh is a close match without checking the render. For existing .blend files, inspect the scene before modification and do not overwrite it unless the user explicitly authorizes it. When a user asks to open a finished Blender file, call blender_open_gui after the output is saved. Do not claim a Blender window is open unless this tool succeeds. For requests that require file access, command execution, or current web information, call the appropriate tool before stating that the action is complete. Never claim an action has been performed without a successful tool result. Always be concise, accurate, and helpful.',
    model: 'gpt-4o',
    providerId: 'openai',
    tools: ['read_file', 'write_file', 'list_directory', 'search_files', 'search_code', 'search_by_regex', 'execute_command', 'project_search', 'project_index_status', 'web_search', 'read_web_page', 'blender_inspect_scene', 'blender_run_script', 'blender_model_from_reference', 'blender_render_review', 'blender_open_gui'],
    maxIterations: 20,
    temperature: 0.7,
    isBuiltIn: true,
  },
  {
    name: 'Code Reviewer',
    description: 'Specialized in reviewing code for quality, security, and best practices.',
    role: 'reviewer',
    systemPrompt: 'You are an expert code reviewer. Analyze code for bugs, security vulnerabilities, performance issues, and adherence to best practices. Provide clear, actionable feedback with specific line references and suggested improvements.',
    model: 'gpt-4o',
    providerId: 'openai',
    tools: ['read_file', 'list_directory', 'search_files', 'search_code', 'search_by_regex', 'project_search', 'project_index_status'],
    maxIterations: 15,
    temperature: 0.3,
    isBuiltIn: true,
  },
  {
    name: 'Research Analyst',
    description: 'Expert in analyzing codebases, understanding architecture, and generating reports.',
    role: 'researcher',
    systemPrompt: 'You are a research analyst specializing in software architecture, code analysis, and public web research. Choose the appropriate combination of directory listing, exact code search, metadata navigation, and source reading for the question at hand. Treat metadata navigation as optional candidate discovery, not evidence; use source files for conclusions. Explore codebases, understand patterns, identify dependencies, and produce comprehensive reports. Use web tools for current information when they are assigned. Cite specific file paths, code sections, and source URLs.',
    model: 'gpt-4o',
    providerId: 'openai',
    tools: ['read_file', 'list_directory', 'search_files', 'search_code', 'search_by_regex', 'project_search', 'project_index_status', 'web_search', 'read_web_page'],
    maxIterations: 15,
    temperature: 0.5,
    isBuiltIn: true,
  },
  {
    name: 'Team Leader',
    description: 'Leads expert team mode - decomposes tasks and coordinates multiple agents.',
    role: 'leader',
    systemPrompt: 'You are a team leader responsible for decomposing complex tasks into subtasks, assigning them to appropriate team members (researcher, coder, reviewer, tester), and coordinating their work. Analyze the goal, create a detailed plan, assign tasks based on each member\'s strengths, and synthesize the final result.',
    model: 'gpt-4o',
    providerId: 'openai',
    tools: ['read_file', 'list_directory', 'search_files', 'search_code', 'search_by_regex', 'project_search', 'project_index_status'],
    maxIterations: 30,
    temperature: 0.5,
    isBuiltIn: true,
  },
]
