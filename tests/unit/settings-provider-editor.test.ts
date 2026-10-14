import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '../..')

describe('model connection editor guards', () => {
  const source = fs.readFileSync(path.join(root, 'src/renderer/components/settings/SettingsDialog.tsx'), 'utf8')

  it('never wipes the fetched model list while credentials are being typed', () => {
    expect(source).toContain('onChange={(event) => setApiKey(event.target.value)}')
    expect(source).toContain('onChange={(event) => setBaseUrl(event.target.value)}')
    // availableModels is the only capability store: a wipe silently discards probe results and
    // per-model context-window edits, so only the provider-type switch may reset it.
    expect(source.match(/invalidateModels\(\)/g)).toHaveLength(1)
  })

  it('reports a stale list instead of destroying it', () => {
    expect(source).toContain('computeModelStamp(config)')
    expect(source).toContain('settings-dialog__models-notice')
    expect(source).toContain('modelsAreStale &&')
  })
})

describe('model connection dialog layout guards', () => {
  const css = fs.readFileSync(path.join(root, 'src/renderer/index.css'), 'utf8')

  it('caps the dialog frame instead of fixing it so the empty state stays compact', () => {
    // The fixed frame reserved a 237px dashed box when no models were fetched (user-rejected);
    // the frame now sizes to its content and only clamps at the cap. A fetched list may still
    // grow the dialog up to 56rem, under which only the form scrolls.
    expect(css).toMatch(/\.settings-dialog__provider-editor \{[\s\S]*?max-height: min\(56rem, calc\(100vh - 2rem\)\)/)
    expect(css).not.toMatch(/^\s*height: min\(56rem/m)
    expect(css).toContain('scrollbar-gutter: stable')
  })

  it('keeps the golden-ratio column split and the capped list slot', () => {
    expect(css).toContain('grid-template-columns: minmax(0, 1.618fr) minmax(0, 1fr);')
    expect(css).toMatch(/\.settings-dialog__model-options \{[\s\S]*?max-height: 220px/)
  })

  it('pins fields at natural height so only the scroll container gives under the cap', () => {
    expect(css).toMatch(/\.settings-dialog__provider-editor-form \{[\s\S]*?display: flex;[\s\S]*?flex-direction: column;/)
    expect(css).toMatch(/\.settings-dialog__provider-editor-form > \* \{[\s\S]*?flex: 0 0 auto;/)
    expect(css).toMatch(/\.settings-dialog__provider-editor \.settings-dialog__field--models \{[\s\S]*?flex: 1 1 auto;/)
  })

  it('never stretches the empty Models box to absorb leftover height', () => {
    expect(css).toMatch(/\.settings-dialog__provider-editor \.settings-dialog__models-empty \{[^}]*min-height: 48px;/)
    expect(css).not.toMatch(/\.settings-dialog__provider-editor \.settings-dialog__models-empty \{[^}]*flex:/)
  })

  it('bleeds the form clip region so the focus glow is not cut at the field edge', () => {
    // A scroll container clips its children's shadows at its own padding box, and the full-bleed
    // fields sit flush with it — eva-focus-float's ±14px sweep painted pure white on the left
    // (user-reported 割裂感). padding-inline + matching negative margin widen the clip region into
    // the dialog's own p-6 padding while keeping every field at its exact position.
    expect(css).toMatch(/\.settings-dialog__provider-editor-form \{[\s\S]*?padding-inline: 1\.5rem;[\s\S]*?margin-inline: -1\.5rem;/)
  })
})
