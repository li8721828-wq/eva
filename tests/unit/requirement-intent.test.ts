import { expect, it } from 'vitest'
import { isMaterialSimulationRequest } from '../../src/renderer/lib/requirement-intent'
it.each(['材料你先进行模拟', '那你先模拟', '请先模拟缺失材料', '帮我模拟一下材料'])('routes material simulation: %s', text => {
  expect(isMaterialSimulationRequest(text)).toBe(true)
})
it.each(['不要模拟材料', '帮我模拟网络攻击', '先分析这份材料', '模拟是什么？'])('leaves other requests alone: %s', text => {
  expect(isMaterialSimulationRequest(text)).toBe(false)
})
