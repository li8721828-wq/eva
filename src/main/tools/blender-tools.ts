import fs from 'fs'
import path from 'path'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { getStorage } from '../storage'
import type { ToolContext, ToolExecutionResult, ToolExecutor } from './index'

const execFileAsync = promisify(execFile)
const MAX_SCRIPT_LENGTH = 256 * 1024
const DEFAULT_TIMEOUT = 300_000
const MAX_TIMEOUT = 600_000
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const REVIEW_VIEW_NAMES = ['front', 'side', 'three-quarter'] as const

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

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
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

async function ensureReferenceImages(referenceImages: unknown, context: ToolContext): Promise<string[]> {
  if (!Array.isArray(referenceImages) || referenceImages.length === 0) {
    throw new Error('At least one reference image is required.')
  }
  if (referenceImages.length > 4) throw new Error('Use at most four reference images for one model.')

  const images: string[] = []
  for (const reference of referenceImages) {
    if (typeof reference !== 'string' || !reference.trim()) throw new Error('Each reference image must be a file path.')
    const resolved = resolvePath(reference.trim(), context)
    if (!IMAGE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      throw new Error(`Reference image must be JPG, PNG, or WebP: ${reference}`)
    }
    const exists = await context.fileService.fileExists(resolved, context.workspacePath, context.fileAccessGrants, context.fullFilesystemAccess)
    if (!exists) throw new Error(`Reference image was not found or is outside the authorized workspace: ${reference}`)
    images.push(resolved)
  }
  return images
}

function ensureOutputPath(outputFile: unknown, context: ToolContext): string {
  if (typeof outputFile !== 'string' || !outputFile.trim()) throw new Error('An output .blend path is required.')
  const outputPath = resolvePath(outputFile.trim(), context)
  if (path.extname(outputPath).toLowerCase() !== '.blend') throw new Error('Output file must use the .blend extension.')
  if (context.fullFilesystemAccess) return outputPath
  const writableRoots = [context.workspacePath, ...(context.fileAccessGrants || []).filter((grant) => grant.access === 'read-write').map((grant) => grant.path)]
  if (!writableRoots.some((root) => root && isWithin(root, outputPath))) {
    throw new Error('Output .blend must be inside the workspace or a read-write authorized folder.')
  }
  return outputPath
}

