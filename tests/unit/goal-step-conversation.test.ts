import { describe, expect, it } from 'vitest'
import { goalStepHandoffPrompt } from '../../src/main/services/goal-step-conversation'

describe('Goal step conversation handoff', () => {
  it('contains only the explicit parent-to-step contract', () => {
    const prompt = goalStepHandoffPrompt({
      goal: 'Repair the import flow',
      step: 'Inspect the parser and identify the failing branch',
      workspacePath: 'C:\\workspace',
      acceptanceCriteria: ['Name the failing branch', 'Include evidence'],
      parentContext: 'The user requires a backwards-compatible import flow.',
      userGuidance: ['Do not change the public API.', 'Prefer focused tests.'],
      dependencyResults: [{ stepId: 'step-1', description: 'Collect symptoms', result: 'Parser fails on empty rows.' }],
      upstreamIssues: [{ stepId: 'step-0', description: 'Previous probe', status: 'failed', detail: 'The remote fixture is unavailable.' }],
    })

    expect(prompt).toContain('Goal: Repair the import flow')
    expect(prompt).toContain('Acceptance criteria:')
    expect(prompt).toContain('step-1: Collect symptoms')
    expect(prompt).toContain('Parser fails on empty rows.')
    expect(prompt).toContain('backwards-compatible import flow')
    expect(prompt).toContain('Do not change the public API.')
    expect(prompt).toContain('Known upstream issues:')
    expect(prompt).toContain('remote fixture is unavailable')
    expect(prompt).toContain('isolated Goal step conversation')
  })

  it('marks resumed child work without copying parent transcript', () => {
    const prompt = goalStepHandoffPrompt({
      goal: 'Repair the import flow',
      step: 'Verify the fix',
      acceptanceCriteria: ['Run the focused test'],
      userGuidance: [],
      dependencyResults: [],
      upstreamIssues: [],
    }, true)

    expect(prompt).toContain('Continue this isolated Goal step')
    expect(prompt).not.toContain('parent transcript')
  })
})
