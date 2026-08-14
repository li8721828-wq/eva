import type { CreateRuntimeEvolutionProposal, RuntimeEvolutionProposal, RuntimeProposalArea } from '../../shared/types/runtime-evolution'
import { RUNTIME_PROPOSAL_AREAS } from '../../shared/types/runtime-evolution'
import { recordActivity } from '../services/activity-log'
import { getStorage } from '../storage'
import type { ToolContext, ToolExecutor, ToolRegistry } from '.'

export interface RuntimeProposalWriter {
  create(input: CreateRuntimeEvolutionProposal): Promise<RuntimeEvolutionProposal>
  recordCreated?(proposal: RuntimeEvolutionProposal, conversationId?: string): void
}

const MAX_TEXT_LENGTH = 800
const MAX_ITEMS = 12

function readText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`)
  const text = value.trim()
  if (text.length > MAX_TEXT_LENGTH) throw new Error(`${name} must be ${MAX_TEXT_LENGTH} characters or fewer.`)
  return text
}

function readList(value: unknown, name: string, maxItems = MAX_ITEMS): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must contain at least one item.`)
  if (value.length > maxItems) throw new Error(`${name} may contain at most ${maxItems} items.`)
  return value.map((item, index) => readText(item, `${name}[${index}]`))
}

export function createRuntimeProposalTools(_registry: ToolRegistry, writer: RuntimeProposalWriter = {
  create: (input) => getStorage().runtimeProposals.create(input),
  recordCreated: (proposal, conversationId) => {
    void recordActivity({ category: 'system', action: 'runtime_proposal.created', status: 'info', summary: `Created runtime evolution proposal "${proposal.title}".`, conversationId })
  },
}): ToolExecutor[] {
  return [{
    definition: {
      name: 'create_runtime_proposal',
      description: 'Create a durable, reviewable runtime evolution proposal from diagnosed evidence. It never changes configuration, plugins, agents, files, or code. A user must approve or reject the proposal in Settings before any later work may be considered.',
      parameters: {
        type: 'object', required: ['title', 'area', 'problem', 'evidence', 'proposedChanges', 'validationPlan', 'rollbackPlan'],
        properties: {
          title: { type: 'string', description: 'Short proposal title.' }, area: { type: 'string', enum: RUNTIME_PROPOSAL_AREAS, description: 'Affected runtime area.' }, problem: { type: 'string', description: 'Observed problem, not a speculative claim.' },
          evidence: { type: 'array', items: { type: 'string' }, description: 'Concrete diagnostic evidence.' }, proposedChanges: { type: 'array', items: { type: 'string' }, description: 'Suggested changes for later human review.' },
          validationPlan: { type: 'array', items: { type: 'string' }, description: 'How a later approved change would be verified.' }, rollbackPlan: { type: 'array', items: { type: 'string' }, description: 'How a later approved change would be reverted.' },
        },
      },
    },
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
      const area = readText(params.area, 'area') as RuntimeProposalArea
      if (!(RUNTIME_PROPOSAL_AREAS as readonly string[]).includes(area)) throw new Error(`area must be one of: ${RUNTIME_PROPOSAL_AREAS.join(', ')}.`)
      const proposal = await writer.create({ title: readText(params.title, 'title'), area, problem: readText(params.problem, 'problem'), evidence: readList(params.evidence, 'evidence'), proposedChanges: readList(params.proposedChanges, 'proposedChanges'), validationPlan: readList(params.validationPlan, 'validationPlan', 8), rollbackPlan: readList(params.rollbackPlan, 'rollbackPlan', 8), createdBy: 'agent', sourceConversationId: context.conversationId })
      writer.recordCreated?.(proposal, context.conversationId)
      return JSON.stringify({ proposalId: proposal.id, status: proposal.status, message: 'Proposal saved for user review. No runtime configuration, plugin, Agent, file, or code has been changed.' }, null, 2)
    },
  }]
}
