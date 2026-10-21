import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { writeJsonAtomic, writeJsonAtomicAsync } from '../../src/main/storage/atomic-file'

describe('writeJsonAtomic', () => {
  it.each(['EPERM', 'EBUSY', 'EACCES'])('retries a transient %s without losing the previous document', async (code) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-atomic-retry-'))
    const target = path.join(dir, 'state.json')
    await fs.writeFile(target, '{"revision":1}')
    const rename = vi.spyOn(fs, 'rename').mockImplementationOnce(async () => {
      expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual({ revision: 1 })
      throw Object.assign(new Error('locked'), { code })
    })
    try {
      await writeJsonAtomicAsync(target, { revision: 2 })
      expect(rename).toHaveBeenCalledTimes(2)
      expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual({ revision: 2 })
      expect(await fs.readdir(dir)).toEqual(['state.json'])
    } finally { rename.mockRestore(); await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('bounds retries, preserves the original on permanent failure and cleans temporary files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-atomic-retry-'))
    const target = path.join(dir, 'state.json')
    await fs.writeFile(target, '{"revision":1}')
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('locked'), { code: 'EPERM' }))
    try {
      await expect(writeJsonAtomicAsync(target, { revision: 2 })).rejects.toThrow('locked')
      expect(rename).toHaveBeenCalledTimes(5)
      expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual({ revision: 1 })
      expect(await fs.readdir(dir)).toEqual(['state.json'])
    } finally { rename.mockRestore(); await fs.rm(dir, { recursive: true, force: true }) }
  })
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
