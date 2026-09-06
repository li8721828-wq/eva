import { describe, expect, it } from 'vitest'
import { evaluateTaskPlanStatus, validateTextArtifact } from '../../src/main/agent-engine/team-orchestrator'
import type { SubTask } from '../../src/shared/types/task'

const subtask = (status: SubTask['status']): SubTask => ({
  id: status,
  planId: 'plan',
  title: 'Task',
  description: 'Task',
  status,
  dependencies: [],
})

describe('team plan completion status', () => {
  it('requires every subtask to be completed', () => {
    expect(evaluateTaskPlanStatus([subtask('completed')])).toBe('completed')
    expect(evaluateTaskPlanStatus([subtask('completed'), subtask('failed')])).toBe('failed')
    expect(evaluateTaskPlanStatus([subtask('pending')])).toBe('failed')
    expect(evaluateTaskPlanStatus([])).toBe('failed')
  })
})

describe('task artifact validation', () => {
  it('rejects empty-structure markdown and accepts a sourced report', () => {
    expect(validateTextArtifact('report.md', 'just notes')).toEqual([
      'report.md: content is too short to be a usable artifact',
      'report.md: Markdown has no heading',
    ])
    expect(validateTextArtifact('report.md', '# Findings\n\nEvidence is documented at https://example.com/source.', true)).toEqual([])
  })

  it('validates JSON and YAML structure', () => {
    expect(validateTextArtifact('result.json', '{ invalid json content }')).toContain('result.json: invalid JSON')
    expect(validateTextArtifact('result.yaml', 'plain text without entries')).toContain('result.yaml: YAML has no mapping or list entry')
    expect(validateTextArtifact('result.yaml', 'name: completed\nitems:\n  - one')).toEqual([])
  })

  it('rejects leaked tool protocol markup instead of treating it as a report', () => {
    expect(validateTextArtifact('report.md', '# Report\n\n<|DSML|tool_calls><|invoke name="read_file"|>')).toContain(
      'report.md: contains unparsed tool-protocol markup',
    )
  })
})
