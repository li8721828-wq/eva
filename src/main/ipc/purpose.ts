import { randomUUID } from 'crypto'
import { trustedIpcMain as ipcMain } from './trusted-ipc'
import { IPC } from '../../shared/ipc-channels'
import { getStorage } from '../storage'
import { PurposeService } from '../services/purpose-service'
import { purposeText } from '../storage/purpose-store'
import type { ContinuePurposeInput, CreatePurposeInput, PurposeHandoffInput, PurposeRef, UpdatePurposeInput } from '../../shared/types/purpose'
import { notifyRendererConversationChanged } from '../services/conversation-notify'
import { PurposeDraftService } from '../services/purpose-draft-service'
import type { ApplicationServices } from '../services/application-services'
import type { GeneratePurposeDraftInput } from '../../shared/types/purpose'

export function registerPurposeHandlers(services?: Pick<ApplicationServices, 'storage' | 'providerRegistry'>): void {
  const drafts = services ? new PurposeDraftService(services.storage, services.providerRegistry) : null
  const owners = new Set<number>()
  ipcMain.handle(IPC.PURPOSE_DRAFT_GENERATE, async (event, input: GeneratePurposeDraftInput) => {
    if (!drafts) throw new Error('AI drafting services are unavailable.')
    const owner = event.sender.id
    if (!owners.has(owner)) {
      owners.add(owner)
      event.sender.once('destroyed', () => { drafts.cancelOwner(owner); owners.delete(owner) })
    }
    return drafts.generate(owner, input)
  })
  ipcMain.handle(IPC.PURPOSE_DRAFT_CANCEL, async (event, requestId: string) => { drafts?.cancel(event.sender.id, requestId) })
  ipcMain.handle(IPC.PURPOSE_LIST, async (_event, workspaceId: string) => {
    const storage = getStorage()
    return storage.purposes.list(await new PurposeService(storage).workspace(workspaceId))
  })
  ipcMain.handle(IPC.PURPOSE_CREATE, async (_event, workspaceId: string, input: CreatePurposeInput) => {
    const storage = getStorage()
    return storage.purposes.create(await new PurposeService(storage).workspace(workspaceId), input)
  })
  ipcMain.handle(IPC.PURPOSE_UPDATE, async (_event, ref: PurposeRef, input: UpdatePurposeInput) => {
    const storage = getStorage()
    const service = new PurposeService(storage)
    await service.assertIdle(ref)
    return storage.purposes.update(await service.workspace(ref.workspaceId), ref.purposeId, input)
  })
  ipcMain.handle(IPC.PURPOSE_NOTE, async (_event, ref: PurposeRef, revision: number, kind: 'decision' | 'finding', content: string) => {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Provide the current purpose revision.')
    if (!['decision', 'finding'].includes(kind)) throw new Error('Invalid purpose note kind.')
    const storage = getStorage()
    return storage.purposes.mutate(await new PurposeService(storage).workspace(ref.workspaceId), ref.purposeId, revision, 'note', 'Project note recorded.', purpose => {
      purpose.notes.push({ id: randomUUID(), kind, content: purposeText(content, 4000, true), createdAt: Date.now() })
    })
  })
  ipcMain.handle(IPC.PURPOSE_HANDOFF, async (_event, input: PurposeHandoffInput) => new PurposeService(getStorage()).handoff(input))
  ipcMain.handle(IPC.PURPOSE_PREFLIGHT, async (_event, ref: PurposeRef) => new PurposeService(getStorage()).preflight(ref))
  ipcMain.handle(IPC.PURPOSE_CONTINUE, async (_event, input: ContinuePurposeInput) => {
    const conversation = await new PurposeService(getStorage()).continue(input)
    notifyRendererConversationChanged(conversation.id)
    return conversation
  })
  ipcMain.handle(IPC.PURPOSE_ATTACH, async (_event, ref: PurposeRef, conversationId: string) => {
    await new PurposeService(getStorage()).attach(ref, conversationId)
    notifyRendererConversationChanged(conversationId)
  })
}
