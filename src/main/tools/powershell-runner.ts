import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { mkdir, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const RUNTIME_DIRECTORY = path.join(os.tmpdir(), 'eva-runtime')

interface PowerShellOptions {
  timeout: number
  maxBuffer: number
  sta?: boolean
}

/**
 * Windows limits the full child-process command line to roughly 32 KiB.
 * Desktop scripts contain UI Automation interop and exceed that limit when
 * passed through -EncodedCommand, so run them from a short-lived local file.
 */
export async function runPowerShellScript(script: string, options: PowerShellOptions): Promise<{ stdout: string; stderr: string }> {
  await mkdir(RUNTIME_DIRECTORY, { recursive: true })
  const scriptPath = path.join(RUNTIME_DIRECTORY, `${randomUUID()}.ps1`)
  await writeFile(scriptPath, script, 'utf8')
  try {
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive']
    if (options.sta) args.push('-STA')
    args.push('-ExecutionPolicy', 'Bypass', '-File', scriptPath)
    return await execFileAsync('powershell.exe', args, {
      windowsHide: true,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
    })
  } finally {
    await rm(scriptPath, { force: true }).catch(() => undefined)
  }
}
