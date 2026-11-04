import { describe, expect, it } from 'vitest'
import { parseSkillMarkdown } from '../../src/main/tools/skill-frontmatter'
import {
  expandSkillCommandArgs,
  parseSkillCommands,
  resolveSkillCommandArguments,
  skillCommandCatalogNote,
  validateRelativeSkillPath,
  DEFAULT_SKILL_COMMAND_TIMEOUT_MS,
  MAX_SKILL_COMMAND_TIMEOUT_MS,
  type SkillCommandDeclaration,
} from '../../src/main/tools/skill-command'

function commandsFrom(frontmatterText: string) {
  const parsed = parseSkillMarkdown(`---\nname: demo\ndescription: Demo.\n${frontmatterText}---\n\nBody.\n`)
  if (!parsed.ok) throw new Error(parsed.error)
  return parseSkillCommands(parsed.frontmatter as Record<string, unknown>)
}

function single(frontmatterText: string): SkillCommandDeclaration {
  const result = commandsFrom(frontmatterText)
  if (!result.ok) throw new Error(result.error)
  expect(result.commands).toHaveLength(1)
  return result.commands[0]
}

describe('run_command declarations', () => {
  it('parses a JSON declaration and its placeholders', () => {
    const command = single('run_command: {"name":"scan","interpreter":"python","entry":"scripts/scan.py","args":["--file","{path}"],"description":"Scan one file."}\n')

    expect(command).toMatchObject({
      name: 'scan',
      interpreter: 'python',
      entry: 'scripts/scan.py',
      args: ['--file', '{path}'],
      placeholders: ['path'],
      approval: 'required',
      timeoutMs: DEFAULT_SKILL_COMMAND_TIMEOUT_MS,
      description: 'Scan one file.',
    })
  })

  it('accepts a JSON array behind the quoted frontmatter value', () => {
    const result = commandsFrom('run_command: "[{\\"name\\":\\"one\\",\\"interpreter\\":\\"node\\",\\"entry\\":\\"a.js\\"},{\\"name\\":\\"two\\",\\"interpreter\\":\\"bash\\",\\"entry\\":\\"b.sh\\"}]"\n')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.commands.map((command) => command.name)).toEqual(['one', 'two'])
  })

  it('accepts a repeated run_command key', () => {
    const result = commandsFrom([
      'run_command: {"name":"one","interpreter":"node","entry":"a.js"}',
      'run_command: {"name":"two","interpreter":"node","entry":"b.js"}',
    ].join('\n') + '\n')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.commands.map((command) => command.name)).toEqual(['one', 'two'])
  })

  it('records an explicit approval opt-out and a custom timeout', () => {
    const command = single('run_command: {"name":"ping","interpreter":"node","entry":"ping.js","approval":"none","timeout_ms":5000}\n')

    expect(command.approval).toBe('none')
    expect(command.timeoutMs).toBe(5000)
  })

  it('caps a declared timeout instead of trusting it', () => {
    const command = single(`run_command: {"name":"slow","interpreter":"node","entry":"slow.js","timeout_ms":${MAX_SKILL_COMMAND_TIMEOUT_MS * 10}}\n`)

    expect(command.timeoutMs).toBe(MAX_SKILL_COMMAND_TIMEOUT_MS)
  })

  it('declares no command for a text-only skill', () => {
    const result = parseSkillCommands({})
    expect(result).toEqual({ ok: true, commands: [] })
  })

  it('deduplicates placeholders while keeping declaration order', () => {
    const command = single('run_command: {"name":"twice","interpreter":"node","entry":"a.js","args":["{b}","{a}","{b}"]}\n')

    expect(command.placeholders).toEqual(['b', 'a'])
  })
})

