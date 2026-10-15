import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '../..')
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8')

describe('image input gate wiring', () => {
  it('asks the same capability profile on both chat paths', () => {
    expect(read('src/main/ipc/conversation.ts')).toContain('getModelCapabilities(provider.id, agent.model)')
    expect(read('src/main/agent-engine/agent-runner.ts')).toContain('getModelCapabilities(this.config.provider.id, agentConfig.model)')
  })

  it('leaves no private vision allowlist behind in the main process', () => {
    // Both gates used to carry their own copy of an OpenAI model-name regex, which
    // made every non-OpenAI visual route unreadable no matter what it could do.
    expect(read('src/main/ipc/conversation.ts')).not.toContain('gpt-4o')
    expect(read('src/main/agent-engine/agent-runner.ts')).not.toContain('gpt-4o')
    expect(read('src/main/agent-engine/agent-runner.ts')).not.toContain('this.supportsVisionInput(')
  })

  it('keeps the identifier pattern as a prefill inside the shared profile', () => {
    expect(read('src/shared/model-capabilities.ts')).toContain('VISION_PATTERN')
    expect(read('src/main/ipc/conversation.ts')).toContain('supportsImageInput(')
    expect(read('src/main/agent-engine/agent-runner.ts')).toContain('supportsImageInput(modelCapabilities)')
  })
})
