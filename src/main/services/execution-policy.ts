import { DEFAULT_AUTOMATION_CONFIG, type AutomationConfig } from '../../shared/types/automation'
import { resolveSandboxPolicy } from './sandbox/policy'
import { createLocalToolApproval, requiresApproval, type ApprovalFactoryContext } from './tool-approval-policy'
import type { ToolApprovalRequest, ToolApprovalDecision } from './tool-dispatcher'
import type { Conversation } from '../../shared/types/conversation'

export interface ExecutionPolicy {
  automation?: AutomationConfig
  requestToolApproval?: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>
}

/** Compose saved preferences once so every execution surface uses the same effective policy. */
export function resolveExecutionAutomation(stored?: Partial<AutomationConfig>): AutomationConfig {
  const defaults = DEFAULT_AUTOMATION_CONFIG
  const automation: AutomationConfig = {
    ...defaults, ...stored,
    team: { ...defaults.team, ...stored?.team },
    task: { ...defaults.task, ...stored?.task },
    goal: { ...defaults.goal, ...stored?.goal },
    plan: { ...defaults.plan, ...stored?.plan },
    spec: { ...defaults.spec, ...stored?.spec },
    toolApproval: { ...defaults.toolApproval, ...stored?.toolApproval },
    sandbox: { ...defaults.sandbox, ...stored?.sandbox },
  }
  const resolved = resolveSandboxPolicy(automation.toolApproval.policy, automation.sandbox, automation.mode)
  automation.toolApproval.policy = resolved.effectiveApprovalPolicy
  automation.sandbox.level = resolved.effectiveSandboxLevel
  return automation
}

export function createLocalExecutionPolicy(
  stored: Partial<AutomationConfig> | undefined,
  context: Omit<ApprovalFactoryContext, 'config'> & {
    /** Trusted local conversation snapshot; network callers do not supply this. */
    conversation?: Pick<Conversation, 'permissionLevel' | 'accessScope'>
  },
): Required<ExecutionPolicy> {
  const automation = resolveExecutionAutomation(stored)
  const { conversation, ...approvalContext } = context
  const fullAccess = conversation?.permissionLevel
    ? conversation.permissionLevel === 'full-access'
    : conversation?.accessScope === 'full'
  // This is a conversation grant, never a write to the global preferences.
  // Keep sandbox enforcement and the runner's plan-mode gate independent.
  if (fullAccess) automation.toolApproval.policy = 'off'
  return { automation, requestToolApproval: createLocalToolApproval({ ...approvalContext, config: automation.toolApproval }) }
}

/** A configured run must not silently lose approvals when no human-facing transport is available. */
export function executionApproval(policy: ExecutionPolicy): ExecutionPolicy['requestToolApproval'] {
  if (!policy.automation) return policy.requestToolApproval
  const automation = resolveExecutionAutomation(policy.automation)
  return async (request) => {
    if (request.signal?.aborted) return { approved: false, message: 'The run was cancelled.' }
    if (automation.mode === 'plan' && requiresApproval(request.toolCall.name, 'strict') !== null) {
      return { approved: false, message: 'Plan mode does not execute writes or commands. Switch to normal mode to execute this action.' }
    }
    if (policy.requestToolApproval) return policy.requestToolApproval(request)
    return requiresApproval(request.toolCall.name, automation.toolApproval.policy) === null
      ? { approved: true }
      : { approved: false, message: 'No approval channel is available for this run; the tool call was denied.' }
  }
}
