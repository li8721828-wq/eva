import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

const state = vi.hoisted(() => ({ userDataDir: '' }))

// electron-store only derives its path from Electron; the underlying `conf`
// implementation is plain Node, so wire it to the temp directory directly.
// This keeps the test off the real user-data directory and still exercises the
// real corrupt-file / clearInvalidConfig behaviour.
vi.mock('electron-store', async () => {
  const Conf = ((await import('conf')) as { default: unknown }).default as any
  class ElectronStoreLike extends Conf {
    constructor(options: Record<string, unknown> = {}) {
      const { name, ...rest } = options
      super({ ...rest, configName: name ?? 'config', cwd: state.userDataDir })
    }
  }
  return { default: ElectronStoreLike }
})

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => state.userDataDir),
    getVersion: vi.fn(() => '0.0.0-test'),
  },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
}))

import { ConfigStore } from '../../src/main/storage/config-store'

describe('ConfigStore startup recovery', () => {
  beforeEach(() => {
    state.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-test-config-'))
  })

  afterEach(() => {
    fs.rmSync(state.userDataDir, { recursive: true, force: true })
  })

  it('starts from defaults and backs up an unreadable config file', () => {
    fs.writeFileSync(path.join(state.userDataDir, 'config.json'), '{ this is not json', 'utf-8')

    const store = new ConfigStore()

    expect(store.get('activeProviderId')).toBe('openai')
    const backups = fs.readdirSync(state.userDataDir).filter((name) => name.startsWith('config.json.corrupt-'))
    expect(backups.length).toBe(1)
    const written = JSON.parse(fs.readFileSync(path.join(state.userDataDir, 'config.json'), 'utf8'))
    expect(written.activeProviderId).toBe('openai')
  })

  it('repairs keys whose persisted shape is unusable but keeps valid values', () => {
    fs.writeFileSync(path.join(state.userDataDir, 'config.json'), JSON.stringify({
      providers: 'not-a-list',
      activeModel: 42,
      modelPools: { nope: true },
      workspacePath: ['/somewhere'],
      theme: 'dark',
    }), 'utf-8')

    const store = new ConfigStore()

    expect(Array.isArray(store.get('providers'))).toBe(true)
    expect(store.get('providers').length).toBeGreaterThan(0)
    expect(store.get('activeModel')).toBe('gpt-4o')
    expect(store.get('modelPools')).toEqual([])
    expect(store.get('workspacePath')).toBe('')
    expect(store.get('theme')).toBe('dark')
  })
})
