import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

// electron-vite writes main, preload, and renderer assets into one output
// directory. Clearing it before a release build prevents stale hashed assets
// from previous builds being included in the installer.
await rm(resolve(process.cwd(), 'out'), { recursive: true, force: true })
