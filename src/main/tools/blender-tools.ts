import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getStorage } from '../storage'
import type { ToolContext, ToolExecutor } from './index'

const execFileAsync = promisify(execFile)
const MAX_SCRIPT_LENGTH = 256 * 1024
const DEFAULT_TIMEOUT = 300_000
const MAX_TIMEOUT = 600_000

interface BlenderPluginSettings {
  blenderExecutablePath?: string
  scriptDirectory?: string
  timeoutMs?: number
}

function getBlenderSettings(): BlenderPluginSettings {
  const plugin = getStorage().plugins.get('blender-connector')
  if (!plugin?.enabled) throw new Error('Blender Connector is not installed and enabled.')
  return plugin.settings as BlenderPluginSettings
}

function resolvePath(inputPath: string, context: ToolContext): string {
  return path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.resolve(context.workspacePath, inputPath)
}

function configuredExecutable(settings: BlenderPluginSettings): string {
  const executable = settings.blenderExecutablePath?.trim()
  if (!executable) throw new Error('Configure Blender Connector with the path to blender.exe before running a task.')
  if (!fs.existsSync(executable)) throw new Error(`Configured Blender executable was not found: ${executable}`)
  return executable
}

function configuredScriptDirectory(settings: BlenderPluginSettings, context: ToolContext): string {
  return resolvePath(settings.scriptDirectory?.trim() || '.eva/blender', context)
}

function configuredTimeout(settings: BlenderPluginSettings, requested: unknown): number {
  const fromRequest = typeof requested === 'number' ? requested : undefined
  const fromSettings = typeof settings.timeoutMs === 'number' ? settings.timeoutMs : undefined
  return Math.max(1_000, Math.min(fromRequest ?? fromSettings ?? DEFAULT_TIMEOUT, MAX_TIMEOUT))
}

async function ensureProjectReadable(projectFile: unknown, context: ToolContext): Promise<string | null> {
  if (typeof projectFile !== 'string' || !projectFile.trim()) return null
  const resolved = resolvePath(projectFile.trim(), context)
  const exists = await context.fileService.fileExists(resolved, context.workspacePath, context.fileAccessGrants, context.fullFilesystemAccess)
  if (!exists) throw new Error(`Blender project was not found or is outside the authorized workspace: ${projectFile}`)
  if (!resolved.toLowerCase().endsWith('.blend')) throw new Error('Blender project file must have a .blend extension.')
  return resolved
}

async function runBlender(
  executable: string,
  projectPath: string | null,
  scriptPath: string,
  timeout: number
): Promise<string> {
  const args = [
    ...(projectPath ? [projectPath] : []),
    '--background',
    '--python',
    scriptPath,
  ]
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      windowsHide: true,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    })
    return [stdout.trim(), stderr.trim() ? `[stderr]\n${stderr.trim()}` : ''].filter(Boolean).join('\n') || 'Blender completed without console output.'
  } catch (error) {
    const detail = error as Error & { stdout?: string; stderr?: string; killed?: boolean }
    const parts = [detail.message, detail.stdout?.trim(), detail.stderr?.trim()].filter(Boolean)
    throw new Error(parts.join('\n') || 'Blender execution failed.')
  }
}

const blenderInspectScene: ToolExecutor = {
  definition: {
    name: 'blender_inspect_scene',
    description: 'Inspect a configured Blender .blend project and return its scene, object, camera, and collection summary. Blender Connector must be enabled and configured.',
    parameters: {
      type: 'object',
      properties: { projectFile: { type: 'string', description: 'Path to the .blend file, relative to the workspace or absolute when authorized.' } },
      required: ['projectFile'],
    },
  },
  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    const settings = getBlenderSettings()
    const executable = configuredExecutable(settings)
    const projectPath = await ensureProjectReadable(params.projectFile, context)
    if (!projectPath) throw new Error('A Blender project file is required for scene inspection.')
    const directory = configuredScriptDirectory(settings, context)
    await fs.promises.mkdir(directory, { recursive: true })
    const scriptPath = path.join(directory, `inspect-${Date.now()}.py`)
    const script = [
      'import bpy',
      'scene = bpy.context.scene',
      'print("EVA_SCENE_NAME=" + scene.name)',
      'print("EVA_OBJECTS=" + str(len(scene.objects)))',
      'print("EVA_OBJECT_LIST=" + ", ".join(sorted(obj.name + ":" + obj.type for obj in scene.objects)[:80]))',
      'print("EVA_COLLECTIONS=" + ", ".join(sorted(collection.name for collection in bpy.data.collections)[:40]))',
      'print("EVA_CAMERAS=" + ", ".join(sorted(camera.name for camera in bpy.data.cameras)))',
    ].join('\n')
    await fs.promises.writeFile(scriptPath, script, 'utf-8')
    return runBlender(executable, projectPath, scriptPath, configuredTimeout(settings, params.timeout))
  },
}

const blenderRunScript: ToolExecutor = {
  definition: {
    name: 'blender_run_script',
    description: 'Run a bpy Python script against a Blender project in background mode. Use blender_inspect_scene first when modifying an existing file. Always save output to a new .blend path unless the user explicitly requests overwrite.',
    parameters: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'Complete bpy Python script to execute.' },
        projectFile: { type: 'string', description: 'Optional input .blend file path, relative to the workspace or absolute when authorized.' },
        timeout: { type: 'number', description: 'Maximum run time in milliseconds, capped at 600000.' },
      },
      required: ['script'],
    },
  },
  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    const script = typeof params.script === 'string' ? params.script : ''
    if (!script.trim()) throw new Error('Blender script is required.')
    if (Buffer.byteLength(script, 'utf-8') > MAX_SCRIPT_LENGTH) throw new Error('Blender script exceeds the 256 KB limit.')

    const settings = getBlenderSettings()
    const executable = configuredExecutable(settings)
    const projectPath = await ensureProjectReadable(params.projectFile, context)
    const directory = configuredScriptDirectory(settings, context)
    await fs.promises.mkdir(directory, { recursive: true })
    const scriptPath = path.join(directory, `task-${Date.now()}.py`)
    await fs.promises.writeFile(scriptPath, script, 'utf-8')
    return runBlender(executable, projectPath, scriptPath, configuredTimeout(settings, params.timeout))
  },
}

export function createBlenderTools(): ToolExecutor[] {
  return [blenderInspectScene, blenderRunScript]
}
