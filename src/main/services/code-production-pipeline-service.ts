import { createHash, randomUUID } from 'crypto'
import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import type {
  ApplyCodeProductionRunInput,
  CodeProductionPluginStatus,
  CodeProductionRun,
  CodeProductionWorkspace,
  StartCodeProductionRunInput,
} from '../../shared/types/code-production-pipeline'
import { getStorage } from '../storage'
import { recordActivity } from './activity-log'

const PLUGIN_ID = 'code-production-pipeline'
const MAX_OUTPUT = 65_536
const RUN_TIMEOUT_MS = 15 * 60 * 1000

interface PipelineContext {
  allowedRoot: string
  pipelineRoot: string
  repositoryRoot: string
  runnerPath: string
  fingerprint: string
}

interface ActiveRun {
  child: ChildProcess
  timer: NodeJS.Timeout
  workspaceId: string
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function canonicalize(candidate: string): Promise<string> {
  let current = path.resolve(candidate)
  const missing: string[] = []
  while (true) {
    try {
      return path.join(await fs.realpath(current), ...missing)
    } catch (error: any) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      missing.unshift(path.basename(current))
      current = parent
    }
  }
}

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex')
}

function yamlScalar(source: string, key: string): string | undefined {
  const match = source.match(new RegExp(`^\\s*(?:-\\s*)?${key}:\\s*["']?([^\\n"']+)["']?\\s*$`, 'm'))
  return match?.[1]?.trim()
}

function appendOutput(current: string, next: string): string {
  const combined = `${current}${next}`
  return combined.length <= MAX_OUTPUT ? combined : combined.slice(-MAX_OUTPUT)
}

function redactOutput(value: string): string {
  return value.replace(/(PIPELINE_DELIVERY_APPROVAL_KEY\\s*[=:]\\s*)\\S+/gi, '$1[redacted]')
}

export class CodeProductionPipelineService {
  private readonly runs = new Map<string, CodeProductionRun>()
  private readonly activeRuns = new Map<string, ActiveRun>()
  private fingerprint?: string

  async status(): Promise<CodeProductionPluginStatus> {
    const plugin = getStorage().plugins.get(PLUGIN_ID)
    if (!plugin) return { configured: false, enabled: false, message: '请在“设置 > 插件”中安装代码生成管线。' }
    if (!plugin.enabled) return { configured: false, enabled: false, message: '请在“设置 > 插件”中启用代码生成管线。' }
    try {
      const context = await this.context()
      return { configured: true, enabled: true, message: '就绪', allowedProjectRoot: context.allowedRoot, pipelineRoot: context.pipelineRoot, fingerprint: context.fingerprint }
    } catch (error) {
      return { configured: false, enabled: true, message: error instanceof Error ? error.message : '管线配置无效。' }
    }
  }

  async workspaces(): Promise<CodeProductionWorkspace[]> {
    const context = await this.context()
    await this.assertStable(context)
    const registryPath = path.join(context.pipelineRoot, 'runtime', 'workspaces.yaml')
    const registry = await fs.readFile(registryPath, 'utf-8')
    const workspaces: CodeProductionWorkspace[] = []
    const blocks = registry.split(/(?=^\s*-\s+id:\s*)/m).slice(1)
    for (const block of blocks) {
      const id = yamlScalar(block, 'id')
      const label = yamlScalar(block, 'label')
      const kind = yamlScalar(block, 'kind')
      const config = yamlScalar(block, 'pipeline_config')
      if (!id || !config) continue
      const configPath = await canonicalize(path.join(context.repositoryRoot, config))
      if (!isWithin(configPath, context.allowedRoot)) continue
      const production = await this.isProductionWorkspace(configPath, context)
      workspaces.push({ id, label: label || id, kind: kind || 'workspace', configPath, production })
    }
    return workspaces
  }

