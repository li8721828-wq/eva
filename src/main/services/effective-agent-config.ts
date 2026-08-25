import type { AgentConfig } from '../../shared/types/agent'

export interface ActiveModelConnection {
  providerId: string
  model: string
}

/**
 * Built-in agents follow the model selected for the current conversation.
 * Custom agents retain their saved connection as an explicit override.
 */
export function resolveEffectiveAgentConfig(
  agentConfig: AgentConfig,
  activeConnection: ActiveModelConnection,
): AgentConfig {
  if (!agentConfig.isBuiltIn) return agentConfig

  return {
    ...agentConfig,
    providerId: activeConnection.providerId,
    model: activeConnection.model,
  }
}
