import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import { writeJsonAtomicAsync } from './atomic-file'
import type { CreatePurposeInput, Purpose, UpdatePurposeInput } from '../../shared/types/purpose'

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const MAX_BYTES = 2 * 1024 * 1024
export function purposeText(value: unknown, max = 4000, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error('Invalid or oversized purpose text.')
  return value.trim()
}
function lines(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) throw new Error('Provide 1–50 acceptance criteria or milestones.')
  return value.map(item => purposeText(item, 1000, true))
}

/** Project-local documents are portable; application conversation IDs are only optional references. */
export class PurposeStore {
  private queues = new Map<string, Promise<unknown>>()

  private async directory(workspacePath: string, create: boolean): Promise<string> {
    const root = await fs.realpath(workspacePath)
    let current = root
    for (const segment of ['.eva', 'purposes']) {
      current = path.join(current, segment)
      if (create) await fs.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error })
      try {
        const stat = await fs.lstat(current)
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Purpose directory must be a real project directory.')
        const relative = path.relative(root, await fs.realpath(current))
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Purpose directory escapes the project.')
      } catch (error) {
        if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return current === path.join(root, '.eva') ? path.join(current, 'purposes') : current
        throw error
      }
    }
    return current
  }

  private async read(directory: string, id: string): Promise<Purpose> {
    if (!ID.test(id)) throw new Error('Invalid purpose ID.')
    const file = path.join(directory, `${id}.json`)
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Invalid purpose document.')
    const data = JSON.parse(await fs.readFile(file, 'utf8')) as Purpose
    return this.validate(data, id)
  }

  private validate(data: Purpose, id: string): Purpose {
    if (data.schemaVersion !== 1 || data.id !== id || !Number.isSafeInteger(data.revision) || data.revision < 1
      || !Array.isArray(data.notes) || !Array.isArray(data.executions) || !Array.isArray(data.handoffs) || !Array.isArray(data.history)) throw new Error('Unsupported or damaged purpose document. Resolve it before continuing.')
    purposeText(data.title, 160, true)
    purposeText(data.objective, 4000, true)
    purposeText(data.scope)
    lines(data.acceptanceCriteria)
    this.validateMilestones(data.milestones)
    if (!['active', 'paused', 'completed'].includes(data.status)) throw new Error('Invalid purpose status.')
    const finite = (value: unknown) => { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Invalid purpose timestamp or revision.') }
    const keys = (value: object, allowed: string[]) => { if (!value || typeof value !== 'object' || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unexpected purpose document fields.') }
    const code = (value: Purpose['handoffs'][number]['code']) => {
      keys(value, ['kind', 'branch', 'commit', 'fingerprint', 'dirty', 'changedFileCount', 'capturedAt'])
      if (!['git', 'unavailable'].includes(value.kind)) throw new Error('Invalid code state.')
      finite(value.capturedAt)
      if (value.branch !== undefined) purposeText(value.branch, 1000)
      if (value.commit !== undefined && !/^[0-9a-f]{40,64}$/.test(value.commit)) throw new Error('Invalid code revision.')
      if (value.fingerprint !== undefined && !/^[0-9a-f]{64}$/.test(value.fingerprint)) throw new Error('Invalid code fingerprint.')
    }
    keys(data, ['schemaVersion', 'id', 'revision', 'title', 'objective', 'scope', 'acceptanceCriteria', 'milestones', 'status', 'notes', 'executions', 'handoffs', 'history', 'createdAt', 'updatedAt'])
    finite(data.createdAt); finite(data.updatedAt)
    for (const note of data.notes) {
      keys(note, ['id', 'kind', 'content', 'createdAt'])
      if (!ID.test(note.id) || !['decision', 'finding'].includes(note.kind)) throw new Error('Invalid purpose note.')
      purposeText(note.content, 70000, true); finite(note.createdAt)
    }
    for (const item of data.handoffs) {
      keys(item, ['id', 'createdAt', 'revision', 'summary', 'blockers', 'nextAction', 'code'])
      if (!ID.test(item.id)) throw new Error('Invalid handoff ID.')
      purposeText(item.summary, 4000, true); purposeText(item.blockers); purposeText(item.nextAction, 4000, true)
      finite(item.createdAt); finite(item.revision); code(item.code)
    }
    for (const item of data.executions) {
      keys(item, ['id', 'conversationId', 'status', 'recordedAt', 'model', 'tools', 'steps', 'code'])
      purposeText(item.id, 500, true); purposeText(item.conversationId, 500, true); purposeText(item.status, 100, true)
      if (item.model !== undefined) purposeText(item.model, 1000)
      finite(item.recordedAt); code(item.code)
      if (!Array.isArray(item.tools) || item.tools.length > 100 || !Array.isArray(item.steps) || item.steps.length > 50) throw new Error('Invalid execution record.')
      for (const tool of item.tools) {
        keys(tool, ['id', 'name', 'status', 'exitCode'])
        purposeText(tool.id, 500, true); purposeText(tool.name, 200, true)
        if (!['succeeded', 'failed', 'unknown'].includes(tool.status) || (tool.exitCode !== undefined && !Number.isInteger(tool.exitCode))) throw new Error('Invalid tool evidence.')
      }
      for (const step of item.steps) { keys(step, ['title', 'status']); purposeText(step.title, 1000); purposeText(step.status, 100, true) }
    }
    for (const item of data.history) { keys(item, ['revision', 'at', 'kind', 'detail']); finite(item.revision); finite(item.at); purposeText(item.kind, 100, true); purposeText(item.detail, 4000) }
    return data
  }

  async list(workspacePath: string): Promise<Purpose[]> {
    const directory = await this.directory(workspacePath, false)
    const files = await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    const documents: Purpose[] = []
    for (const file of files.filter(file => file.endsWith('.json'))) documents.push(await this.read(directory, file.slice(0, -5)))
    return documents.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async get(workspacePath: string, id: string): Promise<Purpose> {
    return this.read(await this.directory(workspacePath, false), id)
  }

  private validateMilestones(value: Purpose['milestones']): void {
    if (!Array.isArray(value) || !value.length || value.length > 50) throw new Error('Provide 1–50 milestones.')
    const ids = new Set<string>()
    for (const item of value) {
      if (!item || !ID.test(item.id) || ids.has(item.id) || !['pending', 'in_progress', 'blocked', 'completed'].includes(item.status)) throw new Error('Invalid milestone.')
      if (Object.keys(item).some(key => !['id', 'title', 'status', 'evidence'].includes(key))) throw new Error('Unexpected milestone fields.')
      ids.add(item.id)
      purposeText(item.title, 1000, true)
      purposeText(item.evidence)
      if (item.status === 'completed' && !item.evidence.trim()) throw new Error('Completed milestones require verification evidence.')
    }
  }

  private async exclusive<T>(workspacePath: string, fn: (directory: string) => Promise<T>): Promise<T> {
    const directory = await this.directory(workspacePath, true)
    const previous = this.queues.get(directory) || Promise.resolve()
    const operation = previous.catch(() => undefined).then(async () => {
      const lockPath = path.join(directory, '.write-lock')
      const lock = await fs.open(lockPath, 'wx').catch(() => { throw new Error('Purpose files are being written by another process. Retry later; after a crash inspect .eva/purposes/.write-lock.') })
      try { return await fn(directory) } finally { await lock.close(); await fs.unlink(lockPath) }
    })
    this.queues.set(directory, operation)
    try { return await operation } finally { if (this.queues.get(directory) === operation) this.queues.delete(directory) }
  }

  private async write(directory: string, purpose: Purpose): Promise<void> {
    this.validate(purpose, purpose.id)
    if (Buffer.byteLength(JSON.stringify(purpose)) > MAX_BYTES) throw new Error('Purpose document exceeds 2 MB. No data was overwritten.')
    await writeJsonAtomicAsync(path.join(directory, `${purpose.id}.json`), purpose)
  }

  async create(workspacePath: string, input: CreatePurposeInput): Promise<Purpose> {
    const planningNotes = input.planningNotes || []
    if (!Array.isArray(planningNotes) || planningNotes.length > 20) throw new Error('Invalid planning notes.')
    const notes = planningNotes.map(content => ({ id: randomUUID(), kind: 'finding' as const, content: purposeText(content, 1500, true), createdAt: Date.now() }))
    return this.exclusive(workspacePath, async directory => {
      const now = Date.now()
      const purpose: Purpose = {
        schemaVersion: 1, id: randomUUID(), revision: 1,
        title: purposeText(input.title, 160, true), objective: purposeText(input.objective, 4000, true), scope: purposeText(input.scope),
        acceptanceCriteria: lines(input.acceptanceCriteria),
        milestones: lines(input.milestones).map(title => ({ id: randomUUID(), title, status: 'pending', evidence: '' })),
        status: 'active', notes, executions: [], handoffs: [],
        history: [{ revision: 1, at: now, kind: 'created', detail: 'Purpose baseline created.' }], createdAt: now, updatedAt: now,
      }
      await this.write(directory, purpose)
      return purpose
    })
  }

  async mutate(workspacePath: string, id: string, revision: number | undefined, kind: string, detail: string, change: (purpose: Purpose) => void): Promise<Purpose> {
    return this.exclusive(workspacePath, async directory => {
      const purpose = await this.read(directory, id)
      if (revision !== undefined && purpose.revision !== revision) throw new Error('Purpose changed. Refresh before saving; your draft has not been applied.')
      change(purpose)
      purpose.revision += 1
      purpose.updatedAt = Date.now()
      purpose.history.push({ revision: purpose.revision, at: purpose.updatedAt, kind, detail })
      await this.write(directory, purpose)
      return purpose
    })
  }

  async update(workspacePath: string, id: string, input: UpdatePurposeInput): Promise<Purpose> {
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error('Provide the current purpose revision.')
    return this.mutate(workspacePath, id, input.revision, 'updated', purposeText(input.reason), purpose => {
      this.validateMilestones(input.milestones)
      const title = purposeText(input.title, 160, true), objective = purposeText(input.objective, 4000, true), scope = purposeText(input.scope)
      const criteria = lines(input.acceptanceCriteria)
      if (!['active', 'paused', 'completed'].includes(input.status)) throw new Error('Invalid purpose status.')
      const baselineChanged = title !== purpose.title || objective !== purpose.objective || scope !== purpose.scope || JSON.stringify(criteria) !== JSON.stringify(purpose.acceptanceCriteria)
      if (baselineChanged || input.status === 'completed') purposeText(input.reason, 4000, true)
      if (input.status === 'completed' && input.milestones.some(item => item.status !== 'completed')) throw new Error('Complete and verify all milestones before accepting the purpose.')
      if (baselineChanged) purpose.notes.push({ id: randomUUID(), kind: 'decision', createdAt: Date.now(), content: `Previous baseline (r${purpose.revision}): ${JSON.stringify({ title: purpose.title, objective: purpose.objective, scope: purpose.scope, acceptanceCriteria: purpose.acceptanceCriteria })}\nChange: ${input.reason}` })
      if (input.milestones.length !== purpose.milestones.length || input.milestones.some((item, index) => item.id !== purpose.milestones[index].id || item.title !== purpose.milestones[index].title)) {
        purposeText(input.reason, 4000, true)
        purpose.notes.push({ id: randomUUID(), kind: 'decision', createdAt: Date.now(), content: `Previous milestone plan (r${purpose.revision}): ${JSON.stringify(purpose.milestones.map(({ id, title, status }) => ({ id, title, status })))}\nChange: ${input.reason}` })
      }
      for (const milestone of input.milestones) {
        const previous = purpose.milestones.find(item => item.id === milestone.id)
        if (previous && (previous.status !== milestone.status || previous.evidence !== milestone.evidence)) purpose.notes.push({
          id: randomUUID(), kind: 'finding', createdAt: Date.now(),
          content: `User-recorded milestone update (r${purpose.revision}): ${milestone.title}\nPrevious: ${JSON.stringify({ status: previous.status, evidence: previous.evidence })}\nCurrent: ${JSON.stringify({ status: milestone.status, evidence: milestone.evidence })}`,
        })
      }
      Object.assign(purpose, { title, objective, scope, acceptanceCriteria: criteria, milestones: input.milestones, status: input.status })
    })
  }
}
