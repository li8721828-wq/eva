import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  userDataDir: '',
  disabled: [] as string[],
}))

vi.mock('electron', () => ({
  app: { getPath: () => state.userDataDir },
}))

vi.mock('../../src/main/storage', () => ({
  getStorage: () => ({ skills: { listDisabled: () => state.disabled } }),
}))

import type { ToolContext } from '../../src/main/tools'
import { createSkillTools } from '../../src/main/tools/skill-tools'
import { invalidateSkillCache, loadSkill, runSkillCommand, scanSkillInventory } from '../../src/main/services/skill-service'
import { closeSandboxScope, openSandboxScope, resetSandboxScopes } from '../../src/main/services/sandbox/scope'
import { initializeSandbox } from '../../src/main/services/sandbox'
import type { SandboxContext } from '../../src/main/services/sandbox/types'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function nodeAvailable(): boolean {
  return spawnSync(process.execPath, ['-e', 'process.exit(0)'], { timeout: 10_000 }).status === 0
}
const HAS_NODE = nodeAvailable()

/**
 * Write a skill folder. `declaration` is the raw run_command JSON, or nothing
 * for a text-only skill. `scripts` maps a relative path to file content.
 */
function writeSkill(
  skillsRoot: string,
  name: string,
  options: { description?: string; body?: string; declaration?: string; scripts?: Record<string, string> } = {},
): string {
  const dir = path.join(skillsRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  const lines = [
    '---',
    `name: ${name}`,
    `description: ${options.description ?? 'Test skill.'}`,
  ]
  if (options.declaration) lines.push(`run_command: ${options.declaration}`)
  lines.push('---', '', options.body ?? 'Do the work.', '')
  fs.writeFileSync(path.join(dir, 'SKILL.md'), lines.join('\n'), 'utf8')
  for (const [relative, content] of Object.entries(options.scripts ?? {})) {
    const target = path.join(dir, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content, 'utf8')
  }
  return dir
}

/** Interpreter value that this machine can actually start for a node script. */
function nodeEntry(): { declaration: string; scripts: Record<string, string> } {
  return {
    declaration: '{"name":"report","interpreter":"node","entry":"scripts/report.js","args":["{subject}"]}',
    scripts: {
      'scripts/report.js': [
        'const subject = process.argv[2] ?? "";',
        'console.log(`report for ${subject}`);',
        'console.error(`run dir is ${__dirname}`);',
      ].join('\n'),
    },
  }
}

beforeEach(() => {
  state.userDataDir = makeTempDir('eva-skill-run-global-')
  state.disabled = []
  invalidateSkillCache()
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  invalidateSkillCache()
})

describe('discovery of a programmatic skill', () => {
  it('lists a skill whose declared entry point exists', () => {
    const workspace = makeTempDir('eva-skill-run-ws-')
    const entry = nodeEntry()
    writeSkill(path.join(workspace, '.eva', 'skills'), 'reporter', { declaration: entry.declaration, scripts: entry.scripts })

    const skill = scanSkillInventory(workspace).skills.find((candidate) => candidate.name === 'reporter')

    expect(skill?.commands).toEqual([
      expect.objectContaining({ name: 'report', interpreter: 'node', entry: 'scripts/report.js', placeholders: ['subject'], approval: 'required' }),
    ])
  })

  it('reports a diagnostic instead of offering a command whose entry point is missing', () => {
    const workspace = makeTempDir('eva-skill-run-ws-')
    writeSkill(path.join(workspace, '.eva', 'skills'), 'dangling', {
      declaration: '{"name":"report","interpreter":"node","entry":"scripts/missing.js"}',
    })

    const inventory = scanSkillInventory(workspace)

    expect(inventory.skills.map((skill) => skill.name)).not.toContain('dangling')
    expect(inventory.diagnostics.find((diagnostic) => diagnostic.name === 'dangling')?.reason).toContain('is missing from this skill folder')
  })

  it('reports a diagnostic when the declared entry is a directory', () => {
    const workspace = makeTempDir('eva-skill-run-ws-')
    const dir = writeSkill(path.join(workspace, '.eva', 'skills'), 'folder-entry', {
      declaration: '{"name":"report","interpreter":"node","entry":"scripts"}',
    })
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })

    const inventory = scanSkillInventory(workspace)

    expect(inventory.skills.map((skill) => skill.name)).not.toContain('folder-entry')
    expect(inventory.diagnostics.find((diagnostic) => diagnostic.name === 'folder-entry')?.reason).toContain('is not a file')
  })

  it('reports a diagnostic when the entry is a binary', () => {
    const workspace = makeTempDir('eva-skill-run-ws-')
    const scripts = { 'scripts/blob.js': 'nope' }
    const dir = writeSkill(path.join(workspace, '.eva', 'skills'), 'binary-entry', {
      declaration: '{"name":"report","interpreter":"node","entry":"scripts/blob.js"}',
      scripts,
    })
    fs.writeFileSync(path.join(dir, 'scripts', 'blob.js'), Buffer.from([1, 2, 0, 4]))

    const inventory = scanSkillInventory(workspace)

    expect(inventory.skills.map((skill) => skill.name)).not.toContain('binary-entry')
    expect(inventory.diagnostics.find((diagnostic) => diagnostic.name === 'binary-entry')?.reason).toContain('not a text script')
  })

  it('refuses an entry that leaves the skill folder through a link', () => {
    const workspace = makeTempDir('eva-skill-run-ws-')
    const outside = path.join(makeTempDir('eva-skill-run-outside-'), 'evil.js')
    fs.writeFileSync(outside, 'console.log("pwned")\n', 'utf8')
    const dir = writeSkill(path.join(workspace, '.eva', 'skills'), 'linked', {
      declaration: '{"name":"report","interpreter":"node","entry":"scripts/evil.js"}',
    })
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
    try {
      fs.symlinkSync(outside, path.join(dir, 'scripts', 'evil.js'))
    } catch {
      // Creating a link needs a privilege on some Windows setups; the guard is
      // still exercised by the path-shape tests above.
      return
    }

    const inventory = scanSkillInventory(workspace)

    expect(inventory.skills.map((skill) => skill.name)).not.toContain('linked')
    expect(inventory.diagnostics.find((diagnostic) => diagnostic.name === 'linked')?.reason).toContain('outside the skill folder')
  })

  it('keeps a text-only skill unchanged and says it declares nothing to run', async () => {
    const workspace = makeTempDir('eva-skill-run-ws-')
    writeSkill(path.join(workspace, '.eva', 'skills'), 'text-only')

    expect(scanSkillInventory(workspace).skills.find((skill) => skill.name === 'text-only')?.commands).toEqual([])
    await expect(loadSkill(workspace, 'text-only')).resolves.toContain('This skill is instructions only; nothing in this folder can be executed.')
  })

  it('describes the declared commands in the loaded skill', async () => {
    const workspace = makeTempDir('eva-skill-run-ws-')
    const entry = nodeEntry()
    writeSkill(path.join(workspace, '.eva', 'skills'), 'reporter', { declaration: entry.declaration, scripts: entry.scripts })

    const loaded = await loadSkill(workspace, 'reporter')

    expect(loaded).toContain('Declared commands (run one with run_skill_command using this skill name):')
    expect(loaded).toContain('- report (node scripts/report.js)')
    expect(loaded).toContain('arguments: {subject}')
    expect(loaded).toContain('approval: required')
  })
})

