import { ipcMain, type IpcMainEvent } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { RuntimeProposalStatus } from '../../shared/types/runtime-evolution'
import { recordActivity } from '../services/activity-log'
import { getStorage } from '../storage'

function implementationGoal(proposal: import('../../shared/types/runtime-evolution').RuntimeEvolutionProposal): string {
  return [
    `Implement approved runtime evolution proposal: ${proposal.title}`,
    '',
    `Problem: ${proposal.problem}`,
    'Evidence:',
    ...proposal.evidence.map((item) => `- ${item}`),
    'Approved changes:',
    ...proposal.proposedChanges.map((item) => `- ${item}`),
    'Required validation:',
    ...proposal.validationPlan.map((item) => `- ${item}`),
    'Rollback plan:',
    ...proposal.rollbackPlan.map((item) => `- ${item}`),
    '',
    'Work only within the selected workspace and report concrete evidence for every completed change. Do not broaden the approved scope.',
  ].join('\n')
}

export function registerRuntimeProposalHandlers(): void {
  ipcMain.handle(IPC.RUNTIME_PROPOSAL_LIST, async () => getStorage().runtimeProposals.list())
  ipcMain.handle(IPC.RUNTIME_PROPOSAL_DECIDE, async (_event, id: string, status: RuntimeProposalStatus, decisionNote?: string) => {
    if (status !== 'approved' && status !== 'rejected') throw new Error('Proposal decisions must be approved or rejected.')
    const proposal = await getStorage().runtimeProposals.decide(id, status, decisionNote)
    void recordActivity({ category: 'system', action: `runtime_proposal.${status}`, status: status === 'approved' ? 'success' : 'info', summary: `${status === 'approved' ? 'Approved' : 'Rejected'} runtime evolution proposal "${proposal.title}".`, conversationId: proposal.sourceConversationId })
    return proposal
  })
  ipcMain.handle(IPC.RUNTIME_PROPOSAL_BEGIN_IMPLEMENTATION, async (event, id: string, conversationId: string) => {
    const conversation = await getStorage().conversations.getConversation(conversationId)
    if (!conversation) throw new Error('Implementation conversation not found.')
    const agents = await getStorage().agents.listAgents()
    const configuredPrimary = getStorage().config.get('primaryChatAgentId')
    const agentId = conversation.agentId && conversation.agentId !== '__auto__'
      ? conversation.agentId
      : agents.find((agent) => agent.id === configuredPrimary)?.id || agents[0]?.id
    if (!agentId) throw new Error('No agent is available to implement the approved proposal.')

    const proposal = await getStorage().runtimeProposals.beginImplementation(id, conversationId)
    ipcMain.emit(IPC.TASK_GOAL_START, { sender: event.sender } as IpcMainEvent, {
      conversationId,
      agentId,
      goal: implementationGoal(proposal),
    })
    void recordActivity({
      category: 'system',
      action: 'runtime_proposal.implementation_started',
      status: 'info',
      summary: `Started implementation task for approved runtime evolution proposal "${proposal.title}".`,
      conversationId,
      workspaceId: conversation.workspaceId,
    })
    return proposal
  })
}
