export type EnvironmentRuleSource = 'detected' | 'learned' | 'user'

export type EnvironmentRuleScope = 'all' | 'win32' | 'darwin' | 'linux'

export interface EnvironmentRule {
  id: string
  title: string
  content: string
  scope: EnvironmentRuleScope
  source: EnvironmentRuleSource
  enabled: boolean
  occurrences: number
  createdAt: number
  updatedAt: number
}

export interface EnvironmentRulesConfig {
  enabled: boolean
  /** Maximum estimated tokens reserved for shared environment instructions. */
  maxTokens: number
  rules: EnvironmentRule[]
}

const createdAt = 0

export const DEFAULT_ENVIRONMENT_RULES: EnvironmentRulesConfig = {
  enabled: true,
  maxTokens: 700,
  rules: [
    {
      id: 'windows-file-tool-paths',
      title: 'Windows file-tool paths',
      content: 'File tools receive filesystem paths, not shell expressions. On Windows use absolute paths with drive letters when a location is known. Eva expands `~`, `~/...`, and `~\\...` to the current user home directory, but `~` is not the desktop. For a desktop-specific request, use the detected desktop path shown below or ask for clarification; do not guess a path.',
      scope: 'win32',
      source: 'detected',
      enabled: true,
      occurrences: 1,
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: 'windows-powershell-syntax',
      title: 'PowerShell environment syntax',
      content: 'For Windows PowerShell commands, set environment variables with `$env:NAME = "value"`; do not use Bash `export NAME=value`. Prefer PowerShell cmdlets or explicit executable commands, and quote paths that contain spaces.',
      scope: 'win32',
      source: 'detected',
      enabled: true,
      occurrences: 1,
      createdAt,
      updatedAt: createdAt,
    },
  ],
}
