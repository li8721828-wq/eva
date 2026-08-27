import { IPC } from './ipc-channels'
import type { ChatMessage, Conversation } from './types/conversation'
import type { TaskRunSnapshot } from './types/task'
import type { RequirementRun, SubmitClarificationAnswersInput, SubmitCodingInput, SubmitDslInput, SubmitRequirementInput, SubmitRequirementModelingInput, SubmitSpecificationInput, SubmitSpecificationResolutionInput } from './types/requirement-engineering'

/** Canonical argument/result contracts for high-risk renderer/main boundaries. */
export interface IpcContract {
  [IPC.CONVERSATION_LOAD]: {
    args: [id: string]
    result: { conversation: Conversation; messages: ChatMessage[] }
  }
  [IPC.FILE_READ]: { args: [path: string, workspacePath?: string]; result: string }
  [IPC.FILE_WRITE]: { args: [path: string, content: string, workspacePath?: string]; result: void }
  [IPC.TASK_CANCEL]: { args: [conversationId: string]; result: boolean }
  [IPC.TASK_SNAPSHOT]: { args: [conversationId: string]; result: TaskRunSnapshot | null }
  [IPC.CONFIG_GET]: { args: [key: string]; result: unknown }
  [IPC.CONFIG_SET]: { args: [key: string, value: unknown]; result: void }
  [IPC.CONFIG_GET_ALL]: { args: []; result: Record<string, unknown> }
  [IPC.REQUIREMENT_RUN_LIST]: { args: [conversationId?: string]; result: RequirementRun[] }
  [IPC.REQUIREMENT_RUN_SUBMIT]: { args: [input: SubmitRequirementInput]; result: RequirementRun }
  [IPC.REQUIREMENT_CLARIFICATION_ANSWER]: { args: [input: SubmitClarificationAnswersInput]; result: RequirementRun }
  [IPC.REQUIREMENT_MODELING_SUBMIT]: { args: [input: SubmitRequirementModelingInput]; result: RequirementRun }
  [IPC.REQUIREMENT_SPECIFICATION_SUBMIT]: { args: [input: SubmitSpecificationInput]; result: RequirementRun }
  [IPC.REQUIREMENT_DSL_SUBMIT]: { args: [input: SubmitDslInput]; result: RequirementRun }
  [IPC.REQUIREMENT_CODING_SUBMIT]: { args: [input: SubmitCodingInput]; result: RequirementRun }
  [IPC.REQUIREMENT_SPECIFICATION_RESOLUTION]: { args: [input: SubmitSpecificationResolutionInput]; result: RequirementRun }
  [IPC.REQUIREMENT_RUN_ABORT]: { args: [conversationId: string]; result: void }
  [IPC.REQUIREMENT_DOCUMENT_CONTEXT_MENU]: { args: [document: { path: string }]; result: void }
}

export type ContractChannel = keyof IpcContract
export type ContractArgs<K extends ContractChannel> = IpcContract[K]['args']
export type ContractResult<K extends ContractChannel> = IpcContract[K]['result']
