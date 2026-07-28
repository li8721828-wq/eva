import { describe, expect, it } from 'vitest'
import { formatQqPlainText, splitQqPlainText } from '../../src/main/services/qq-message-format'

describe('QQ message formatting', () => {
  it('normalizes line endings and removes transport control characters', async () => {
    await expect(formatQqPlainText('hello\r\nworld\u0000\u001B[31m!')).resolves.toBe('hello\nworld!')
  })

  it('uses a visible fallback for an empty response', async () => {
    await expect(formatQqPlainText(' \n ')).resolves.toContain('completed')
  })

  it('renders common Markdown into readable QQ plain text', async () => {
    const content = [
      '# Summary',
      '',
      '**Done**: [report](https://example.com/report)',
      '',
      '- first item',
      '- second `item`',
      '',
      '```ts',
      'const answer = 42',
      '```',
    ].join('\n')

    await expect(formatQqPlainText(content)).resolves.toBe([
      'Summary',
      '',
      'Done: report (https://example.com/report)',
      '',
      '• first item',
      '• second item',
      '',
      '[ts]',
      'const answer = 42',
    ].join('\n'))
  })

  it('does not split an emoji surrogate pair across messages', async () => {
    const chunks = await splitQqPlainText(`ab😀cd`, 3)
    expect(chunks).toEqual(['ab', '😀c', 'd'])
    expect(chunks.join('')).toBe('ab😀cd')
  })
})
