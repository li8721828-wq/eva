import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { writeJsonAtomicAsync } from '../storage/atomic-file'
import type { ChatMessageInput } from '../../shared/types/provider'

interface Cursor {
  version: 1
  generation: string
  users: string[]
  ready: boolean
}
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Each engine owns its native files. Eva stores only an import cursor, never a reconstructed SDK log. */
export async function prepareNativeSession(options: {
  root?: string
  conversationId?: string
  engine: string
  workspacePath: string
  history: ChatMessageInput[]
  userMessageIds?: string[]
}): Promise<{
  directory?: string
  resume: boolean
  history: ChatMessageInput[]
  commit?: () => Promise<void>
}> {
  const root =
    options.root ||
    (app?.getPath
      ? path.join(app.getPath('userData'), 'native-agent-sessions')
      : undefined)
  if (!root || !options.conversationId)
    return { resume: false, history: options.history }
  const directory = path.join(
    root,
    digest(options.conversationId),
    digest(options.workspacePath),
    options.engine,
  )
  const cursorPath = path.join(directory, 'cursor.json')
  const userMessages = options.history.filter((m) => m.role === 'user')
  const users =
    options.userMessageIds?.length === userMessages.length
      ? options.userMessageIds.map((id) => digest(id))
      : userMessages.map((m) => digest(m))
  let previous: Cursor | undefined
  try {
    const value = JSON.parse(await fs.readFile(cursorPath, 'utf8'))
    if (
      value.version === 1 &&
      /^[\da-f-]{36}$/.test(value.generation) &&
      Array.isArray(value.users) &&
      value.users.every((v: unknown) => typeof v === 'string')
    )
      previous = value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const resume = Boolean(
    previous?.ready &&
    previous.users.length < users.length &&
    previous.users.every((value, i) => value === users[i]),
  )
  const generation = resume ? previous!.generation : randomUUID()
  const cursor: Cursor = { version: 1, generation, users, ready: false }
  await writeJsonAtomicAsync(cursorPath, cursor)
  let imported = options.history
  if (resume) {
    let seen = 0
    const start = options.history.findIndex(
      (message) => message.role === 'user' && ++seen > previous!.users.length,
    )
    imported = options.history.slice(start)
  }
  let committed = false
  return {
    directory: path.join(directory, generation),
    resume,
    history: imported,
    commit: async () => {
      if (committed) return
      await writeJsonAtomicAsync(cursorPath, { ...cursor, ready: true })
      committed = true
    },
  }
}

export async function invalidateNativeSessions(
  conversationId: string,
  root?: string,
): Promise<void> {
  const base =
    root ||
    (app?.getPath
      ? path.join(app.getPath('userData'), 'native-agent-sessions')
      : undefined)
  if (!base) return
  const target = path.resolve(base, digest(conversationId))
  if (path.dirname(target) !== path.resolve(base))
    throw new Error('Invalid native session directory')
  await fs.rm(target, { recursive: true, force: true })
}
