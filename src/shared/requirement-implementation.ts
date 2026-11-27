import type { RequirementRun } from './types/requirement-engineering'

/** Business decisions must be resolved; code/format evidence can be handled by the implementation Agent. */
export function requirementImplementationMode(run: RequirementRun): 'confirmed' | 'assumptions' | undefined {
  if (run.clarificationQuestions.length || run.specResolutionQuestions?.some(question => question.category === 'requirements')) return undefined
  if (['ready-for-specification', 'ready-for-implementation', 'awaiting-spec-resolution'].includes(run.status) && !run.pendingMaterials?.length) return 'confirmed'
  if (run.status === 'awaiting-materials' && run.materialPreviewDocumentId
    && run.materialDraftDocumentIds?.some(id => run.documents.some(document => document.id === id && document.dimension === 'material-draft-specification'))) return 'assumptions'
  return undefined
}
