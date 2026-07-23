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
    systemPrompt: 'You are Eva, an expert coding assistant. You help users with software development tasks including writing code, debugging, refactoring, and answering technical questions. You have access to tools for reading/writing files, executing terminal commands, and searching code. Always be concise, accurate, and helpful.',
    model: 'gpt-4o',
    providerId: 'openai',
    tools: ['read_file', 'write_file', 'list_directory', 'search_files', 'execute_command', 'search_code'],
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
    tools: ['read_file', 'list_directory', 'search_files', 'search_code'],
    maxIterations: 15,
    temperature: 0.3,
    isBuiltIn: true,
  },
  {
    name: 'Research Analyst',
    description: 'Expert in analyzing codebases, understanding architecture, and generating reports.',
    role: 'researcher',
    systemPrompt: 'You are a research analyst specializing in software architecture and code analysis. Your job is to explore codebases, understand patterns, identify dependencies, and produce comprehensive reports. Be thorough and cite specific file paths and code sections.',
    model: 'gpt-4o',
    providerId: 'openai',
    tools: ['read_file', 'list_directory', 'search_files', 'search_code'],
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
    tools: ['read_file', 'list_directory', 'search_files'],
    maxIterations: 30,
    temperature: 0.5,
    isBuiltIn: true,
  },
]
