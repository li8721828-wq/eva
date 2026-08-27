import { describe, expect, it } from 'vitest'
import { addDocumentAttachmentPaths, addReferenceImagePaths } from '../../src/renderer/lib/chat-attachments'

describe('chat attachment helpers', () => {
  it('deduplicates and bounds document attachments', () => {
    const result = addDocumentAttachmentPaths([{ path: 'a', name: 'a', size: 0, kind: 'file' }], ['a', 'b'], 'folder')
    expect(result.attachments.map((item) => item.path)).toEqual(['a', 'b'])
    expect(result.attachments[1].kind).toBe('folder')
    expect(result.truncated).toBe(false)
  })

  it('bounds reference images to four entries', () => {
    const current = Array.from({ length: 4 }, (_, index) => ({ path: String(index), name: String(index), mediaType: 'image/png' as const }))
    const result = addReferenceImagePaths(current, [{ path: '5', name: '5', mediaType: 'image/png' }])
    expect(result.images).toHaveLength(4)
    expect(result.truncated).toBe(true)
  })
})
