import type { ChatUsage } from './conversation'
import type { ExecutionEnvelope } from './execution-protocol'

export type AgentRole = 'leader' | 'researcher' | 'coder' | 'reviewer' | 'tester' | 'custom'
export type AgentModelPreference = 'reasoning' | 'coding' | 'research' | 'fast'
export type AgentOutputFormat = 'none' | 'default' | 'concise' | 'structured' | 'markdown' | 'focus' | 'reading' | 'typora' | 'feishu' | 'claude' | 'json' | 'custom'
/** Visual treatment for the Agent's final Markdown responses. */
export type AgentOutputStyle = 'none' | 'balanced' | 'compact' | 'editorial' | 'technical' | 'claude'
/** Keep prose visually consistent. Code blocks always use a monospace face. */
export type AgentOutputFont = 'system' | 'macos' | 'serif' | 'mono'
/** Prose color palette for the Agent's final Markdown responses. */
export type AgentOutputColor = 'slate' | 'ink' | 'violet' | 'forest' | 'claude'
/** Stable prose scale presets, applied consistently across Markdown elements. */
export type AgentOutputFontSize = 'xsmall' | 'small' | 'medium' | 'large' | 'xlarge' | '2xlarge' | '3xlarge'
export type AgentOutputTextEffect = 'none' | 'three-d' | 'floating' | 'crystal'
/** Markdown document renderer selected independently from the model's output guidance. */
export type AgentMarkdownRenderer = 'enhanced' | 'classic' | 'streamdown'

export interface AgentModelCandidate {
  /** Saved model connection ID. It remains usable even when hidden from chat. */
  providerId: string
  model: string
}

export interface AgentConfig {
  id: string
  name: string
  description: string
  role: AgentRole
  systemPrompt: string
  /** Keeps a user-authored built-in prompt from being overwritten by shipped defaults. */
  systemPromptCustomized?: boolean
  /** Per-agent platform prompt template. Use {{default_platform_rules}} to retain Eva's generated rules. */
  platformPromptTemplate?: string
  /** Response presentation rules applied after the agent's role instructions. */
  outputFormat?: AgentOutputFormat
  /** Per-agent response format requirements when outputFormat is custom. */
  outputFormatInstructions?: string
  /** Presentation theme consumed by the Markdown renderer. */
  outputStyle?: AgentOutputStyle
  /** Prose font choice consumed by the Markdown renderer. */
  outputFont?: AgentOutputFont
  /** Prose color choice consumed by the Markdown renderer. */
  outputColor?: AgentOutputColor
  /** Prose size choice consumed by the Markdown renderer. */
  outputFontSize?: AgentOutputFontSize
  /** Decorative treatment limited to headings and strong emphasis. */
  outputTextEffect?: AgentOutputTextEffect
  /** Visual renderer for final Markdown responses. */
  markdownRenderer?: AgentMarkdownRenderer
  /** Request and display provider-supplied slow reasoning when supported. */
  showThinking?: boolean
  model: string
  providerId: string
  /** Models this agent may use for delegated work, ordered by user preference. */
  modelCandidates?: AgentModelCandidate[]
  /** Runtime preference used when the team orchestrator selects among assigned models. */
  modelPreference?: AgentModelPreference
  /** Model pools this agent may delegate sub-tasks to through the model-pool tool. */
  modelPoolIds?: string[]
  /** This member was generated for one team task and is not a saved reusable agent. */
  taskScoped?: boolean
  tools: string[]
  /** Tracks the one-time migration that introduced the shared tool catalog. */
  toolCatalogVersion?: number
  maxIterations: number
  temperature: number
  isBuiltIn: boolean
  createdAt: number
  updatedAt: number
}

export interface AgentEvent {
  type: 'text' | 'text_reset' | 'reasoning' | 'tool_call' | 'tool_result' | 'thinking' | 'error' | 'done'
  content?: string
  /** Drop provisional streamed text instead of retaining it as a progress update. */
  discardProvisionalText?: boolean
  toolCall?: {
    id: string
    name: string
    arguments: Record<string, unknown>
  }
  toolResult?: {
    toolCallId: string
    name: string
    result: string
    isError: boolean
    protocol?: ExecutionEnvelope
  }
  error?: string
  /** Provider termination reason. `length` means the response hit a provider limit. */
  finishReason?: string
  usage?: ChatUsage
}

export type WorkMode = 'normal' | 'expert' | 'goal'
