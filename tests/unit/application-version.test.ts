import fs from 'node:fs'
import { expect, it } from 'vitest'
import { APP_VERSION } from '../../src/shared/constants'

it('reports the same release version in the UI, manifest and lockfile', () => {
  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'))
  expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
  expect(APP_VERSION).toBe(manifest.version)
  expect(lock.version).toBe(manifest.version)
  expect(lock.packages[''].version).toBe(manifest.version)
})
