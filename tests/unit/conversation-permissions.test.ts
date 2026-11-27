import { describe, expect, it, vi } from 'vitest'
import { conversationPermissionsChanged } from '../../src/shared/conversation-permissions'
import { ConversationLifecycleService } from '../../src/main/services/conversation-lifecycle-service'

vi.mock('../../src/main/services/supplier-pricing-service', () => ({ ensureProviderPricing: vi.fn() }))
vi.mock('../../src/main/services/usage-pricing-service', () => ({ hydrateUsagePricing: vi.fn() }))

describe('conversation access changes', () => {
  it('rejects renderer attempts to forge implementation task ownership', async () => {
    const updateConversation = vi.fn()
    const service = new ConversationLifecycleService({ conversations: { updateConversation } } as any)
    await expect(service.update('c', { requirementImplementation: { taskId: 'foreign' } } as any)).rejects.toThrow('managed by the host')
    expect(updateConversation).not.toHaveBeenCalled()
  })
  it('compares effective permissions and ignores folder order and ordinary metadata', () => {
    const previous = { permissionLevel: 'granted-folders' as const, fileAccessGrants: [{ path: 'D:/a', access: 'read' as const }, { path: 'D:/b', access: 'read-write' as const }] }
    expect(conversationPermissionsChanged(previous, { fileAccessGrants: [...previous.fileAccessGrants].reverse() })).toBe(false)
    expect(conversationPermissionsChanged(previous, { permissionLevel: 'full-access' })).toBe(true)
    expect(conversationPermissionsChanged({ accessScope: 'full' }, { permissionLevel: 'workspace' })).toBe(true)
  })
  it('invalidates old running snapshots only after a successful permission update, including revocation', async () => {
    let saved: any = { id: 'c', permissionLevel: 'workspace', fileAccessGrants: [] }
    const updateConversation = vi.fn(async (_id, data) => { saved = { ...saved, ...data } })
    const changed = vi.fn(() => expect(saved.permissionLevel).toBe('full-access'))
    const service = new ConversationLifecycleService({ conversations: { getConversation: async () => saved, updateConversation } } as any, changed)
    await service.update('c', { title: 'same access' })
    expect(changed).not.toHaveBeenCalled()
    await service.update('c', { permissionLevel: 'full-access' })
    expect(changed).toHaveBeenCalledOnce()
    changed.mockImplementation(() => expect(saved.permissionLevel).toBe('workspace'))
    await service.update('c', { permissionLevel: 'workspace' })
    expect(changed).toHaveBeenCalledTimes(2)
    updateConversation.mockRejectedValueOnce(new Error('disk full'))
    await expect(service.update('c', { permissionLevel: 'full-access' })).rejects.toThrow('disk full')
    expect(changed).toHaveBeenCalledTimes(2)
  })
})
