import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'

/**
 * Persist a JSON document without exposing readers to a partially written file.
 * The rename retry matters on Windows where Defender and indexers can briefly
 * hold the destination after a write.
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${uuidv4()}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  try {
    renameWithRetry(tmpPath, filePath)
  } catch (error) {
    try {
      fs.rmSync(tmpPath, { force: true })
    } catch {
      // Best-effort cleanup; the rename error below is the actionable one.
    }
    throw error
  }
}

function renameWithRetry(src: string, dest: string): void {
  const maxAttempts = 5
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      fs.renameSync(src, dest)
      return
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException)?.code
      const retriable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      if (!retriable || attempt === maxAttempts) break
      const sleepMs = 10 * attempt
      const until = Date.now() + sleepMs
      while (Date.now() < until) { /* synchronous backoff for the file lock */ }
    }
  }
  throw lastError
}
