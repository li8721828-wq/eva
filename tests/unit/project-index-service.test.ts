import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ProjectIndexService } from '../../src/main/services/project-index-service'
import { ProjectIndexStore } from '../../src/main/storage/project-index-store'
import { WorkspaceStore } from '../../src/main/storage/workspace-store'

describe('ProjectIndexService', () => {
  let root: string
  let projectPath: string
  let workspaceStore: WorkspaceStore
  let service: ProjectIndexService

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-project-index-'))
    projectPath = path.join(root, 'project')
    fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true })
    workspaceStore = new WorkspaceStore(root)
    service = new ProjectIndexService(new ProjectIndexStore(root), workspaceStore)
  })

  afterEach(() => {
    service.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('indexes metadata, updates changed files, and removes deleted files', async () => {
    const filePath = path.join(projectPath, 'src', 'math.ts')
    fs.writeFileSync(filePath, "import { clamp } from './number'\nexport function add(left: number, right: number) { return left + right }\n")
    fs.writeFileSync(path.join(projectPath, 'README.md'), '# Project notes\n')
    fs.mkdirSync(path.join(projectPath, 'node_modules'))
    fs.writeFileSync(path.join(projectPath, 'node_modules', 'ignored.js'), 'export const ignored = true')

    const workspace = await workspaceStore.create(projectPath)
    const first = await service.indexWorkspace(workspace)
    const found = await service.search(workspace.id, 'add')
    const status = await service.getStatus(workspace.id)

    expect(Object.keys(first.files).sort()).toEqual(['README.md', 'src/math.ts'])
    expect(first.files['src/math.ts'].symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'add', kind: 'function', exported: true }),
    ]))
    expect(first.files['src/math.ts'].dependencies).toEqual([
      expect.objectContaining({ specifier: './number' }),
    ])
    expect(found[0]).toEqual(expect.objectContaining({ relativePath: 'src/math.ts' }))
    expect(status).toEqual(expect.objectContaining({
      indexedFiles: 2,
      indexedSymbols: 2,
      indexedDependencies: 1,
      languages: expect.arrayContaining([
        expect.objectContaining({ language: 'Markdown', files: 1 }),
        expect.objectContaining({ language: 'TypeScript', files: 1 }),
      ]),
    }))
    expect(JSON.stringify(first)).not.toContain('return left + right')

    fs.writeFileSync(filePath, 'export class Calculator { total = 0 }\n')
    const changed = await service.indexWorkspace(workspace)
    expect(changed.files['src/math.ts'].symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Calculator', kind: 'class' }),
    ]))

    fs.rmSync(filePath)
    const removed = await service.indexWorkspace(workspace)
    expect(removed.files['src/math.ts']).toBeUndefined()
  })

  it('indexes Spring, SQL, and business navigation clues without storing source bodies', async () => {
    const javaPath = path.join(projectPath, 'src', 'ReceivableBillController.java')
    const sqlPath = path.join(projectPath, 'sql', 'receivable-bill.sql')
    fs.mkdirSync(path.dirname(sqlPath), { recursive: true })
    fs.writeFileSync(javaPath, [
      'package com.example.receivable;',
      'import com.example.receivable.ReceivableBillService;',
      '@RestController',
      '@RequestMapping("/receivable")',
      'public class ReceivableBillController {',
      '  @GetMapping("/list")',
      '  public String list() { return "ok"; }',
      '}',
    ].join('\n'))
    fs.writeFileSync(sqlPath, 'select * from ar_receivable_bill where status = 1\n')

    const workspace = await workspaceStore.create(projectPath)
    const snapshot = await service.indexWorkspace(workspace)
    const status = await service.getStatus(workspace.id)
    const businessResults = await service.search(workspace.id, '应收', 20, 'business')
    const apiResults = await service.search(workspace.id, 'receivable', 20, 'api')
    const dataResults = await service.search(workspace.id, 'receivable', 20, 'data')
    const apiCatalog = await service.browse(workspace.id, 'api')
    const completeCatalog = await service.browse(workspace.id, 'all', '', 0, 2)

    expect(snapshot.version).toBe(2)
    expect(snapshot.files['src/ReceivableBillController.java'].symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ReceivableBillController', kind: 'class' }),
      expect.objectContaining({ name: 'list', kind: 'method' }),
    ]))
    expect(snapshot.files['src/ReceivableBillController.java'].facets).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'api', name: '/receivable' }),
      expect.objectContaining({ kind: 'api', name: '/list', detail: 'GET' }),
    ]))
    expect(snapshot.files['sql/receivable-bill.sql'].facets).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'data', name: 'ar_receivable_bill' }),
    ]))
    expect(businessResults.map((result) => result.relativePath)).toContain('src/ReceivableBillController.java')
    expect(apiResults[0]).toEqual(expect.objectContaining({ relativePath: 'src/ReceivableBillController.java' }))
    expect(dataResults.map((result) => result.relativePath)).toContain('sql/receivable-bill.sql')
    expect(status).toEqual(expect.objectContaining({
      indexedApiEndpoints: 3,
      indexedDataEntities: 1,
      indexedBusinessTerms: expect.any(Number),
      dimensions: expect.arrayContaining([
        expect.objectContaining({ scope: 'structure', count: expect.any(Number) }),
        expect.objectContaining({ scope: 'api', count: 3 }),
        expect.objectContaining({ scope: 'data', count: 1 }),
      ]),
    }))
    const structureResults = await service.search(workspace.id, 'receivable', 20, 'structure')
    expect(structureResults.every((result) => result.facets.length === 0 && !result.matchedScopes.includes('api'))).toBe(true)
    expect(apiCatalog.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'api', name: '/receivable', relativePath: 'src/ReceivableBillController.java' }),
    ]))
    expect(completeCatalog.total).toBeGreaterThan(completeCatalog.entries.length)
    expect(completeCatalog.hasMore).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain('return "ok"')
  })
})
