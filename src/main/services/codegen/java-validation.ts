import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { rmsdPath } from '../rmsd-path'

const run = promisify(execFile)

/** Compile generated Java in isolation and run the optional generated acceptance class. */
export async function verifyJavaSources(
  directory: string,
  files: ReadonlyArray<{ path: string; sha256: string }>,
  signal?: AbortSignal,
  acceptanceClass?: string,
): Promise<string> {
  const main = files.filter((file) => file.path.endsWith('.java') && !file.path.startsWith('src/test/'))
  const java = [...main]
  if (acceptanceClass) {
    if (!/^(?:[A-Za-z][A-Za-z0-9_]*\.)+DomainAcceptance$/.test(acceptanceClass)) {
      throw new Error('Invalid generated Java acceptance class.')
    }
    const source = `src/test/java/${acceptanceClass.replace(/\./g, '/')}.java`
    const acceptance = files.find((file) => file.path === source)
    if (!acceptance) throw new Error('The Java target produced no acceptance harness.')
    java.push(acceptance)
  }
  if (!main.length) throw new Error('The Java target produced no main sources.')
  const parent = await fs.realpath(os.tmpdir())
  const scratch = await fs.mkdtemp(path.join(parent, 'eva-javac-'))
  try {
    const sources: string[] = []
    for (const entry of java) {
      const file = await rmsdPath(directory, path.join(directory, entry.path))
      const contents = await fs.readFile(file)
      if (createHash('sha256').update(contents).digest('hex') !== entry.sha256) {
        throw new Error(`Java source changed before compilation: ${entry.path}`)
      }
      const isolated = await rmsdPath(scratch, path.join(scratch, 'sources', entry.path))
      await fs.mkdir(path.dirname(isolated), { recursive: true })
      await fs.writeFile(isolated, contents, { flag: 'wx' })
      sources.push(path.relative(scratch, isolated).split(path.sep).join('/'))
    }
    await fs.mkdir(path.join(scratch, 'classes'))
    await fs.mkdir(path.join(scratch, 'empty'))
    // Relative generated paths contain no shell syntax. The argfile also avoids
    // Windows command-line length limits for packages with many source files.
    await fs.writeFile(path.join(scratch, 'sources.args'), sources.map((name) => JSON.stringify(name)).join('\n'), 'utf8')
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (/^(?:JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JDK_JAVAC_OPTIONS|CLASSPATH)$/i.test(key)) delete env[key]
    }
    try {
      await run('javac', ['--release', '17', '-encoding', 'UTF-8', '-proc:none', '-classpath', 'empty', '-sourcepath', 'empty', '-d', 'classes', '@sources.args'], {
        cwd: scratch, env, signal, timeout: 45_000, windowsHide: true, maxBuffer: 128 * 1024,
      })
    } catch (error) {
      if (signal?.aborted) throw error
      const failure = error as NodeJS.ErrnoException & { stderr?: string }
      if (failure.code === 'ENOENT') throw new Error('Java generation requires javac from JDK 17 or newer on PATH.')
      throw new Error(`Java compilation failed: ${failure.stderr?.trim().slice(0, 3000) || failure.message}`)
    }
    if (acceptanceClass) {
      try {
        await run('java', ['-classpath', 'classes', acceptanceClass], {
          cwd: scratch, env, signal, timeout: 30_000, windowsHide: true, maxBuffer: 128 * 1024,
        })
      } catch (error) {
        if (signal?.aborted) throw error
        const failure = error as NodeJS.ErrnoException & { stderr?: string }
        throw new Error(`Java domain acceptance failed: ${failure.stderr?.trim().slice(0, 3000) || failure.message}`)
      }
    }
    return `JDK 17 编译通过（${main.length} 个主源文件）${acceptanceClass ? '，领域行为测试通过' : ''}`
  } finally {
    if (path.dirname(await fs.realpath(scratch)) === parent && path.basename(scratch).startsWith('eva-javac-')) {
      await fs.rm(scratch, { recursive: true, force: true })
    }
  }
}
