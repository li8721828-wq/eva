import { describe, it, expect } from 'vitest'
import { workspaceLayout, MAIN_MIN_WIDTH } from '../../src/renderer/lib/workspace-layout'
import { terminalTheme } from '../../src/renderer/lib/terminal-theme'

describe('workspace width allocation', () => {
  for (const viewport of [900, 1000, 1200, 1440, 1920]) {
    for (const collapsed of [false, true]) {
      for (const terminal of [false, true]) {
        it(`keeps the main canvas usable at ${viewport}px, collapsed=${collapsed}, terminal=${terminal}`, () => {
          const layout = workspaceLayout(viewport, collapsed, 304, terminal ? 560 : 360, terminal)
          expect(layout.railWidth).toBeGreaterThan(0)
          expect(layout.sidebarWidth + layout.railWidth + 8).toBeLessThanOrEqual(viewport)
          if (!layout.overlay)
            expect(viewport - layout.sidebarWidth - layout.railWidth - 8).toBeGreaterThanOrEqual(
              MAIN_MIN_WIDTH
            )
          if (layout.overlay)
            expect(layout.railWidth).toBeLessThanOrEqual(viewport - layout.sidebarWidth - 24)
        })
      }
    }
  }
  it('clamps an oversized saved rail without changing the preferred size', () => {
    expect(workspaceLayout(1200, false, 304, 960, true)).toMatchObject({ railWidth: 408, overlay: false })
    expect(workspaceLayout(1920, false, 304, 960, true)).toMatchObject({ railWidth: 960, overlay: false })
  })
})

describe('terminal theme', () => {
  it('provides distinct theme surfaces and legible semantic ANSI colors', () => {
    expect(
      new Set(['light', 'dark', 'starlight'].map((theme) => terminalTheme(theme as any).background)).size
    ).toBe(3)
    for (const theme of ['light', 'dark', 'starlight'] as const) {
      const palette = terminalTheme(theme)
      for (const key of ['foreground', 'cursor', 'red', 'green', 'yellow', 'blue', 'cyan'] as const) {
        expect(palette[key]).toMatch(/^#[0-9a-f]{6}$/i)
        expect(palette[key]).not.toBe(palette.background)
      }
    }
  })
})
