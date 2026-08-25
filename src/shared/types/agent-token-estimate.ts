export type AgentTokenEstimateKind = 'system_prompt' | 'eva_rules' | 'agent_context' | 'tool_instructions' | 'tool_schema'

export interface AgentTokenEstimatePart {
  kind: AgentTokenEstimateKind
  tokens: number
}

export interface AgentToolTokenEstimate {
  id: string
  label: string
  tokens: number
  schema: string
}

/** Static prompt footprint for one Agent. Conversation history is excluded. */
export interface AgentTokenEstimate {
  totalTokens: number
  parts: AgentTokenEstimatePart[]
  tools: AgentToolTokenEstimate[]
  /** Default Eva platform rules represented by the Eva rules token category. */
  evaRulesPreview: string
  /** Shared machine-specific instructions included in the system prompt for every Agent. */
  sharedEnvironmentPrompt: string
  toolInstructionsPreview: string
}
