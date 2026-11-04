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

  it('defaults old configs to Eva and persists an explicit engine selection', () => {
    const store = new ConfigStore()
    expect(store.get('executionEngine')).toEqual({ id: 'eva', nodePath: 'node' })
    store.set('executionEngine', { id: 'deepseek-harness', nodePath: 'D:\\node\\node.exe' })
    expect(new ConfigStore().get('executionEngine')).toEqual({ id: 'deepseek-harness', nodePath: 'D:\\node\\node.exe' })
  })

  it('repairs invalid stored execution engine settings', () => {
    fs.writeFileSync(path.join(state.userDataDir, 'config.json'), JSON.stringify({ executionEngine: { id: 'unknown', nodePath: 'node' } }))
    expect(new ConfigStore().get('executionEngine')).toEqual({ id: 'eva', nodePath: 'node' })
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

  it('persists a model selection in one write and leaves both keys intact on failure', () => {
    const store = new ConfigStore()
    const underlying = (store as any).store
    const write = vi.spyOn(underlying, 'set')
    store.selectModel('connection-b', 'model-b')
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith({ activeProviderId: 'connection-b', activeModel: 'model-b' })
    write.mockImplementationOnce(() => { throw new Error('disk full') })
    expect(() => store.selectModel('connection-c', 'model-c')).toThrow('disk full')
    const saved = JSON.parse(fs.readFileSync(path.join(state.userDataDir, 'config.json'), 'utf8'))
    expect(saved).toMatchObject({ activeProviderId: 'connection-b', activeModel: 'model-b' })
  })

  it('allows clearing the pair but rejects partial or invalid selections', () => {
    const store = new ConfigStore()
    expect(() => store.selectModel('connection', '')).toThrow()
    expect(() => store.selectModel('', 'model')).toThrow()
    expect(() => store.selectModel(null as any, 'model')).toThrow()
    store.selectModel('', '')
    expect(store.get('activeProviderId')).toBe('')
    expect(store.get('activeModel')).toBe('')
  })

  it('persists reasoning per connection and model, and keeps the atomic selection on failure', () => {
    const store = new ConfigStore()
    const provider = { id: 'ds', name: 'DS', type: 'deepseek' as const, apiKey: '', isEnabled: true, models: [{ id: 'deepseek-flash', name: 'Flash' }, { id: 'deepseek-v4-pro', name: 'Pro' }] }
    store.saveProvider(provider)
    store.saveProvider({ ...provider, id: 'other' })
    store.selectModel('ds', 'deepseek-flash', 'max')
    store.selectModel('ds', 'deepseek-v4-pro', 'low')
    store.selectModel('other', 'deepseek-flash', 'high')
    const reloaded = new ConfigStore()
    expect(reloaded.getProvider('ds')?.models?.map(model => model.reasoningSelection)).toEqual(['max', 'low'])
    expect(reloaded.getProvider('other')?.models?.[0].reasoningSelection).toBe('high')
    reloaded.saveProvider(provider)
    expect(reloaded.getProvider('ds')?.models?.[0].reasoningSelection).toBe('max')
    const before = fs.readFileSync(path.join(state.userDataDir, 'config.json'), 'utf8')
    expect(() => reloaded.selectModel('ds', 'deepseek-flash', 'medium')).toThrow('does not support')
    const write = vi.spyOn((reloaded as any).store, 'set').mockImplementationOnce(() => { throw new Error('disk full') })
    expect(() => reloaded.selectModel('ds', 'deepseek-flash', 'none')).toThrow('disk full')
    expect(write).toHaveBeenCalledOnce()
    expect(fs.readFileSync(path.join(state.userDataDir, 'config.json'), 'utf8')).toBe(before)
  })
})