describe('declaration validation', () => {
  it.each([
    ['run_command: not json\n', 'not valid JSON'],
    ['run_command: {"interpreter":"node","entry":"a.js"}\n', 'must be lower-case letters'],
    ['run_command: {"name":"Bad Name","interpreter":"node","entry":"a.js"}\n', 'must be lower-case letters'],
    ['run_command: {"name":"ok","interpreter":"perl","entry":"a.pl"}\n', 'needs an interpreter'],
    ['run_command: {"name":"ok","interpreter":"node","entry":"/etc/passwd"}\n', 'must be relative to the skill folder'],
    ['run_command: {"name":"ok","interpreter":"node","entry":"../escape.js"}\n', 'must not leave the skill folder'],
    ['run_command: {"name":"ok","interpreter":"node","entry":"https://example.com/a.js"}\n', 'must not be a URL'],
    ['run_command: {"name":"ok","interpreter":"node","entry":"a.js","args":"--flag"}\n', 'args must be a JSON array of strings'],
    ['run_command: {"name":"ok","interpreter":"node","entry":"a.js","args":["{bad"]}\n', 'unbalanced placeholder brace'],
    ['run_command: {"name":"ok","interpreter":"node","entry":"a.js","approval":"maybe"}\n', 'approval must be "required" or "none"'],
    ['run_command: {"name":"ok","interpreter":"node","entry":"a.js","timeout_ms":0}\n', 'timeout_ms must be a positive number'],
  ])('refuses %s', (frontmatter, expected) => {
    const result = commandsFrom(frontmatter)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain(expected)
  })

  it('refuses the same command name twice', () => {
    const result = commandsFrom([
      'run_command: {"name":"same","interpreter":"node","entry":"a.js"}',
      'run_command: {"name":"same","interpreter":"node","entry":"b.js"}',
    ].join('\n') + '\n')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('twice')
  })

  it('refuses a symlink-style entry that is really a drive-relative path', () => {
    expect(validateRelativeSkillPath('C:\\Windows\\System32\\cmd.exe')).toBeDefined()
    expect(validateRelativeSkillPath('scripts//run.py')).toContain('empty or "." segments')
    expect(validateRelativeSkillPath('scripts/run.py')).toBeUndefined()
  })
})

describe('argument checking', () => {
  const command = single('run_command: {"name":"scan","interpreter":"node","entry":"scan.js","args":["--file","{path}"]}\n')

  it('accepts the declared placeholder and expands it into its own argv slot', () => {
    const resolved = resolveSkillCommandArguments(command, { path: 'invoices/march.pdf' })

    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(expandSkillCommandArgs(command, resolved.values)).toEqual(['--file', 'invoices/march.pdf'])
  })

  it('requires every declared placeholder', () => {
    const resolved = resolveSkillCommandArguments(command, {})

    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.error).toContain('needs a value for "path"')
  })

  it('refuses an argument the declaration never named', () => {
    const resolved = resolveSkillCommandArguments(command, { path: 'a.pdf', extra: 'x' })

    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.error).toContain('has no placeholder named "extra"')
  })

  it.each([
    ['a.pdf; rm -rf /', 'shell operator'],
    ['a.pdf && whoami', 'shell operator'],
    ['$(whoami)', 'shell operator'],
    ['--force', 'start with a dash'],
    ['C:\\Windows\\win.ini', 'absolute Windows path'],
    ['../../etc/passwd', 'parent-directory segment'],
    ['line\nbreak', 'line break'],
  ])('refuses %s', (value, expected) => {
    const resolved = resolveSkillCommandArguments(command, { path: value })

    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.error).toContain(expected)
  })

  it('refuses an over-long value', () => {
    const resolved = resolveSkillCommandArguments(command, { path: 'a'.repeat(1001) })

    expect(resolved.ok).toBe(false)
  })

  it('never lets a value become a second argument', () => {
    const resolved = resolveSkillCommandArguments(command, { path: 'a b c' })

    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(expandSkillCommandArgs(command, resolved.values)).toEqual(['--file', 'a b c'])
  })
})

describe('catalog note', () => {
  it('names the runnable commands and stays empty for a text-only skill', () => {
    const command = single('run_command: {"name":"scan","interpreter":"node","entry":"a.js"}\n')

    expect(skillCommandCatalogNote([command])).toBe(' [runs: scan]')
    expect(skillCommandCatalogNote([])).toBe('')
  })
})