function ensureReviewDirectory(outputDirectory: unknown, projectPath: string, context: ToolContext): string {
  const fallback = path.join(context.workspacePath, '.eva', 'blender-reviews', `${path.basename(projectPath, '.blend')}-${Date.now()}`)
  const directory = resolvePath(typeof outputDirectory === 'string' && outputDirectory.trim() ? outputDirectory.trim() : fallback, context)
  if (context.fullFilesystemAccess) return directory
  const writableRoots = [context.workspacePath, ...(context.fileAccessGrants || []).filter((grant) => grant.access === 'read-write').map((grant) => grant.path)]
  if (!writableRoots.some((root) => root && isWithin(root, directory))) {
    throw new Error('Review render output must be inside the workspace or a read-write authorized folder.')
  }
  return directory
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

async function renderReview(
  executable: string,
  projectPath: string,
  outputDirectory: string,
  scriptDirectory: string,
  timeout: number,
  resolution: number
): Promise<ToolExecutionResult> {
  await fs.promises.mkdir(outputDirectory, { recursive: true })
  const outputs = REVIEW_VIEW_NAMES.map((view) => path.join(outputDirectory, `review-${view}.png`))
  const scriptPath = path.join(scriptDirectory, `review-${Date.now()}.py`)
  const script = [
    'import bpy',
    'from mathutils import Vector',
    `OUTPUTS = ${JSON.stringify(outputs)}`,
    `RESOLUTION = ${resolution}`,
    'scene = bpy.context.scene',
    'mesh_objects = [obj for obj in scene.objects if obj.type == "MESH" and obj.visible_get()]',
    'if not mesh_objects:',
    '    raise RuntimeError("No visible mesh objects were found to render.")',
    'corners = []',
    'for obj in mesh_objects:',
    '    for corner in obj.bound_box:',
    '        corners.append(obj.matrix_world @ Vector(corner))',
    'minimum = Vector((min(point.x for point in corners), min(point.y for point in corners), min(point.z for point in corners)))',
    'maximum = Vector((max(point.x for point in corners), max(point.y for point in corners), max(point.z for point in corners)))',
    'center = (minimum + maximum) * 0.5',
    'span = maximum - minimum',
    'largest_span = max(span.x, span.y, span.z, 0.5)',
    'camera_object = bpy.data.objects.get("EVA_ReviewCamera")',
    'if camera_object is None or camera_object.type != "CAMERA":',
    '    camera_data = bpy.data.cameras.new("EVA_ReviewCamera")',
    '    camera_object = bpy.data.objects.new("EVA_ReviewCamera", camera_data)',
    '    scene.collection.objects.link(camera_object)',
    'camera_object.data.type = "ORTHO"',
    'camera_object.data.ortho_scale = largest_span * 1.35',
    'def look_at(object, target):',
    '    object.rotation_euler = (target - object.location).to_track_quat("-Z", "Y").to_euler()',
    'distance = largest_span * 2.2',
    'view_positions = [',
    '    center + Vector((0, -distance, largest_span * 0.12)),',
    '    center + Vector((distance, 0, largest_span * 0.12)),',
    '    center + Vector((distance, -distance, largest_span * 0.42)),',
    ']',
    'scene.camera = camera_object',
    'scene.render.engine = "BLENDER_WORKBENCH"',
    'scene.display.shading.light = "STUDIO"',
    'scene.display.shading.color_type = "MATERIAL"',
    'scene.display.shading.background_type = "VIEWPORT"',
    'scene.display.shading.background_color = (0.92, 0.92, 0.92)',
    'scene.display.shading.show_shadows = True',
    'scene.display.shading.show_cavity = True',
    'scene.render.image_settings.file_format = "PNG"',
    'scene.render.resolution_x = RESOLUTION',
    'scene.render.resolution_y = RESOLUTION',
    'scene.render.resolution_percentage = 100',
    'scene.render.film_transparent = False',
    'for index, output in enumerate(OUTPUTS):',
    '    camera_object.location = view_positions[index]',
    '    look_at(camera_object, center)',
    '    scene.render.filepath = output',
    '    bpy.ops.render.render(write_still=True)',
    '    print("EVA_REVIEW_IMAGE=" + output)',
  ].join('\n')
  await fs.promises.writeFile(scriptPath, script, 'utf-8')
  const consoleOutput = await runBlender(executable, projectPath, scriptPath, timeout)

  const images: NonNullable<ToolExecutionResult['images']> = []
  for (const output of outputs) {
    const stat = await fs.promises.stat(output).catch(() => null)
    if (!stat?.isFile() || stat.size === 0) throw new Error(`Blender did not create the expected review render: ${output}`)
    images.push({ path: output, name: path.basename(output), mediaType: 'image/png' })
  }

  return {
    content: `Rendered visual review frames for ${projectPath}: ${outputs.join(', ')}\n${consoleOutput}`,
    images,
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

const blenderModelFromReference: ToolExecutor = {
  definition: {
    name: 'blender_model_from_reference',
    description: 'Create or refine an editable Blender model from one to four user-supplied reference images, save it to a .blend file, then automatically return front, side, and three-quarter render previews for visual comparison. This is reference-guided modeling, not photogrammetric reconstruction.',
    parameters: {
      type: 'object',
      properties: {
        referenceImages: { type: 'array', items: { type: 'string' }, description: 'One to four attached reference image paths.' },
        script: { type: 'string', description: 'Complete bpy script that creates or modifies the model. EVA_REFERENCE_IMAGES is available to the script.' },
        outputFile: { type: 'string', description: 'New .blend output path, relative to the workspace or an authorized folder.' },
        projectFile: { type: 'string', description: 'Optional existing .blend input file. Inspect it before modification.' },
        reviewOutputDirectory: { type: 'string', description: 'Optional folder for automatic review PNG files. Defaults to .eva/blender-reviews in the workspace.' },
        timeout: { type: 'number', description: 'Maximum run time in milliseconds, capped at 600000.' },
      },
      required: ['referenceImages', 'script', 'outputFile'],
    },
  },
  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const script = typeof params.script === 'string' ? params.script : ''
    if (!script.trim()) throw new Error('A bpy modeling script is required.')
    if (Buffer.byteLength(script, 'utf-8') > MAX_SCRIPT_LENGTH) throw new Error('Blender script exceeds the 256 KB limit.')

    const settings = getBlenderSettings()
    const executable = configuredExecutable(settings)
    const referenceImages = await ensureReferenceImages(params.referenceImages, context)
    const outputPath = ensureOutputPath(params.outputFile, context)
    const projectPath = await ensureProjectReadable(params.projectFile, context)
    const directory = configuredScriptDirectory(settings, context)
    await fs.promises.mkdir(directory, { recursive: true })
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true })
    const scriptPath = path.join(directory, `reference-model-${Date.now()}.py`)
    const wrappedScript = [
      'import bpy',
      `EVA_REFERENCE_IMAGES = ${JSON.stringify(referenceImages)}`,
      `EVA_OUTPUT_FILE = ${JSON.stringify(outputPath)}`,
      script,
      'bpy.ops.wm.save_as_mainfile(filepath=EVA_OUTPUT_FILE)',
      'print("EVA_OUTPUT_FILE=" + EVA_OUTPUT_FILE)',
    ].join('\n')
    await fs.promises.writeFile(scriptPath, wrappedScript, 'utf-8')
    const timeout = configuredTimeout(settings, params.timeout)
    const modelOutput = await runBlender(executable, projectPath, scriptPath, timeout)
    const reviewDirectory = ensureReviewDirectory(params.reviewOutputDirectory, outputPath, context)
    const review = await renderReview(executable, outputPath, reviewDirectory, directory, timeout, 512)
    return {
      content: `Saved Blender model to ${outputPath}.\n${modelOutput}\n${review.content}`,
      images: review.images,
    }
  },
}

