import os from 'os'
import path from 'path'
import { app } from 'electron'
import type { EnvironmentRule, EnvironmentRulesConfig } from '../../shared/types/environment-rules'
import { DEFAULT_ENVIRONMENT_RULES } from '../../shared/types/environment-rules'
import { getStorage } from '../storage'

const MIN_TOKEN_BUDGET = 120
const MAX_TOKEN_BUDGET = 1_200

export function normalizeEnvironmentRules(value: unknown): EnvironmentRulesConfig {
  const candidate = value as Partial<EnvironmentRulesConfig> | undefined
  const maxTokens = Math.max(MIN_TOKEN_BUDGET, Math.min(MAX_TOKEN_BUDGET, Number(candidate?.maxTokens) || DEFAULT_ENVIRONMENT_RULES.maxTokens))
  const normalizedRules: EnvironmentRule[] = Array.isArray(candidate?.rules)
    ? candidate.rules
      .filter((rule): rule is EnvironmentRule => Boolean(rule && typeof rule.id === 'string' && typeof rule.title === 'string' && typeof rule.content === 'string'))
      .map((rule) => ({
        ...rule,
        scope: rule.scope === 'win32' || rule.scope === 'darwin' || rule.scope === 'linux' ? rule.scope : 'all',
        source: rule.source === 'learned' || rule.source === 'user' ? rule.source : 'detected',
        enabled: rule.enabled !== false,
        occurrences: Math.max(1, Number(rule.occurrences) || 1),
        createdAt: Number(rule.createdAt) || Date.now(),
        updatedAt: Number(rule.updatedAt) || Date.now(),
      }))
    : []
  const rules = normalizedRules.length
    ? normalizedRules
    : DEFAULT_ENVIRONMENT_RULES.rules.map((rule) => ({ ...rule }))
  return { enabled: candidate?.enabled !== false, maxTokens, rules }
}

function estimateTokens(text: string): number {
  let cjk = 0
  let ascii = 0
  let symbols = 0
  for (const character of text) {
    const code = character.codePointAt(0) || 0
    if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) cjk += 1
    else if (/[A-Za-z0-9_]/.test(character)) ascii += 1
    else symbols += 1
  }
  return Math.ceil(cjk * 1.15 + ascii / 3.6 + symbols / 2.2)
}

function detectedDesktopPath(): string {
  try {
    return app.getPath('desktop')
  } catch {
    return path.join(os.homedir(), 'Desktop')
  }
}

/** A short, shared prompt segment used by every Agent on this machine. */
export function buildSharedEnvironmentPrompt(config?: EnvironmentRulesConfig): string {
  const rulesConfig = normalizeEnvironmentRules(config)
  if (!rulesConfig.enabled) return ''

  const platform = process.platform
  const systemName = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform
  const facts = [
    `Operating system: ${systemName} (${platform}).`,
    `User home: ${os.homedir()}.`,
    `Desktop directory: ${detectedDesktopPath()}.`,
  ]
  const selected = rulesConfig.rules
    .filter((rule) => rule.enabled && (rule.scope === 'all' || rule.scope === platform))
    .sort((left, right) => right.updatedAt - left.updatedAt)

  const lines = ['--- Shared Runtime Environment ---', ...facts]
  for (const rule of selected) {
    const candidate = `- ${rule.title}: ${rule.content}`
    if (estimateTokens([...lines, candidate].join('\n')) > rulesConfig.maxTokens) break
    lines.push(candidate)
  }
  return lines.join('\n')
}

function saveLearnedRule(rule: Omit<EnvironmentRule, 'createdAt' | 'updatedAt' | 'occurrences'>): void {
  try {
    const storage = getStorage()
    const config = normalizeEnvironmentRules(storage.config.get('environmentRules'))
    const now = Date.now()
    const existing = config.rules.find((item) => item.id === rule.id)
    if (existing) {
      existing.occurrences += 1
      existing.updatedAt = now
    } else {
      config.rules.push({ ...rule, occurrences: 1, createdAt: now, updatedAt: now })
    }
    storage.config.set('environmentRules', config)
  } catch {
    // ContextManager is also used by isolated tests before application storage exists.
  }
}

/** Store only high-confidence, portable observations, never raw model/tool output. */
export function learnEnvironmentRuleFromFailure(toolName: string, args: Record<string, unknown>, result: string): void {
  if (process.platform === 'win32' && toolName === 'list_directory' && String(args.path || '') === '~' && /ENOENT|no such file/i.test(result)) {
    saveLearnedRule({
      id: 'windows-file-tool-home-expansion',
      title: 'Home-directory expansion',
      content: 'When a file tool receives `~`, Eva expands it to the Windows user home directory before access checks. Do not use `~` as a synonym for the desktop.',
      scope: 'win32',
      source: 'learned',
      enabled: true,
    })
  }
  if (process.platform === 'win32' && toolName === 'execute_command' && /CommandNotFoundException/i.test(result) && /\bexport\b/i.test(String(args.command || ''))) {
    saveLearnedRule({
      id: 'windows-powershell-environment-variable',
      title: 'PowerShell environment variables',
      content: 'In Windows PowerShell, use `$env:NAME = "value"` rather than Bash `export NAME=value`.',
      scope: 'win32',
      source: 'learned',
      enabled: true,
    })
  }
}
