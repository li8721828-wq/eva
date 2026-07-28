import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WorkspaceStore } from '../../src/main/storage/workspace-store'

describe('WorkspaceStore', () => {
  let root: string
  let store: WorkspaceStore

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-workspace-store-'))
    store = new WorkspaceStore(root)
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('creates, de-duplicates, and renames a workspace', async () => {
    const projectPath = path.join(root, 'project')
    fs.mkdirSync(projectPath)

    const workspace = await store.create(projectPath)
    const duplicate = await store.create(projectPath)
    const updated = await store.update(workspace.id, {
      name: 'Renamed project',
    })

    expect(duplicate.id).toBe(workspace.id)
    expect((await store.list())).toHaveLength(1)
    expect(updated.name).toBe('Renamed project')
  })
})
