import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, listener),
    on: vi.fn(),
  },
}))

import { registerTrustedRenderer, trustedIpcMain } from '../../src/main/ipc/trusted-ipc'

describe('trusted IPC registration', () => {
  beforeEach(() => handlers.clear())

  it('wraps registered handlers with the trusted sender check', async () => {
    trustedIpcMain.handle('test:trusted', async (_event, value: string) => value.toUpperCase())
    const handler = handlers.get('test:trusted')!
    const sender = { id: 3001, isDestroyed: () => false, once: () => undefined }
    registerTrustedRenderer(sender as never)

    await expect(handler({ sender }, 'eva')).resolves.toBe('EVA')
    await expect(handler({ sender: { id: 3002, isDestroyed: () => false } }, 'eva')).rejects.toThrow('rejected')
  })
})
