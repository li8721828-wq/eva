import { app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import type { RequirementRun } from '../../shared/types/requirement-engineering'
import { writeJsonAtomicAsync, writeTextAtomicAsync } from '../storage/atomic-file'

/** Filesystem persistence for Requirement Engineering runs, isolated from orchestration and LLM policy. */
export class RequirementRunRepository {
  constructor(private readonly userDataPath = () => app.getPath('userData')) {}

  root(): string {
    return path.join(this.userDataPath(), 'requirement-engineering', 'runs')
  }

  directory(runId: string): string {
    return path.join(this.root(), runId)
  }

  async listIds(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.root(), { withFileTypes: true })
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return []
    }
  }

  async writeManifest(run: RequirementRun): Promise<void> {
    await writeJsonAtomicAsync(path.join(this.directory(run.id), 'manifest.json'), run)
  }

  async readManifest(runId: string): Promise<RequirementRun | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.directory(runId), 'manifest.json'), 'utf8')) as RequirementRun
    } catch {
      return null
    }
  }

  async writeDocument(runId: string, fileName: string, content: string): Promise<string> {
    const filePath = path.join(this.directory(runId), fileName)
    await writeTextAtomicAsync(filePath, content)
    return filePath
  }
}
