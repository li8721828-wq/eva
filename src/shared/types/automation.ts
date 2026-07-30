export type HiddenCapabilityId = 'team' | 'task' | 'goal' | 'plan' | 'spec'

export interface HiddenCapabilityConfig {
  enabled: boolean
  autoInvoke: boolean
}

export interface AutomationConfig {
  team: HiddenCapabilityConfig
  task: HiddenCapabilityConfig
  goal: HiddenCapabilityConfig & { maxSteps: number; timeoutMinutes: number }
  plan: HiddenCapabilityConfig
  spec: HiddenCapabilityConfig
}

export const DEFAULT_AUTOMATION_CONFIG: AutomationConfig = {
  team: { enabled: true, autoInvoke: true },
  task: { enabled: true, autoInvoke: true },
  goal: { enabled: true, autoInvoke: true, maxSteps: 12, timeoutMinutes: 30 },
  plan: { enabled: true, autoInvoke: true },
  spec: { enabled: true, autoInvoke: false },
}
