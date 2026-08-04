import { app } from 'electron'
import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import { promisify } from 'util'
import type { Conversation } from '../../shared/types/conversation'
import type { GitBranchInfo, GitRepositoryStatus } from '../../shared/types/git'

const execFileAsync = promisify(execFile)

interface WorktreeRecord {
  path: string
  branch?: string
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

export class GitWorktreeService {
  private async git(cwd: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      })
      return stdout.trim()
    } catch (error: any) {
      const message = error?.stderr?.trim() || error?.message || 'Git command failed.'
      throw new Error(message)
    }
  }

  private async repositoryPath(workspacePath: string): Promise<string | null> {
    try {
      const root = await this.git(workspacePath, ['rev-parse', '--show-toplevel'])
      return root || null
    } catch {
      return null
    }
  }

  private async worktrees(repositoryPath: string): Promise<WorktreeRecord[]> {
    const output = await this.git(repositoryPath, ['worktree', 'list', '--porcelain'])
    const records: WorktreeRecord[] = []
    let current: WorktreeRecord | null = null
    for (const line of output.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        current = { path: line.slice('worktree '.length) }
        records.push(current)
      } else if (line.startsWith('branch ') && current) {
        current.branch = line.slice('branch refs/heads/'.length)
      }
    }
    return records
  }

  async status(workspacePath: string, conversation?: Conversation): Promise<GitRepositoryStatus> {
    const repositoryPath = await this.repositoryPath(workspacePath)
    if (!repositoryPath) {
      return {
        isRepository: false,
        branches: [],
        message: 'This conversation workspace is not a Git repository.',
      }
    }

    try {
      const [branchOutput, rootBranch, worktrees] = await Promise.all([
        this.git(repositoryPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
        this.git(repositoryPath, ['branch', '--show-current']),
        this.worktrees(repositoryPath),
      ])
      const selectedWorktree = conversation?.gitWorktreePath || conversation?.workspacePath || repositoryPath
      const selectedBranch = conversation?.gitBranch || worktrees.find((item) => samePath(item.path, selectedWorktree))?.branch || rootBranch
      const branches: GitBranchInfo[] = branchOutput
        .split(/\r?\n/)
        .filter(Boolean)
        .map((name) => {
          const checkedOut = worktrees.find((item) => item.branch === name)
          return {
            name,
            current: name === selectedBranch,
            checkedOutPath: checkedOut && !samePath(checkedOut.path, selectedWorktree) ? checkedOut.path : undefined,
          }
        })
      return { isRepository: true, repositoryPath, currentBranch: selectedBranch, branches }
    } catch (error: any) {
      return { isRepository: false, branches: [], message: error?.message || 'Git status could not be read.' }
    }
  }

  private async assertClean(worktreePath: string): Promise<void> {
    const changes = await this.git(worktreePath, ['status', '--porcelain'])
    if (changes) {
      throw new Error('Commit, stash, or discard changes in this conversation before switching its branch.')
    }
  }

  async switchBranch(
    conversation: Conversation,
    baseWorkspacePath: string,
    branch: string,
  ): Promise<Pick<Conversation, 'workspacePath' | 'gitRepositoryPath' | 'gitBranch' | 'gitWorktreePath'>> {
    const repositoryPath = await this.repositoryPath(conversation.gitRepositoryPath || baseWorkspacePath || conversation.workspacePath)
    if (!repositoryPath) throw new Error('The selected conversation workspace is not a Git repository.')

    const status = await this.status(repositoryPath, conversation)
    if (!status.branches.some((item) => item.name === branch)) {
      throw new Error(`Git branch '${branch}' does not exist in this project.`)
    }
    const rootBranch = await this.git(repositoryPath, ['branch', '--show-current'])
    const currentWorktreePath = conversation.gitWorktreePath || conversation.workspacePath
    const currentIsGeneratedWorktree = Boolean(conversation.gitWorktreePath && !samePath(conversation.gitWorktreePath, repositoryPath))
    const occupied = status.branches.find((item) => item.name === branch)?.checkedOutPath
    if (occupied) {
      throw new Error(`Branch '${branch}' is already open in another conversation: ${occupied}`)
    }

    if (branch === rootBranch) {
      if (currentIsGeneratedWorktree && fs.existsSync(currentWorktreePath)) {
        await this.assertClean(currentWorktreePath)
        await this.git(repositoryPath, ['worktree', 'remove', currentWorktreePath])
      }
      return {
        workspacePath: repositoryPath,
        gitRepositoryPath: repositoryPath,
        gitBranch: branch,
        gitWorktreePath: undefined,
      }
    }

    if (currentIsGeneratedWorktree && fs.existsSync(currentWorktreePath)) {
      await this.assertClean(currentWorktreePath)
      await this.git(currentWorktreePath, ['switch', branch])
      return {
        workspacePath: currentWorktreePath,
        gitRepositoryPath: repositoryPath,
        gitBranch: branch,
        gitWorktreePath: currentWorktreePath,
      }
    }

    const worktreePath = path.join(app.getPath('userData'), 'git-worktrees', conversation.workspaceId || 'external', conversation.id)
    if (fs.existsSync(worktreePath)) {
      throw new Error('The conversation worktree already exists but could not be identified. Reopen the conversation and try again.')
    }
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true })
    await this.git(repositoryPath, ['worktree', 'add', worktreePath, branch])
    return {
      workspacePath: worktreePath,
      gitRepositoryPath: repositoryPath,
      gitBranch: branch,
      gitWorktreePath: worktreePath,
    }
  }
}
