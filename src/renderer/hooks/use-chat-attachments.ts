import { useCallback, useState, type ClipboardEvent, type DragEvent } from 'react'
import type { ChatDocumentAttachment, ChatImageAttachment } from '../../shared/types/conversation'
import { addDocumentAttachmentPaths, addReferenceImagePaths, MAX_REFERENCE_IMAGES } from '@/lib/chat-attachments'

interface ChatAttachmentState {
  referenceImages: ChatImageAttachment[]
  documentAttachments: ChatDocumentAttachment[]
  setReferenceImages: (images: ChatImageAttachment[]) => void
  setDocumentAttachments: (attachments: ChatDocumentAttachment[]) => void
}

const MAX_REFERENCE_IMAGE_BYTES = 12 * 1024 * 1024
const SUPPORTED_REFERENCE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

export function useChatAttachments({ referenceImages, documentAttachments, setReferenceImages, setDocumentAttachments }: ChatAttachmentState) {
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const isSupported = (file: File) => SUPPORTED_REFERENCE_IMAGE_TYPES.includes(file.type as typeof SUPPORTED_REFERENCE_IMAGE_TYPES[number])

  const addReferenceFiles = useCallback((selected: File[]) => {
    const slots = MAX_REFERENCE_IMAGES - referenceImages.length
    if (slots <= 0) return setAttachmentError('You can attach up to four reference images.')
    const supported = selected.filter(isSupported)
    let validationMessage: string | null = supported.length !== selected.length ? 'Use JPG, PNG, or WebP reference images.' : null
    const sized = supported.filter((file) => file.size <= MAX_REFERENCE_IMAGE_BYTES).slice(0, slots)
    if (sized.length !== supported.length) validationMessage = 'Each reference image must be 12 MB or smaller.'
    const additions: ChatImageAttachment[] = sized.map((file) => ({ path: window.eva.file.getPath(file), name: file.name, mediaType: file.type as ChatImageAttachment['mediaType'], size: file.size })).filter((image) => image.path)
    if (additions.length) setReferenceImages(addReferenceImagePaths(referenceImages, additions).images)
    setAttachmentError(validationMessage)
  }, [referenceImages, setReferenceImages])

  const addClipboardImages = useCallback(async (files: File[]) => {
    const slots = MAX_REFERENCE_IMAGES - referenceImages.length
    if (slots <= 0) return setAttachmentError('You can attach up to four reference images.')
    const supported = files.filter(isSupported).slice(0, slots)
    if (!supported.length) return setAttachmentError('Use JPG, PNG, or WebP reference images.')
    try {
      const saved = await Promise.all(supported.map(async (file) => {
        if (file.size > MAX_REFERENCE_IMAGE_BYTES) throw new Error('Each reference image must be 12 MB or smaller.')
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read clipboard image.'))
          reader.onerror = () => reject(new Error('Could not read clipboard image.'))
          reader.readAsDataURL(file)
        })
        const stored = await window.eva.file.saveClipboardImage({ dataUrl, mediaType: file.type as ChatImageAttachment['mediaType'] })
        return { ...stored, mediaType: file.type as ChatImageAttachment['mediaType'] }
      }))
      setReferenceImages(addReferenceImagePaths(referenceImages, saved).images)
      setAttachmentError(null)
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : 'Could not attach clipboard image.')
    }
  }, [referenceImages, setReferenceImages])

  const addDocumentPaths = useCallback(async (paths: string[], kind: ChatDocumentAttachment['kind'] = 'file') => {
    const result = addDocumentAttachmentPaths(documentAttachments, paths, kind)
    if (result.attachments.length > documentAttachments.length) setDocumentAttachments(result.attachments)
    if (result.truncated) setAttachmentError('You can attach up to 20 files or folders at once.')
  }, [documentAttachments, setDocumentAttachments])

  const handleAttachmentDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const workspacePath = event.dataTransfer.getData('application/x-eva-workspace-path')
    if (workspacePath) return void addDocumentPaths([workspacePath], 'folder')
    const files = Array.from(event.dataTransfer.files)
    const images = files.filter((file) => file.type.startsWith('image/'))
    if (images.length) addReferenceFiles(images)
    void addDocumentPaths(files.filter((file) => !file.type.startsWith('image/')).map((file) => window.eva.file.getPath(file)).filter(Boolean))
  }, [addDocumentPaths, addReferenceFiles])

  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.items).filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter((file): file is File => Boolean(file))
    if (!files.length) return
    event.preventDefault()
    const images = files.filter((file) => file.type.startsWith('image/'))
    if (images.length) void addClipboardImages(images)
    void addDocumentPaths(files.filter((file) => !file.type.startsWith('image/')).map((file) => window.eva.file.getPath(file)).filter(Boolean))
  }, [addClipboardImages, addDocumentPaths])

  const removeReferenceImage = useCallback((path: string) => {
    setReferenceImages(referenceImages.filter((image) => image.path !== path))
    setAttachmentError(null)
  }, [referenceImages, setReferenceImages])

  const removeDocumentAttachment = useCallback((path: string) => {
    setDocumentAttachments(documentAttachments.filter((attachment) => attachment.path !== path))
    setAttachmentError(null)
  }, [documentAttachments, setDocumentAttachments])

  return { attachmentError, setAttachmentError, addDocumentPaths, handleAttachmentDrop, handlePaste, removeReferenceImage, removeDocumentAttachment }
}
