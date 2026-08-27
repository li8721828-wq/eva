import { describe, expect, it } from 'vitest'
import {
  getSymposiumHandle,
  mentionedSymposiumParticipants,
  symposiumTranscript,
} from '../../src/main/services/symposium-execution-service'
import type { SymposiumModelParticipant } from '../../src/shared/types/symposium'

const participants: SymposiumModelParticipant[] = [
  { id: 'alpha', handle: 'alpha', providerId: 'p1', providerName: 'Provider A', model: 'model-a', modelName: 'Model A' },
  { id: 'beta', handle: 'beta', providerId: 'p2', providerName: 'Provider B', model: 'model-b', modelName: 'Model B' },
]

describe('SymposiumExecutionService helpers', () => {
  it('routes participant mentions case-insensitively without matching plain model names', () => {
    expect(mentionedSymposiumParticipants('Please ask @ALPHA to review this.', participants)).toEqual([participants[0]])
    expect(mentionedSymposiumParticipants('alpha should review this.', participants)).toEqual([])
  })

  it('builds a bounded participant-visible transcript', () => {
    const messages = [
      { id: 'system', role: 'system' as const, content: 'hidden', timestamp: 1 },
      { id: 'user', role: 'user' as const, content: 'Question', timestamp: 2 },
      { id: 'assistant', role: 'assistant' as const, content: 'Answer', agentName: 'Model A', timestamp: 3 },
    ]

    expect(symposiumTranscript(messages)).toBe('User: Question\n\nModel A: Answer')
    expect(symposiumTranscript([])).toBe('(The discussion has just started.)')
    expect(getSymposiumHandle({ ...participants[0], handle: '' })).toBe('model-a')
  })
})