describe('running a declared command', () => {
  it('runs the entry point and returns its output', async () => {
    if (!HAS_NODE) return
    const workspace = makeTempDir('eva-skill-run-ws-')
    const entry = nodeEntry()
    writeSkill(path.join(workspace, '.eva', 'skills'), 'reporter', { declaration: entry.declaration, scripts: entry.scripts })

    const result = await runSkillCommand({ workspacePath: workspace, name: 'reporter', command: 'report', arguments: { subject: 'march' } })

    expect(result.exitCode).toBe(0)
    expect(result.content).toContain('command "report" succeeded')
    expect(result.content).toContain('report for march')
  })

  it('runs from a disposable copy, so the run cannot rewrite the skill', async () => {
    if (!HAS_NODE) return
    const workspace = makeTempDir('eva-skill-run-ws-')
    const original = 'console.log(process.cwd());require("fs").writeFileSync(__filename,"console.log(1)")\n'
    writeSkill(path.join(workspace, '.eva', 'skills'), 'self-edit', {
      declaration: '{"name":"rewrite","interpreter":"node","entry":"scripts/rewrite.js"}',
      scripts: { 'scripts/rewrite.js': original },
    })

    const result = await runSkillCommand({ workspacePath: workspace, name: 'self-edit', command: 'rewrite' })

    expect(result.exitCode).toBe(0)
    expect(fs.readFileSync(path.join(workspace, '.eva', 'skills', 'self-edit', 'scripts', 'rewrite.js'), 'utf8')).toBe(original)
  })

  it('reports a failing exit code without throwing', async () => {
    if (!HAS_NODE) return
    const workspace = makeTempDir('eva-skill-run-ws-')
    writeSkill(path.join(workspace, '.eva', 'skills'), 'failer', {
      declaration: '{"name":"fail","interpreter":"node","entry":"scripts/fail.js"}',
      scripts: { 'scripts/fail.js': 'console.error("boom");process.exit(3)\n' },
    })

    const result = await runSkillCommand({ workspacePath: workspace, name: 'failer', command: 'fail' })

    expect(result.exitCode).toBe(3)
    expect(result.content).toContain('command "fail" failed')
    expect(result.content).toContain('boom')
  })

  it('stops a command that runs past its declared timeout', async () => {
    if (!HAS_NODE) return
    const workspace = makeTempDir('eva-skill-run-ws-')
    writeSkill(path.join(workspace, '.eva', 'skills'), 'slower', {
      declaration: '{"name":"sleep","interpreter":"node","entry":"scripts/sleep.js","timeout_ms":300}',
      scripts: { 'scripts/sleep.js': 'setTimeout(() => console.log("late"), 30_000)\n' },
    })

    const result = await runSkillCommand({ workspacePath: workspace, name: 'slower', command: 'sleep' })

    expect(result.timedOut).toBe(true)
    expect(result.content).toContain('timed out')
  })

  it('refuses a command the skill never declared', async () => {
    const workspace = makeTempDir('eva-skill-run-ws-')
    const entry = nodeEntry()
    writeSkill(path.join(workspace, '.eva', 'skills'), 'reporter', { declaration: entry.declaration, scripts: entry.scripts })

    await expect(runSkillCommand({ workspacePath: workspace, name: 'reporter', command: 'delete-everything' }))
      .rejects.toThrow('does not declare a command "delete-everything". Declared commands: report.')
  })

  it('refuses a text-only skill with a clear reason', async () => {
    const workspace = makeTempDir('eva-skill-run-ws-')
    writeSkill(path.join(workspace, '.eva', 'skills'), 'text-only')

    await expect(runSkillCommand({ workspacePath: workspace, name: 'text-only', command: 'anything' }))
      .rejects.toThrow('instructions only and declares no command to run')
  })

  it('refuses a skill the user turned off', async () => {
    const workspace = makeTempDir('eva-skill-run-ws-')
    const entry = nodeEntry()
    writeSkill(path.join(workspace, '.eva', 'skills'), 'reporter', { declaration: entry.declaration, scripts: entry.scripts })
    state.disabled = ['reporter']
    invalidateSkillCache()

    await expect(runSkillCommand({ workspacePath: workspace, name: 'reporter', command: 'report', arguments: { subject: 'x' } }))
      .rejects.toThrow('is turned off')
  })

  it('refuses arguments that were never declared, before spawning anything', async () => {
    const workspace = makeTempDir('eva-skill-run-ws-')
    const entry = nodeEntry()
    writeSkill(path.join(workspace, '.eva', 'skills'), 'reporter', { declaration: entry.declaration, scripts: entry.scripts })

    await expect(runSkillCommand({ workspacePath: workspace, name: 'reporter', command: 'report', arguments: { subject: 'x', shell: 'rm -rf /' } }))
      .rejects.toThrow('has no placeholder named "shell"')
  })
})

