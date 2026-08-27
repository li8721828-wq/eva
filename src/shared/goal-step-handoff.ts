import type { GoalStepHandoff } from './types/task'

export function goalStepHandoffPrompt(handoff: GoalStepHandoff, continuation = false): string {
  const dependencies = handoff.dependencyResults.length
    ? handoff.dependencyResults.map((item) => `- ${item.stepId}: ${item.description}\n  Result: ${item.result}`).join('\n')
    : '(No upstream step results.)'
  const issues = handoff.upstreamIssues.length
    ? handoff.upstreamIssues.map((item) => `- ${item.stepId} (${item.status}): ${item.description}\n  Detail: ${item.detail}`).join('\n')
    : '(No upstream issues.)'
  const guidance = handoff.userGuidance.length
    ? handoff.userGuidance.map((item) => `- ${item}`).join('\n')
    : '(No additional user guidance.)'

  return [
    `Goal: ${handoff.goal}`,
    `Assigned step: ${handoff.step}`,
    `Workspace: ${handoff.workspacePath || '(not restricted to one workspace)'}`,
    'Confirmed parent context and constraints:',
    handoff.parentContext || '(No additional durable context was recorded.)',
    'User guidance (newer guidance wins on conflict):',
    guidance,
    'Acceptance criteria:',
    ...handoff.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    'Upstream completed results:',
    dependencies,
    'Known upstream issues:',
    issues,
    continuation
      ? 'Continue this isolated Goal step from the saved child conversation. Re-check the current evidence before taking another action.'
      : 'This is an isolated Goal step conversation. Treat only this handoff as inherited task context. Do not assume an upstream step succeeded unless it is listed under completed results.',
  ].join('\n')
}