  listRuns(): CodeProductionRun[] {
    return [...this.runs.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt))
  }

  async getDraftsDirectory(): Promise<string> {
    const context = await this.context()
    await this.assertStable(context)
    const draftsDirectory = path.join(context.pipelineRoot, 'drafts')
    await this.assertWithinAllowed(draftsDirectory, context.allowedRoot, '管线草稿目录')
    await fs.mkdir(draftsDirectory, { recursive: true })
    return draftsDirectory
  }

  async start(input: StartCodeProductionRunInput): Promise<CodeProductionRun> {
    const context = await this.context()
    await this.assertStable(context)
    if (this.activeRuns.has(input.workspaceId)) throw new Error('此工作区已有正在运行的管线任务。')
    const workspace = (await this.workspaces()).find((item) => item.id === input.workspaceId)
    if (!workspace) throw new Error('工作区未注册在锁定的管线清单中。')
    if (workspace.production && input.execute && !input.verificationWorktree) {
      throw new Error('生产执行必须提供隔离验证工作树。')
    }
    if (input.verificationWorktree) await this.assertWithinAllowed(input.verificationWorktree, context.allowedRoot, '隔离验证工作树')

    const id = `eva-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
    const outputDirectory = path.join(context.pipelineRoot, 'runs', id)
    await this.assertWithinAllowed(outputDirectory, context.allowedRoot, '运行输出目录')
    const run: CodeProductionRun = {
      id,
      workspaceId: workspace.id,
      workspaceLabel: workspace.label,
      status: 'running',
      mode: input.execute ? 'execute' : 'validate',
      outputDirectory,
      startedAt: new Date().toISOString(),
      stdout: '',
      stderr: '',
    }
    this.runs.set(id, run)
    await recordActivity({ category: 'terminal', action: 'code-production.started', status: 'info', summary: `已为 ${workspace.label} 启动${input.execute ? '执行' : '验证'}。` })

    const args = [context.runnerPath, '--workspace', workspace.configPath, '--output', outputDirectory]
    if (input.verificationWorktree) args.push('--verification-worktree', await canonicalize(input.verificationWorktree))
    if (input.execute) args.push('--execute')
    const child = spawn('python', args, { cwd: context.repositoryRoot, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } })
    const finish = (status: CodeProductionRun['status'], error?: string) => {
      const current = this.runs.get(id)
      if (!current || current.status !== 'running') return
      current.status = status
      current.completedAt = new Date().toISOString()
      current.error = error
      const active = this.activeRuns.get(input.workspaceId)
      if (active) clearTimeout(active.timer)
      this.activeRuns.delete(input.workspaceId)
      void this.attachArtifacts(current, context)
      void recordActivity({ category: 'terminal', action: `code-production.${status}`, status: status === 'completed' ? 'success' : 'error', summary: `${workspace.label}：${status}${error ? `（${error}）` : ''}。` })
    }
    child.stdout?.on('data', (chunk: Buffer) => { run.stdout = appendOutput(run.stdout, redactOutput(chunk.toString('utf-8'))) })
    child.stderr?.on('data', (chunk: Buffer) => { run.stderr = appendOutput(run.stderr, redactOutput(chunk.toString('utf-8'))) })
    child.on('error', (error) => finish('failed', error.message))
    child.on('close', (code) => finish(code === 0 ? 'completed' : 'failed', code === 0 ? undefined : `管线以退出码 ${code ?? '未知'} 结束。`))
    const timer = setTimeout(() => {
      void this.stopProcess(child)
      finish('failed', `管线在 ${RUN_TIMEOUT_MS / 60_000} 分钟后超时。`)
    }, RUN_TIMEOUT_MS)
    this.activeRuns.set(input.workspaceId, { child, timer, workspaceId: input.workspaceId })
    return run
  }

  async cancel(runId: string): Promise<CodeProductionRun> {
    const run = this.runs.get(runId)
    if (!run) throw new Error('未找到管线运行记录。')
    if (run.status !== 'running') return run
    const active = this.activeRuns.get(run.workspaceId)
    if (active) {
      clearTimeout(active.timer)
      await this.stopProcess(active.child)
      this.activeRuns.delete(run.workspaceId)
    }
    run.status = 'cancelled'
    run.completedAt = new Date().toISOString()
    run.error = '已由用户取消。'
    await recordActivity({ category: 'terminal', action: 'code-production.cancelled', status: 'info', summary: `已取消 ${run.workspaceLabel}。` })
    return run
  }

  async apply(input: ApplyCodeProductionRunInput): Promise<CodeProductionRun> {
    const context = await this.context()
    await this.assertStable(context)
    const run = this.runs.get(input.runId)
    if (!run?.deliveryPlanPath || run.status !== 'completed' || run.mode !== 'execute') throw new Error('只有生成了交付计划的已完成执行才能应用。')
    if (input.confirmation !== `APPLY ${run.id}`) throw new Error('确认文本与本次管线运行不匹配。')
    if (!input.operatorIdentity.trim() || !input.approvalReference.trim()) throw new Error('必须填写操作人身份和审批引用。')
    const approvalFile = await this.assertWithinAllowed(input.approvalFile, context.allowedRoot, '审批记录')
    const approval = await fs.readFile(approvalFile, 'utf-8')
    if (yamlScalar(approval, 'authorized_by') !== input.operatorIdentity.trim()) throw new Error('审批记录中的 authorized_by 与操作人身份不一致。')
    const reference = yamlScalar(approval, 'approval_reference') || yamlScalar(approval, 'approval_id')
    if (reference !== input.approvalReference.trim()) throw new Error('审批记录与填写的审批引用不一致。')
    const journalPath = path.join(run.outputDirectory, 'delivery-journal.yaml')
    const args = [
      path.join(context.pipelineRoot, 'delivery', 'apply_delivery_plan.py'),
      '--plan', run.deliveryPlanPath,
      '--approval', approvalFile,
      '--repo', context.repositoryRoot,
      '--journal', journalPath,
      '--apply',
    ]
    run.status = 'running'
    run.mode = 'apply'
    run.stdout = ''
    run.stderr = ''
    run.error = undefined
    const child = spawn('python', args, { cwd: context.repositoryRoot, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } })
    await recordActivity({ category: 'terminal', action: 'code-production.apply_started', status: 'info', summary: `已为 ${run.workspaceLabel} 启动受控应用（${input.approvalReference.trim()}）。` })
    return await new Promise<CodeProductionRun>((resolve) => {
      const finish = (status: CodeProductionRun['status'], error?: string) => {
        if (run.status !== 'running') return
        run.status = status
        run.completedAt = new Date().toISOString()
        run.error = error
        run.journalPath = journalPath
        void recordActivity({ category: 'terminal', action: `code-production.apply_${status}`, status: status === 'completed' ? 'success' : 'error', summary: `${run.workspaceLabel}：受控应用${status}。` })
        resolve(run)
      }
      child.stdout?.on('data', (chunk: Buffer) => { run.stdout = appendOutput(run.stdout, redactOutput(chunk.toString('utf-8'))) })
      child.stderr?.on('data', (chunk: Buffer) => { run.stderr = appendOutput(run.stderr, redactOutput(chunk.toString('utf-8'))) })
      child.on('error', (error) => finish('failed', error.message))
      child.on('close', (code) => finish(code === 0 ? 'completed' : 'failed', code === 0 ? undefined : `受控应用以退出码 ${code ?? '未知'} 结束。`))
    })
  }

  private async context(): Promise<PipelineContext> {
    const plugin = getStorage().plugins.get(PLUGIN_ID)
    if (!plugin?.enabled) throw new Error('请在“设置 > 插件”中启用代码生成管线。')
    const allowedProjectRoot = String(plugin.settings.allowedProjectRoot || '').trim()
    const pipelineRoot = String(plugin.settings.pipelineRoot || '').trim()
    if (!allowedProjectRoot || !pipelineRoot) throw new Error('请先在“设置 > 插件”中配置允许项目根目录和管线目录。')
    const allowedRoot = await canonicalize(allowedProjectRoot)
    const canonicalPipeline = await canonicalize(pipelineRoot)
    if (!isWithin(canonicalPipeline, allowedRoot)) throw new Error('管线目录必须解析到允许项目根目录之内。')
    const runnerPath = path.join(canonicalPipeline, 'scripts', 'pipeline_runner.py')
    const runnerStats = await fs.stat(runnerPath).catch(() => null)
    if (!runnerStats?.isFile()) throw new Error('管线目录中找不到 scripts/pipeline_runner.py。')
    const repositoryRoot = path.dirname(canonicalPipeline)
    if (!isWithin(repositoryRoot, allowedRoot)) throw new Error('管线仓库根目录必须解析到允许项目根目录之内。')
    const fingerprint = createHash('sha256').update(`${await sha256(runnerPath)}:${await sha256(path.join(canonicalPipeline, 'requirements.lock'))}`).digest('hex')
    return { allowedRoot, pipelineRoot: canonicalPipeline, repositoryRoot, runnerPath, fingerprint }
  }

  private async assertStable(context: PipelineContext): Promise<void> {
    if (this.fingerprint && this.fingerprint !== context.fingerprint) throw new Error('管线脚本或依赖锁文件已变化。请重新打开并复核插件配置后再运行。')
    this.fingerprint = context.fingerprint
  }

  private async assertWithinAllowed(candidate: string, allowedRoot: string, label: string): Promise<string> {
    const canonical = await canonicalize(candidate)
    if (!isWithin(canonical, allowedRoot)) throw new Error(`${label} 必须解析到允许项目根目录之内。`)
    return canonical
  }

  private async isProductionWorkspace(configPath: string, context: PipelineContext): Promise<boolean> {
    const config = await fs.readFile(configPath, 'utf-8')
    const targetModel = yamlScalar(config, 'target_model')
    if (!targetModel) return false
    const modelPath = await this.assertWithinAllowed(path.join(context.repositoryRoot, targetModel), context.allowedRoot, '目标模型')
    return /(^|\n)\s*production_output:\s*true\s*($|\n)/m.test(await fs.readFile(modelPath, 'utf-8'))
  }

  private async attachArtifacts(run: CodeProductionRun, context: PipelineContext): Promise<void> {
    const reportPath = path.join(run.outputDirectory, 'pipeline-run-report.yaml')
    const planPath = path.join(run.outputDirectory, 'delivery', 'delivery-plan.yaml')
    if (await fs.stat(reportPath).then(() => true).catch(() => false)) run.reportPath = reportPath
    if (await fs.stat(planPath).then(() => true).catch(() => false)) run.deliveryPlanPath = planPath
    await this.assertWithinAllowed(run.outputDirectory, context.allowedRoot, '运行输出目录')
  }

  private async stopProcess(child: ChildProcess): Promise<void> {
    if (child.killed || !child.pid) return
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        killer.on('close', () => resolve())
        killer.on('error', () => resolve())
      })
      return
    }
    child.kill('SIGTERM')
  }
}
