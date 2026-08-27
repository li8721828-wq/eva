import { describe, expect, it } from 'vitest'
import { isTrustedIpcSender, registerTrustedRenderer } from '../../src/main/ipc/trusted-ipc'

describe('trusted IPC sender policy', () => {
  it('rejects a sender that was never registered by Eva', () => {
    expect(isTrustedIpcSender({ sender: { id: 999, isDestroyed: () => false } } as never)).toBe(false)
  })

  it('accepts only a registered, live Eva renderer', () => {
    const renderer = { id: 1000, isDestroyed: () => false, once: () => undefined }
    registerTrustedRenderer(renderer as never)

    expect(isTrustedIpcSender({ sender: renderer } as never)).toBe(true)
    expect(isTrustedIpcSender({ sender: { ...renderer, isDestroyed: () => true } } as never)).toBe(false)
  })
})
