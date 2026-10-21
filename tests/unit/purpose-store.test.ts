import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PurposeStore } from '../../src/main/storage/purpose-store'

let root: string
const input = { title: '部分退款', objective: '支持订单部分退款', scope: '不改支付协议', acceptanceCriteria: ['重复请求不能重复退款'], milestones: ['接口与幂等', '验证'] }
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-purpose-test-')) })
afterEach(async () => { expect(path.dirname(root)).toBe(os.tmpdir()); expect(path.basename(root)).toMatch(/^eva-purpose-test-/); await fs.rm(root, { recursive: true, force: true }) })

describe('project-local purposes', () => {
  it('does not create files while browsing an untouched project', async () => {
    expect(await new PurposeStore().list(root)).toEqual([])
    expect(await fs.readdir(root)).toEqual([])
  })
  it('survives fresh store instances and a copy to another project location', async () => {
    const store = new PurposeStore(), purpose = await store.create(root, input)
    expect(await new PurposeStore().get(root, purpose.id)).toEqual(purpose)
    const other = path.join(root, 'other-checkout')
    await fs.mkdir(other)
    await fs.cp(path.join(root, '.eva'), path.join(other, '.eva'), { recursive: true })
    expect((await new PurposeStore().list(other))[0]).toEqual(purpose)
  })
  it('retains unconfirmed planning notes without copying generator metadata into project schema', async () => {
    const store = new PurposeStore()
    const purpose = await store.create(root, { ...input, planningNotes: ['AI 假设（待确认）: 使用已有支付协议', '待确认问题: 退款上限？'] })
    expect(purpose.notes.map(note => note.content)).toEqual(['AI 假设（待确认）: 使用已有支付协议', '待确认问题: 退款上限？'])
    expect(purpose).not.toHaveProperty('planningNotes')
    expect(await new PurposeStore().get(root, purpose.id)).toEqual(purpose)
  })
  it('rejects stale updates instead of overwriting newer work', async () => {
    const a = new PurposeStore(), b = new PurposeStore(), purpose = await a.create(root, input)
    await a.update(root, purpose.id, { ...purpose, reason: 'Clarify scope', scope: '仅支持已支付订单' })
    await expect(b.update(root, purpose.id, { ...purpose, reason: 'old', title: 'stale' })).rejects.toThrow('Purpose changed')
    const result = await b.get(root, purpose.id)
    expect(result.scope).toBe('仅支持已支付订单')
    expect(result.notes[0].content).toContain('不改支付协议')
    expect(result.history).toHaveLength(2)
  })
  it('requires evidence for completed milestones and explicit acceptance for completion', async () => {
    const store = new PurposeStore(), purpose = await store.create(root, input)
    await expect(store.update(root, purpose.id, { ...purpose, reason: '', milestones: purpose.milestones.map(item => ({ ...item, status: 'completed' })) })).rejects.toThrow('evidence')
    await expect(store.update(root, purpose.id, { ...purpose, status: 'completed', reason: 'done' })).rejects.toThrow('all milestones')
    await expect(store.update(root, purpose.id, { ...purpose, objective: '改为全额退款', reason: '' })).rejects.toThrow('text')
    const milestones = purpose.milestones.map(item => ({ ...item, status: 'completed' as const, evidence: 'CI refund-tests at commit abc: 12 passed' }))
    await expect(store.update(root, purpose.id, { ...purpose, milestones, status: 'completed', reason: '' })).rejects.toThrow('text')
    const accepted = await store.update(root, purpose.id, { ...purpose, milestones, status: 'completed', reason: '验收标准逐条核实，退款幂等测试通过。' })
    expect(accepted.status).toBe('completed')
  })
  it('serializes simultaneous execution records without dropping either', async () => {
    const store = new PurposeStore(), purpose = await store.create(root, input)
    await Promise.all(['a', 'b', 'c'].map(value => store.mutate(root, purpose.id, undefined, 'test', value, item => {
      item.notes.push({ id: crypto.randomUUID(), kind: 'finding', content: value, createdAt: Date.now() })
    })))
    expect((await store.get(root, purpose.id)).notes.map(item => item.content).sort()).toEqual(['a', 'b', 'c'])
  })
  it('rejects corruption, traversal, and unexpected imported fields without overwriting the file', async () => {
    const store = new PurposeStore(), purpose = await store.create(root, input)
    await expect(store.mutate(root, purpose.id, purpose.revision, 'bad-input', 'test', value => {
      value.notes.push({ id: crypto.randomUUID(), kind: 'finding', content: 'x'.repeat(70001), createdAt: Date.now() })
    })).rejects.toThrow('oversized')
    expect((await store.get(root, purpose.id)).revision).toBe(1)
    await expect(store.get(root, '../outside')).rejects.toThrow('ID')
    const file = path.join(root, '.eva', 'purposes', `${purpose.id}.json`)
    const raw = JSON.stringify({ ...purpose, credentials: 'must-not-be-inherited' })
    await fs.writeFile(file, raw)
    await expect(store.update(root, purpose.id, { ...purpose, reason: 'edit' })).rejects.toThrow('Unexpected')
    expect(await fs.readFile(file, 'utf8')).toBe(raw)
    await fs.writeFile(file, '{<<<<<<< conflict')
    await expect(store.list(root)).rejects.toThrow()
  })
  it('refuses an external directory junction', async () => {
    const outside = path.join(root, 'outside'), project = path.join(root, 'project')
    await fs.mkdir(outside); await fs.mkdir(project)
    await fs.symlink(outside, path.join(project, '.eva'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(new PurposeStore().create(project, input)).rejects.toThrow('real project')
    expect(await fs.readdir(outside)).toEqual([])
  })
  it('fails closed when another process owns the write lock', async () => {
    const store = new PurposeStore(), purpose = await store.create(root, input)
    await fs.writeFile(path.join(root, '.eva', 'purposes', '.write-lock'), 'other writer')
    await expect(store.update(root, purpose.id, { ...purpose, reason: 'x' })).rejects.toThrow('another process')
    expect((await store.get(root, purpose.id)).revision).toBe(1)
  })
})
