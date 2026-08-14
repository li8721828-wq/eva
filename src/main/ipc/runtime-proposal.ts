import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { RuntimeProposalStatus } from '../../shared/types/runtime-evolution'
import { recordActivity } from '../services/activity-log'
import { getStorage } from '../storage'

export function registerRuntimeProposalHandlers(): void {
  ipcMain.handle(IPC.RUNTIME_PROPOSAL_LIST, async () => getStorage().runtimeProposals.list())
  ipcMain.handle(IPC.RUNTIME_PROPOSAL_DECIDE, async (_event, id: string, status: RuntimeProposalStatus, decisionNote?: string) => {
    if (status !== 'approved' && status !== 'rejected') throw new Error('Proposal decisions must be approved or rejected.')
    const proposal = await getStorage().runtimeProposals.decide(id, status, decisionNote)
    void recordActivity({ category: 'system', action: `runtime_proposal.${status}`, status: status === 'approved' ? 'success' : 'info', summary: `${status === 'approved' ? 'Approved' : 'Rejected'} runtime evolution proposal "${proposal.title}".`, conversationId: proposal.sourceConversationId })
    return proposal
  })
}
