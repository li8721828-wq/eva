import fs from 'node:fs/promises'
import path from 'node:path'
import { isWithinRoot } from './file-service'

/** Resolve an artifact within its owning directory and reject link traversal. */
export async function rmsdPath(root: string, candidate: string): Promise<string> {
  const absoluteRoot = path.resolve(root)
  const absolute = path.resolve(candidate)
  if (!isWithinRoot(absolute, absoluteRoot)) throw new Error(`Path escapes the RMSD directory: ${candidate}`)
  const canonicalRoot = await fs.realpath(absoluteRoot)
  const segments = path.relative(absoluteRoot, absolute).split(path.sep).filter(Boolean)
  let current = canonicalRoot
  for (const segment of segments) {
    if (process.platform === 'win32' && (/[:. ]$|:/.test(segment) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment))) {
      throw new Error(`Invalid Windows RMSD path component: ${segment}`)
    }
    current = path.join(current, segment)
    try {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink()) throw new Error(`RMSD artifacts cannot use a symbolic link or junction: ${current}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return current
}