const blenderRenderReview: ToolExecutor = {
  definition: {
    name: 'blender_render_review',
    description: 'Render front, side, and three-quarter PNG previews of an existing Blender model. The renders are returned to the agent visual context for comparison against the user reference images.',
    parameters: {
      type: 'object',
      properties: {
        projectFile: { type: 'string', description: 'Path to the .blend file to review, relative to the workspace or absolute when authorized.' },
        outputDirectory: { type: 'string', description: 'Optional folder for review PNG files. Defaults to .eva/blender-reviews in the workspace.' },
        resolution: { type: 'number', description: 'Square review render resolution from 256 to 1024. Defaults to 512.' },
        timeout: { type: 'number', description: 'Maximum run time in milliseconds, capped at 600000.' },
      },
      required: ['projectFile'],
    },
  },
  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const settings = getBlenderSettings()
    const executable = configuredExecutable(settings)
    const projectPath = await ensureProjectReadable(params.projectFile, context)
    if (!projectPath) throw new Error('A Blender project file is required for review rendering.')
    const directory = configuredScriptDirectory(settings, context)
    await fs.promises.mkdir(directory, { recursive: true })
    const reviewDirectory = ensureReviewDirectory(params.outputDirectory, projectPath, context)
    const requestedResolution = typeof params.resolution === 'number' ? Math.round(params.resolution) : 512
    const resolution = Math.max(256, Math.min(requestedResolution, 1024))
    return renderReview(executable, projectPath, reviewDirectory, directory, configuredTimeout(settings, params.timeout), resolution)
  },
}

const blenderOpenGui: ToolExecutor = {
  definition: {
    name: 'blender_open_gui',
    description: 'Open an authorized .blend project in the installed Blender graphical interface. Use this after a successful modeling task only when the user asks to view or edit the result in Blender.',
    parameters: {
      type: 'object',
      properties: {
        projectFile: { type: 'string', description: 'The .blend file to open, relative to the workspace or absolute when authorized.' },
      },
      required: ['projectFile'],
    },
  },
  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    const settings = getBlenderSettings()
    const executable = configuredExecutable(settings)
    const projectPath = await ensureProjectReadable(params.projectFile, context)
    if (!projectPath) throw new Error('A Blender project file is required to open the Blender interface.')

    const child = spawn(executable, [projectPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.unref()
    return `Opened Blender GUI for ${projectPath}`
  },
}

export function createBlenderTools(): ToolExecutor[] {
  return [blenderInspectScene, blenderRunScript, blenderModelFromReference, blenderRenderReview, blenderOpenGui]
}
