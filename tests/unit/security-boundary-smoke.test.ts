import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '../..')

describe('Electron security boundary smoke checks', () => {
  it('keeps the main renderer sandboxed and blocks post-load navigation', () => {
    const source = fs.readFileSync(path.join(root, 'src/main/window.ts'), 'utf8')
    expect(source).toContain('contextIsolation: true')
    expect(source).toContain('nodeIntegration: false')
    expect(source).toContain('sandbox: true')
    expect(source).toContain("webContents.on('will-navigate'")
    expect(source).toContain('event.preventDefault()')
  })

  it('exposes renderer IPC only through the shared typed contract helper', () => {
    const source = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')
    expect(source).toContain('function invokeContract')
    expect(source).toContain('ipc-contract')
  })
})