describe('the sandbox boundary around a skill command', () => {
  /**
   * `off` and `permissive` pass the catastrophic-command deny list; `strict`
   * additionally holds the path shapes. All three are real backends, so this
   * exercises the same code a terminal command goes through.
   */
  function scopeContext(workspacePath: string, level: SandboxContext['level']): SandboxContext {
    return { workspacePath, fileAccessGrants: [], extraAllowedPaths: [], allowNetwork: false, level }
  }

  afterEach(() => resetSandboxScopes())

  it('runs a machine-wide skill while the agent sandbox is strict', async () => {
    if (!HAS_NODE) return
    const workspace = makeTempDir('eva-skill-run-ws-')
    const entry = nodeEntry()
    // A global skill sits outside the workspace on purpose.
    writeSkill(path.join(state.userDataDir, 'skills'), 'global-reporter', { declaration: entry.declaration, scripts: entry.scripts })
    const token = openSandboxScope(scopeContext(workspace, 'strict'))
    try {
      const result = await runSkillCommand({ workspacePath: workspace, name: 'global-reporter', command: 'report', arguments: { subject: 'sandbox' } })
      expect(result.exitCode).toBe(0)
      expect(result.content).toContain('report for sandbox')
    } finally {
      closeSandboxScope(token)
    }
  })

  it('refuses a command the sandbox deny list rejects', async () => {
    const workspace = makeTempDir('eva-skill-run-ws-')
    // The deny list matches `rm -rf /`, so the model-supplied argument is what
    // carries it into the sandbox decision. The declaration itself is clean.
    writeSkill(path.join(workspace, '.eva', 'skills'), 'destructive', {
      declaration: '{"name":"nuke","interpreter":"bash","entry":"scripts/nuke.sh","args":["--target","{path}"]}',
      scripts: { 'scripts/nuke.sh': 'echo nuking\n' },
    })
    const token = openSandboxScope(scopeContext(workspace, 'permissive'))
    try {
      await expect(runSkillCommand({ workspacePath: workspace, name: 'destructive', command: 'nuke', arguments: { path: 'a; rm -rf /' } }))
        .rejects.toThrow('shell operator')
    } finally {
      closeSandboxScope(token)
    }
  })

  it('refuses a declared command that the sandbox deny list rejects, before spawning', async () => {
    // Until a backend is probed the dispatcher is a permissive noop, which has no
    // deny list to test. Probing installs the platform backend.
    await initializeSandbox()
    const workspace = makeTempDir('eva-skill-run-ws-')
    writeSkill(path.join(workspace, '.eva', 'skills'), 'shutdown-skill', {
      declaration: '{"name":"down","interpreter":"bash","entry":"scripts/down.sh","args":["shutdown /s"]}',
      scripts: { 'scripts/down.sh': 'echo down\n' },
    })
    const token = openSandboxScope(scopeContext(workspace, 'strict'))
    try {
      const started = Date.now()
      await expect(runSkillCommand({ workspacePath: workspace, name: 'shutdown-skill', command: 'down' }))
        .rejects.toThrow('refused this skill command')
      // A spawn attempt plus interpreter probing would take longer than this.
      expect(Date.now() - started).toBeLessThan(2000)
    } finally {
      closeSandboxScope(token)
    }
  })

  it('does not treat the skill folder as an escape hatch for model arguments', async () => {
    const workspace = makeTempDir('eva-skill-run-ws-')
    writeSkill(path.join(workspace, '.eva', 'skills'), 'escaper', {
      declaration: '{"name":"escape","interpreter":"bash","entry":"scripts/escape.sh","args":["--target","{target}"]}',
      scripts: { 'scripts/escape.sh': 'echo escaping\n' },
    })
    // The absolute Windows path is refused by the argument rules before it can
    // reach the sandbox's allow-list check.
    await expect(runSkillCommand({ workspacePath: workspace, name: 'escaper', command: 'escape', arguments: { target: 'C:/Windows/System32/config' } }))
      .rejects.toThrow('look like an absolute Windows path')
  })
})

