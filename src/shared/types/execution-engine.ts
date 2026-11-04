export const EXECUTION_ENGINE_IDS = ['eva', 'pi', 'deepseek-harness'] as const
export type ExecutionEngineId = (typeof EXECUTION_ENGINE_IDS)[number]

export interface ExecutionEngineConfig {
  id: ExecutionEngineId
  /** External Node executable, used by Pi and DeepSeek Harness. Never a shell command. */
  nodePath: string
  /** Native-run safety ceiling; independent of Eva's agent-loop iteration setting. */
  maxModelCalls?: number
  maxOutputTokens?: number
}

export const DEFAULT_EXECUTION_ENGINE: ExecutionEngineConfig = {
  id: 'eva',
  nodePath: 'node',
}

export function isExecutionEngineConfig(
  value: unknown,
): value is ExecutionEngineConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const config = value as ExecutionEngineConfig
  return (
    EXECUTION_ENGINE_IDS.includes(config.id) &&
    typeof config.nodePath === 'string' &&
    (config.maxModelCalls === undefined ||
      (Number.isInteger(config.maxModelCalls) &&
        config.maxModelCalls >= 1 &&
        config.maxModelCalls <= 10000)) &&
    (config.maxOutputTokens === undefined ||
      (Number.isInteger(config.maxOutputTokens) &&
        config.maxOutputTokens >= 256 &&
        config.maxOutputTokens <= 131072)) &&
    config.nodePath.trim().length > 0 &&
    config.nodePath.length <= 4096 &&
    !/[\r\n\0]/u.test(config.nodePath)
  )
}
