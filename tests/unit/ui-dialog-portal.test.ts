import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '../..')

describe('dialog overlay guards', () => {
  const source = fs.readFileSync(path.join(root, 'src/renderer/components/ui/Dialog.tsx'), 'utf8')

  it('portals the modal to <body> so a transformed ancestor cannot swallow the overlay', () => {
    // .eva-lift:hover and .agent-card carry transforms: a non-none transform makes that ancestor the
    // containing block of the fixed wrapper, so the dim layer ends up behind the opaque panel and
    // flickers with the cursor. Rendering inline (the pre-fix behavior) reintroduces that bug in every
    // host that nests the dialog inside a lifted card — the model connection editor does exactly that.
    expect(source).toContain("import { createPortal } from 'react-dom'")
    expect(source).toMatch(/return createPortal\(/)
    expect(source).toContain('className="fixed inset-0 flex items-center justify-center p-4"')
    expect(source).toContain('document.body')
  })

  it('does not render the modal inline in the host subtree', () => {
    expect(source).not.toMatch(/return \(\s*<div className="fixed inset-0/)
  })
})
