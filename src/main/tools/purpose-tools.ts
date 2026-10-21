import type { ToolExecutor } from './index'
import type { PurposeProgressReport } from '../../shared/types/purpose'
import { PurposeService } from '../services/purpose-service'
import { getStorage } from '../storage'

export function createPurposeTools(): ToolExecutor[] {
  return [{
    definition: {
      name: 'record_purpose_progress',
      description: 'Save a concise public progress report for the purpose linked to this conversation. Include actual evidence references, blockers, and the next action. Reports are explicitly unverified. Cannot change goals, accept milestones, grant permissions, or write another project. Never include credentials, raw transcripts, or private reasoning.',
      parameters: {
        type: 'object',
        properties: {
          revision: { type: 'integer', description: 'Current purpose revision from project context or the project purpose JSON.' },
          summary: { type: 'string', description: 'Public progress summary, at most 1000 characters.' },
          evidence: { type: 'string', description: 'Checks actually run and evidence locations; empty if not checked.' },
          blockers: { type: 'string', description: 'Known blockers and uncertainties, or empty.' },
          nextAction: { type: 'string', description: 'Concrete next action.' },
          milestoneId: { type: 'string', description: 'Optional milestone from the current purpose.' },
          milestoneStatus: { type: 'string', enum: ['in_progress', 'blocked'] },
        },
        required: ['revision', 'summary', 'evidence', 'blockers', 'nextAction'],
        additionalProperties: false,
      },
    },
    async execute(params, context) {
      if (!context.conversationId) throw new Error('A linked conversation is required.')
      if (context.signal?.aborted) throw new Error('Purpose report cancelled.')
      const purpose = await new PurposeService(getStorage()).reportProgress(context.conversationId, params as unknown as PurposeProgressReport)
      return JSON.stringify({ purposeId: purpose.id, revision: purpose.revision, recorded: true, acceptanceChanged: false })
    },
  }]
}