describe('the run_skill_command tool', () => {
  const tool = createSkillTools().find((candidate) => candidate.definition.name === 'run_skill_command')!

  function toolContext(workspacePath: string): ToolContext {
    return { workspacePath } as unknown as ToolContext
  }

  it('takes a skill name and a command name, with arguments and timeout optional', () => {
    expect(tool.definition.name).toBe('run_skill_command')
    expect(Object.keys(tool.definition.parameters.properties)).toEqual(['name', 'command', 'arguments', 'timeout_ms'])
    expect(tool.definition.parameters.required).toEqual(['name', 'command'])
  })

  it('runs a declared command through the tool', async () => {
    if (!HAS_NODE) return
    const workspace = makeTempDir('eva-skill-run-ws-')
    const entry = nodeEntry()
    writeSkill(path.join(workspace, '.eva', 'skills'), 'reporter', { declaration: entry.declaration, scripts: entry.scripts })

    const result = await tool.execute({ name: 'reporter', command: 'report', arguments: { subject: 'april' } }, toolContext(workspace))

    expect(result).toContain('report for april')
  })

  it('requires both the skill name and the command name', async () => {
    const workspace = makeTempDir('eva-skill-run-ws-')

    await expect(tool.execute({ command: 'report' }, toolContext(workspace))).rejects.toThrow('name is required')
    await expect(tool.execute({ name: 'reporter' }, toolContext(workspace))).rejects.toThrow('command is required')
  })

  it('refuses to run a skill whose entry point was swapped for something outside the folder', async () => {
    const workspace = makeTempDir('eva-skill-run-ws-')
    const dir = writeSkill(path.join(workspace, '.eva', 'skills'), 'swapped', {
      declaration: '{"name":"report","interpreter":"node","entry":"scripts/report.js"}',
      scripts: { 'scripts/report.js': 'console.log("safe")\n' },
    })
    expect(scanSkillInventory(workspace).skills.map((skill) => skill.name)).toContain('swapped')

    // Replace the script with a link after discovery, then run.
    fs.rmSync(path.join(dir, 'scripts', 'report.js'))
    const outside = path.join(makeTempDir('eva-skill-run-outside-'), 'evil.js')
    fs.writeFileSync(outside, 'console.log("pwned")\n', 'utf8')
    try {
      fs.symlinkSync(outside, path.join(dir, 'scripts', 'report.js'))
    } catch {
      return
    }

    await expect(tool.execute({ name: 'swapped', command: 'report', arguments: {} }, toolContext(workspace)))
      .rejects.toThrow('outside the skill folder')
  })
})
