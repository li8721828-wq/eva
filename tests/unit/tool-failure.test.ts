import { describe, expect, it } from 'vitest'
import { toolFailure } from '../../src/shared/tool-failure'

describe('tool failure classification', () => {
  it.each([
    ['Approval timed out after 60s.', 'tool_approval_timeout'],
    ['The user denied the request.', 'tool_approval_denied'],
    ['审批卡片无法送达该客户端', 'tool_approval_unavailable'],
    ['Access denied: D:/other/file.txt', 'tool_access_denied'],
    ['ENOENT: no such file or directory', 'tool_path_not_found'],
    ['old_text not found', 'tool_edit_conflict'],
  ])('keeps %s distinct and non-retryable', (message, code) => {
    expect(toolFailure(message)).toEqual({ code, message, retryable: false })
  })
  it('does not relabel unknown SDK errors', () => {
    expect(toolFailure('arbitrary SDK failure')).toMatchObject({ code: 'tool_execution_failed', retryable: false })
  })
})
