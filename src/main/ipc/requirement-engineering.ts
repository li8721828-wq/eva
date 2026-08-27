import { trustedIpcMain as ipcMain } from './trusted-ipc'
import { IPC } from '../../shared/ipc-channels'
import type { ProviderRegistry } from '../providers'
import type { ProjectIndexService } from '../services/project-index-service'
import type { StorageManager } from '../storage'
import type { SubmitClarificationAnswersInput, SubmitCodingInput, SubmitDslInput, SubmitRequirementInput, SubmitRequirementModelingInput, SubmitSpecificationInput, SubmitSpecificationResolutionInput } from '../../shared/types/requirement-engineering'
import { RequirementEngineeringService } from '../services/requirement-engineering-service'

export function registerRequirementEngineeringHandlers(providers: ProviderRegistry, projectIndex: ProjectIndexService | undefined, storage: StorageManager): void {
  const service = new RequirementEngineeringService(providers, projectIndex, { storage })
  ipcMain.handle(IPC.REQUIREMENT_RUN_LIST, async (_event, conversationId?: string) => service.list(conversationId))
  ipcMain.handle(IPC.REQUIREMENT_RUN_SUBMIT, async (event, input: SubmitRequirementInput) => {
    return service.submit(input, (progress) => event.sender.send(IPC.REQUIREMENT_PROGRESS, progress))
  })
  ipcMain.handle(IPC.REQUIREMENT_CLARIFICATION_ANSWER, async (event, input: SubmitClarificationAnswersInput) => {
    return service.answerClarifications(input, (progress) => event.sender.send(IPC.REQUIREMENT_PROGRESS, progress))
  })
  ipcMain.handle(IPC.REQUIREMENT_MODELING_SUBMIT, async (event, input: SubmitRequirementModelingInput) => {
    return service.modelRequirements(input, (progress) => event.sender.send(IPC.REQUIREMENT_PROGRESS, progress))
  })
  ipcMain.handle(IPC.REQUIREMENT_SPECIFICATION_SUBMIT, async (event, input: SubmitSpecificationInput) => {
    return service.buildSpecification(input, (progress) => event.sender.send(IPC.REQUIREMENT_PROGRESS, progress))
  })
  ipcMain.handle(IPC.REQUIREMENT_DSL_SUBMIT, async (event, input: SubmitDslInput) => {
    return service.buildDsl(input, (progress) => event.sender.send(IPC.REQUIREMENT_PROGRESS, progress))
  })
  ipcMain.handle(IPC.REQUIREMENT_CODING_SUBMIT, async (event, input: SubmitCodingInput) => {
    return service.buildCoding(input, (progress) => event.sender.send(IPC.REQUIREMENT_PROGRESS, progress))
  })
  ipcMain.handle(IPC.REQUIREMENT_SPECIFICATION_RESOLUTION, async (event, input: SubmitSpecificationResolutionInput) => {
    return service.resolveSpecificationBlockers(input, (progress) => event.sender.send(IPC.REQUIREMENT_PROGRESS, progress))
  })
  ipcMain.handle(IPC.REQUIREMENT_RUN_ABORT, async (_event, conversationId: string) => service.abort(conversationId))
  ipcMain.handle(IPC.REQUIREMENT_DOCUMENT_CONTEXT_MENU, async (event, document: { path: string }) => {
    await service.showDocumentContextMenu(event.sender, document.path)
  })
}
