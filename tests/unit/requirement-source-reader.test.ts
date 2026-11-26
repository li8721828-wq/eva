import { describe, expect, it, vi } from 'vitest'
import { readRequirementSource, splitRequirementSource } from '../../src/main/services/requirement-source-reader'

describe('long requirement source reading', () => {
  it('covers every character including paragraph boundaries and surrogate pairs', () => {
    const source = `${'第一章。\n\n'.repeat(200)}${'x'.repeat(77)}😀${'结尾规则。'.repeat(200)}`
    const chunks = splitRequirementSource(source, 79)
    expect(chunks.map(chunk => chunk.text).join('')).toBe(source)
    expect(chunks.every(chunk => chunk.end - chunk.start <= 79)).toBe(true)
    expect(chunks.every(chunk => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk.text))).toBe(true)
  })

  it('keeps short sources verbatim without model calls', async () => {
    const read = vi.fn()
    await expect(readRequirementSource('规则原文。', 5_000, read, () => {})).resolves.toBe('规则原文。')
    expect(read).not.toHaveBeenCalled()
  })

  it('reads every source slice before reducing notes to the request budget', async () => {
    const source = '章节规则。'.repeat(30_000) + '文末唯一条款'
    const seen: string[] = []
    const read = vi.fn(async (text: string, label: string, target: number) => {
      if (label.startsWith('原文')) seen.push(text)
      return `${label}。${'有效规则。'.repeat(Math.floor(target / 12))}`
    })
    const result = await readRequirementSource(source, 5_000, read, () => {})
    expect(seen.join('')).toBe(source)
    expect(read.mock.calls.some(([, label]) => label.startsWith('汇总'))).toBe(true)
    expect(result.length).toBeLessThan(5_256)
    expect(result).toContain('不替代原始材料')
  })

  it('does not continue past a failed or cancelled source slice', async () => {
    const read = vi.fn().mockResolvedValueOnce('第一段。').mockRejectedValueOnce(new Error('读取中断'))
    await expect(readRequirementSource('规则。'.repeat(8_000), 5_000, read, () => {})).rejects.toThrow('读取中断')
    expect(read).toHaveBeenCalledTimes(2)
    const cancelled = vi.fn(() => { throw new Error('已取消') })
    read.mockClear()
    await expect(readRequirementSource('规则。'.repeat(8_000), 5_000, read, cancelled)).rejects.toThrow('已取消')
    expect(read).not.toHaveBeenCalled()
  })

  it.each(['', 'x'.repeat(2_000)])('rejects unusable notes instead of truncating them', async (note) => {
    await expect(readRequirementSource('原文。'.repeat(4_000), 5_000, async () => note, () => {})).rejects.toThrow('结果为空或超过')
  })
})
