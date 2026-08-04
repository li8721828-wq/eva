export interface GitBranchInfo {
  name: string
  current: boolean
  /** A branch already checked out by another conversation/worktree cannot be selected here. */
  checkedOutPath?: string
}

export interface GitRepositoryStatus {
  isRepository: boolean
  repositoryPath?: string
  currentBranch?: string
  branches: GitBranchInfo[]
  message?: string
}
