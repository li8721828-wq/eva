import type { AgentConfig, AgentRole } from './types/agent'
import type { ModelInfo } from './types/provider'

export const APP_NAME = 'Eva'
export const APP_VERSION = '0.1.71'

export const DEFAULT_MAX_ITERATIONS = 100
export const DEFAULT_TEMPERATURE = 0.7
export const DEFAULT_MAX_TOKENS = 4096
export const CONTEXT_WINDOW_TOKENS = 128000
export const DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS = 1_000_000
export const CONTEXT_SAFETY_RESERVE_TOKENS = 8192

/**
 * Returns the advertised total context window for models Eva can identify
 * reliably. Unknown or custom model IDs retain the conservative default.
 */
export function getModelContextWindowTokens(modelId: string): number {
  const normalized = modelId.trim().toLowerCase()
  if (['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'].includes(normalized)) {
    return DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS
  }
  return CONTEXT_WINDOW_TOKENS
}

/**
 * Keep room for the configured generation and a small protocol margin so an
 * input request cannot consume the provider's entire context window.
 */
export function getModelInputBudgetTokens(modelId: string): number {
  return Math.max(
    DEFAULT_MAX_TOKENS,
    getModelContextWindowTokens(modelId) - DEFAULT_MAX_TOKENS - CONTEXT_SAFETY_RESERVE_TOKENS
  )
}

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
    { id: 'deepseek-chat', name: 'DeepSeek Chat', maxTokens: DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS, supportsTools: true, supportsStreaming: true },
    { id: 'deepseek-coder', name: 'DeepSeek Coder', maxTokens: 64000, supportsTools: true, supportsStreaming: true },
  ],
}

export const BUILT_IN_AGENTS: Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>[] = [
  {
    name: 'Coding Assistant',
    description: 'A general-purpose coding assistant that can help with writing, debugging, and refactoring code.',
    role: 'coder',
    model: 'gpt-4o',
    providerId: 'openai',
    tools: ['read_file', 'edit_file', 'write_file', 'list_directory', 'search_files', 'search_code', 'search_by_regex', 'execute_command', 'desktop_observe', 'mouse_control', 'keyboard_control', 'desktop_session', 'browser_control', 'form_fill_workflow', 'project_search', 'project_index_status', 'web_search', 'read_web_page', 'blender_inspect_scene', 'blender_run_script', 'blender_model_from_reference', 'blender_render_review', 'blender_open_gui', 'delegate_to_model_pool'],
    maxIterations: 100,
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
