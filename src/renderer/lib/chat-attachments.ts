import type { ChatDocumentAttachment, ChatImageAttachment } from '../../shared/types/conversation'

export const MAX_REFERENCE_IMAGES = 4
export const MAX_DOCUMENT_ATTACHMENTS = 20

export function addDocumentAttachmentPaths(
  current: ChatDocumentAttachment[],
  paths: string[],
  kind: ChatDocumentAttachment['kind'] = 'file',
): { attachments: ChatDocumentAttachment[]; truncated: boolean } {
  const uniquePaths = paths.filter((filePath) => filePath && !current.some((attachment) => attachment.path === filePath))
  const additions = uniquePaths.slice(0, MAX_DOCUMENT_ATTACHMENTS - current.length).map((filePath) => ({
    path: filePath,
    name: filePath.replace(/^.*[\\/]/, ''),
    size: 0,
    kind,
  }))
  return { attachments: [...current, ...additions], truncated: uniquePaths.length > additions.length }
}

export function addReferenceImagePaths(
  current: ChatImageAttachment[],
  additions: ChatImageAttachment[],
): { images: ChatImageAttachment[]; truncated: boolean } {
  const images = [...current, ...additions].slice(0, MAX_REFERENCE_IMAGES)
  return { images, truncated: current.length + additions.length > images.length }
}
