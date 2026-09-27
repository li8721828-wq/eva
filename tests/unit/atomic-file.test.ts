import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { writeJsonAtomic } from '../../src/main/storage/atomic-file'

describe('writeJsonAtomic', () => {
  it('creates parent directories and replaces a JSON document without temp leftovers', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-atomic-file-'))
    try {
      const target = path.join(dataDir, 'nested', 'state.json')
      writeJsonAtomic(target, { revision: 1, status: 'running' })
      writeJsonAtomic(target, { revision: 2, status: 'finished' })

      expect(JSON.parse(await fs.readFile(target, 'utf-8'))).toEqual({ revision: 2, status: 'finished' })
      expect(await fs.readdir(path.dirname(target))).toEqual(['state.json'])
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })
})
