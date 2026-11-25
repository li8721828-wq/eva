/** Narrow routing only while an explicitly waiting requirement run exists. */
export function isMaterialSimulationRequest(text: string): boolean {
  const value = text.trim().replace(/[，。！!？?\s]/g, '')
  return /^(?:请|那|那么|可以)?(?:你|帮我)?(?:先)?(?:进行)?模拟(?:一下)?(?:缺失|缺少|当前|这些|一下)?(?:的)?材料(?:吧|吗)?$/.test(value)
    || /^(?:这些|缺失的|缺少的)?材料(?:你|请|帮我)?(?:先)?(?:进行)?模拟(?:一下)?(?:吧|吗)?$/.test(value)
    || /^(?:那|那么|请)?(?:你)?先模拟(?:一下)?(?:吧|吗)?$/.test(value)
}
