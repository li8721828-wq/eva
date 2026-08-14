import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import type { CreateRuntimeEvolutionProposal, RuntimeEvolutionProposal, RuntimeProposalStatus } from '../../shared/types/runtime-evolution'

const MAX_PROPOSALS = 500

/** Durable, proposal-only record of suggested runtime evolution. */
export class RuntimeProposalStore {
  private readonly filePath: string
  private writeLock: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'runtime-proposals.json')
  }

  async list(): Promise<RuntimeEvolutionProposal[]> {
    return this.enqueue(() => this.read())
  }

  async create(input: CreateRuntimeEvolutionProposal): Promise<RuntimeEvolutionProposal> {
    return this.enqueue(() => {
      const now = Date.now()
      const proposal: RuntimeEvolutionProposal = { ...input, id: uuidv4(), status: 'draft', createdAt: now, updatedAt: now }
      const proposals = [proposal, ...this.read()].slice(0, MAX_PROPOSALS)
      this.write(proposals)
      return proposal
    })
  }

  async decide(id: string, status: Extract<RuntimeProposalStatus, 'approved' | 'rejected'>, decisionNote?: string): Promise<RuntimeEvolutionProposal> {
    return this.enqueue(() => {
      const proposals = this.read()
      const index = proposals.findIndex((proposal) => proposal.id === id)
      if (index < 0) throw new Error('Runtime evolution proposal not found.')
      if (proposals[index].status !== 'draft') throw new Error('This proposal has already been decided.')
      const proposal: RuntimeEvolutionProposal = { ...proposals[index], status, decisionNote: decisionNote?.trim() || undefined, updatedAt: Date.now() }
      proposals[index] = proposal
      this.write(proposals)
      return proposal
    })
  }

  private read(): RuntimeEvolutionProposal[] {
    try {
      if (!fs.existsSync(this.filePath)) return []
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
      return Array.isArray(data) ? data : []
    } catch {
      return []
    }
  }

  private write(proposals: RuntimeEvolutionProposal[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(proposals, null, 2), 'utf-8')
  }

  private enqueue<T>(work: () => T): Promise<T> {
    const run = async (): Promise<T> => { await this.writeLock; return work() }
    const result = run()
    this.writeLock = result.then(() => undefined, () => undefined)
    return result
  }
}
