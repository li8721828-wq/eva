import { describe, expect, it } from 'vitest'
import { filePathExtension, isFilePathLikeCodeSpan } from '../../src/renderer/lib/file-path-chip'

describe('isFilePathLikeCodeSpan', () => {
  it('accepts repository-relative and absolute code paths', () => {
    for (const text of [
      'src/main/tools/web-tools.ts',
      'tests/unit/x.test.ts',
      'C:\\proj\\a.ts',
      '/abs/path.py',
      './rel.md',
      '../shared/types/plugin.ts',
      'docs/Makefile',
    ]) {
      expect(isFilePathLikeCodeSpan(text), text).toBe(true)
    }
  })

  it('rejects commands, flags, urls, globs, and non-text files', () => {
    for (const text of [
      '--flag',
      '$HOME/x.ts',
      '#anchor',
      'npm run build',
      'https://a.com/x.ts',
      'a b.ts',
      'foo.png',
      'app.exe',
      'useState',
      'x*.ts',
      'a=b.ts',
      'cat x.ts | grep y',
      '',
    ]) {
      expect(isFilePathLikeCodeSpan(text), text).toBe(false)
    }
  })

  it('rejects extensionless basenames outside the known build-file set', () => {
    expect(isFilePathLikeCodeSpan('Makefile')).toBe(false)
    expect(isFilePathLikeCodeSpan('src/Makefile')).toBe(true)
  })
})

describe('filePathExtension', () => {
  it('reads the final extension in lowercase', () => {
    expect(filePathExtension('a/B.Test.TS')).toBe('ts')
    expect(filePathExtension('Makefile')).toBe('')
    expect(filePathExtension('.gitignore')).toBe('')
  })
})
