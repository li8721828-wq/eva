import { describe, expect, it } from 'vitest'
import { MARKETPLACE_PLUGINS, validatePluginManifest } from '../../src/shared/plugin-marketplace'

describe('plugin marketplace manifest validation', () => {
  it('exposes installable marketplace entries with valid manifests', () => {
    expect(MARKETPLACE_PLUGINS.length).toBeGreaterThan(0)
    for (const plugin of MARKETPLACE_PLUGINS) {
      expect(validatePluginManifest(plugin)).toMatchObject({ id: plugin.id, name: plugin.name })
    }
  })

  it('rejects manifests with unsafe identifiers or unsupported permissions', () => {
    expect(() => validatePluginManifest({ id: '../unsafe', name: 'Unsafe', version: '1.0.0', description: 'x', author: 'x', category: 'integration', permissions: [] })).toThrow('Plugin id')
    expect(() => validatePluginManifest({ id: 'valid-plugin', name: 'Valid', version: '1.0.0', description: 'x', author: 'x', category: 'integration', permissions: ['shell-root'] })).toThrow('unsupported permission')
  })
})
