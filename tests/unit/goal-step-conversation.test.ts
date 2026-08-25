import { describe, expect, it } from 'vitest'
import { goalStepHandoffPrompt } from '../../src/main/services/goal-step-conversation'

describe('Goal step conversation handoff', () => {
  it('contains only the explicit parent-to-step contract', () => {
    const prompt = goalStepHandoffPrompt({
      goal: 'Repair the import flow',
      step: 'Inspect the parser and identify the failing branch',
      workspacePath: 'C:\\workspace',
      acceptanceCriteria: ['Name the failing branch', 'Include evidence'],
      dependencyResults: [{ stepId: 'step-1', description: 'Collect symptoms', result: 'Parser fails on empty rows.' }],
    })

    expect(prompt).toContain('Goal: Repair the import flow')
    expect(prompt).toContain('Acceptance criteria:')
    expect(prompt).toContain('step-1: Collect symptoms')
    expect(prompt).toContain('Parser fails on empty rows.')
    expect(prompt).toContain('isolated Goal step conversation')
  })

  it('marks resumed child work without copying parent transcript', () => {
    const prompt = goalStepHandoffPrompt({
      goal: 'Repair the import flow',
      step: 'Verify the fix',
      acceptanceCriteria: ['Run the focused test'],
      dependencyResults: [],
    }, true)

    expect(prompt).toContain('Continue this isolated Goal step')
    expect(prompt).not.toContain('parent transcript')
  })
})
