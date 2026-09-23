import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/services/activity-log', () => ({ recordActivity: vi.fn() }))

import {
  clearSessionApprovals,
  createLocalToolApproval,
  rejectAllPendingApprovalsForConversation,
  requiresApproval,
  resolvePendingApproval,
  setApprovalRelay,
} from '../../src/main/services/tool-approval-policy'
import type { ToolApprovalRequest } from '../../src/main/agent-engine/agent-runner'
import type { BrowserWindow } from 'electron'

// Names as registered by `createToolRegistry` in src/main/tools. The approval
// sets are keyed by these exact strings; a rename must update both sides or the
// tool silently stops asking for approval.
const REGISTERED_MUTATING_TOOLS = [
  'write_file',
  'edit_file',
  'spreadsheet',
  'execute_command',
  'write_terminal',
  'browser_control',
  'mcp__myserver__do_thing',
]

const REGISTERED_READ_ONLY_TOOLS = [
  'read_file',
  'list_directory',
  'search_files',
  'search_code',
  'search_by_regex',
  'file_info',
  'web_search',
  'read_web_page',
  'read_terminal',
  'project_search',
  'project_index_status',
  'inspect_runtime',
  'diagnose_runtime',
]

describe('tool approval policy', () => {
  describe('off', () => {
    it('never asks for any tool', () => {
      expect(requiresApproval('write_file', 'off')).toBeNull()
      expect(requiresApproval('execute_command', 'off')).toBeNull()
      expect(requiresApproval('mcp__srv__tool', 'off')).toBeNull()
      expect(requiresApproval('browser_control', 'off')).toBeNull()
    })
  })

  describe('safe', () => {
    it('auto-approves read-only tools', () => {
      for (const t of REGISTERED_READ_ONLY_TOOLS) {
        expect(requiresApproval(t, 'safe'), t).toBeNull()
      }
    })

    it('requires approval for every registered mutating tool', () => {
      for (const t of REGISTERED_MUTATING_TOOLS) {
        expect(requiresApproval(t, 'safe'), t).not.toBeNull()
      }
    })

    it('requires approval for workspace writes', () => {
      expect(requiresApproval('write_file', 'safe')).toBe('workspace-write')
      expect(requiresApproval('edit_file', 'safe')).toBe('workspace-write')
    })

    it('requires approval for terminal commands', () => {
      expect(requiresApproval('execute_command', 'safe')).toBe('terminal-command')
      expect(requiresApproval('write_terminal', 'safe')).toBe('terminal-command')
    })

    it('requires approval for MCP tools', () => {
      expect(requiresApproval('mcp__myserver__do_thing', 'safe')).toBe('mcp-call')
    })

    it('requires approval for the registered browser control tool', () => {
      expect(requiresApproval('browser_control', 'safe')).toBe('browser-control')
    })
  })

  describe('strict', () => {
    it('only auto-approves read-only tools, asks for everything else', () => {
      for (const t of REGISTERED_READ_ONLY_TOOLS) {
        expect(requiresApproval(t, 'strict'), t).toBeNull()
      }
      for (const t of REGISTERED_MUTATING_TOOLS) {
        expect(requiresApproval(t, 'strict'), t).not.toBeNull()
      }
      expect(requiresApproval('execute_command', 'strict')).toBe('terminal-command')
      expect(requiresApproval('write_file', 'strict')).toBe('workspace-write')
    })
  })

  describe('paranoid', () => {
    it('requires approval for every tool', () => {
      for (const t of ['read_file', 'list_directory', 'execute_command', 'browser_control', 'delegate_to_team']) {
        expect(requiresApproval(t, 'paranoid'), t).not.toBeNull()
      }
    })
  })
})

// The renderer can only show one approval card per conversation, so the main
// process serialises requests. A parallel tool batch must not auto-deny the
// siblings whose cards were replaced before the user ever saw them.
describe('approval presentation queue', () => {
  function harness() {
    const sent: Array<Record<string, unknown>> = []
    const window = {
      isDestroyed: () => false,
      webContents: { send: (_channel: string, payload: Record<string, unknown>) => { sent.push(payload) } },
    } as unknown as BrowserWindow
    return { window, sent }
  }

  function request(conversationId: string, toolCallId: string, name: string): ToolApprovalRequest {
    return { toolCall: { id: toolCallId, name, arguments: {} }, workspacePath: conversationId }
  }

  function shownApprovalIds(sent: Array<Record<string, unknown>>): string[] {
    return sent
      .filter((event) => event.type === 'tool_approval_request')
      .map((event) => (event.toolApproval as { id: string }).id)
  }

  it('shows one card at a time and promotes the next waiter on approval', async () => {
    const { window, sent } = harness()
    const conversationId = 'conv-queue-approve'
    const approve = createLocalToolApproval({
      conversationId,
      window,
      config: { policy: 'paranoid', timeoutMs: 5000 },
    })

    const first = approve(request(conversationId, 'call-a', 'read_file'))
    const second = approve(request(conversationId, 'call-b', 'list_directory'))
    // Only the first card reaches the renderer; the second waits its turn.
    expect(shownApprovalIds(sent)).toHaveLength(1)

    expect(resolvePendingApproval(shownApprovalIds(sent)[0], true)).toBe(true)
    await expect(first).resolves.toEqual({ approved: true })
    // Deciding the visible card hands the slot to the queued request.
    expect(shownApprovalIds(sent)).toHaveLength(2)

    expect(resolvePendingApproval(shownApprovalIds(sent)[1], true)).toBe(true)
    await expect(second).resolves.toEqual({ approved: true })
  })

  it('promotes the next waiter when the visible card times out', async () => {
    const { window, sent } = harness()
    const conversationId = 'conv-queue-timeout'
    const approve = createLocalToolApproval({
      conversationId,
      window,
      config: { policy: 'paranoid', timeoutMs: 20 },
    })

    const first = approve(request(conversationId, 'call-a', 'read_file'))
    const second = approve(request(conversationId, 'call-b', 'read_file'))
    expect(shownApprovalIds(sent)).toHaveLength(1)

    const firstDecision = await first
    expect(firstDecision.approved).toBe(false)
    // The timed-out card frees the slot for the queued sibling.
    expect(shownApprovalIds(sent)).toHaveLength(2)

    expect(resolvePendingApproval(shownApprovalIds(sent)[1], true)).toBe(true)
    await expect(second).resolves.toEqual({ approved: true })
  })

  it('denies every queued request when the turn is superseded', async () => {
    const { window, sent } = harness()
    const conversationId = 'conv-queue-supersede'
    const approve = createLocalToolApproval({
      conversationId,
      window,
      config: { policy: 'paranoid', timeoutMs: 5000 },
    })

    const first = approve(request(conversationId, 'call-a', 'read_file'))
    const second = approve(request(conversationId, 'call-b', 'read_file'))
    rejectAllPendingApprovalsForConversation(conversationId, 'superseded')

    await expect(first).resolves.toEqual({ approved: false, message: 'superseded' })
    await expect(second).resolves.toEqual({ approved: false, message: 'superseded' })

    // The slot is free again: a fresh request is shown immediately.
    const third = approve(request(conversationId, 'call-c', 'read_file'))
    expect(shownApprovalIds(sent)).toHaveLength(2)
    expect(resolvePendingApproval(shownApprovalIds(sent)[1], true)).toBe(true)
    await expect(third).resolves.toEqual({ approved: true })
  })

  it('keeps the queue isolated per conversation', async () => {
    const { window, sent } = harness()
    const approveA = createLocalToolApproval({ conversationId: 'conv-iso-a', window, config: { policy: 'paranoid', timeoutMs: 5000 } })
    const approveB = createLocalToolApproval({ conversationId: 'conv-iso-b', window, config: { policy: 'paranoid', timeoutMs: 5000 } })

    const pendingA = approveA(request('conv-iso-a', 'call-a', 'read_file'))
    const pendingB = approveB(request('conv-iso-b', 'call-b', 'read_file'))
    // A card is waiting in each conversation; neither blocks the other.
    expect(shownApprovalIds(sent)).toHaveLength(2)

    expect(resolvePendingApproval(shownApprovalIds(sent)[0], true)).toBe(true)
    expect(resolvePendingApproval(shownApprovalIds(sent)[1], true)).toBe(true)
    await expect(pendingA).resolves.toEqual({ approved: true })
    await expect(pendingB).resolves.toEqual({ approved: true })
  })
})

// The card's "allow for this session" button used to be a no-op: the scope was
// written into an activity-log string and then forgotten, so the very next call
// in the same category asked again. A session grant must now cover the category
// the card displayed, for that conversation only.
describe('session-scoped approval', () => {
  function harness() {
    const sent: Array<Record<string, unknown>> = []
    const window = {
      isDestroyed: () => false,
      webContents: { send: (_channel: string, payload: Record<string, unknown>) => { sent.push(payload) } },
    } as unknown as BrowserWindow
    return { window, sent }
  }

  function request(conversationId: string, toolCallId: string, name: string): ToolApprovalRequest {
    return { toolCall: { id: toolCallId, name, arguments: {} }, workspacePath: conversationId }
  }

  function shownApprovalIds(sent: Array<Record<string, unknown>>): string[] {
    return sent
      .filter((event) => event.type === 'tool_approval_request')
      .map((event) => (event.toolApproval as { id: string }).id)
  }

  it('stops asking for the same category in the same conversation', async () => {
    const { window, sent } = harness()
    const conversationId = 'conv-session-same-category'
    const approve = createLocalToolApproval({ conversationId, window, config: { policy: 'safe', timeoutMs: 5000 } })

    const first = approve(request(conversationId, 'call-a', 'execute_command'))
    expect(shownApprovalIds(sent)).toHaveLength(1)
    expect(resolvePendingApproval(shownApprovalIds(sent)[0], true, undefined, 'session')).toBe(true)
    await expect(first).resolves.toEqual({ approved: true })

    // `write_terminal` is the same category as the granted `execute_command`.
    await expect(approve(request(conversationId, 'call-b', 'write_terminal'))).resolves.toEqual({ approved: true })
    expect(shownApprovalIds(sent)).toHaveLength(1)
  })

  it('keeps asking when the decision was scoped to once', async () => {
    const { window, sent } = harness()
    const conversationId = 'conv-session-once'
    const approve = createLocalToolApproval({ conversationId, window, config: { policy: 'safe', timeoutMs: 5000 } })

    const first = approve(request(conversationId, 'call-a', 'execute_command'))
    expect(resolvePendingApproval(shownApprovalIds(sent)[0], true, undefined, 'once')).toBe(true)
    await expect(first).resolves.toEqual({ approved: true })

    void approve(request(conversationId, 'call-b', 'execute_command'))
    expect(shownApprovalIds(sent)).toHaveLength(2)
  })

  it('does not widen a grant to another category', async () => {
    const { window, sent } = harness()
    const conversationId = 'conv-session-other-category'
    const approve = createLocalToolApproval({ conversationId, window, config: { policy: 'safe', timeoutMs: 5000 } })

    const first = approve(request(conversationId, 'call-a', 'write_file'))
    expect(resolvePendingApproval(shownApprovalIds(sent)[0], true, undefined, 'session')).toBe(true)
    await expect(first).resolves.toEqual({ approved: true })

    // workspace-write was granted; terminal-command still needs its own card.
    void approve(request(conversationId, 'call-b', 'execute_command'))
    expect(shownApprovalIds(sent)).toHaveLength(2)
  })

  it('does not carry a grant into another conversation', async () => {
    const { window, sent } = harness()
    const granted = createLocalToolApproval({ conversationId: 'conv-session-a', window, config: { policy: 'safe', timeoutMs: 5000 } })
    const pending = granted(request('conv-session-a', 'call-a', 'execute_command'))
    expect(resolvePendingApproval(shownApprovalIds(sent)[0], true, undefined, 'session')).toBe(true)
    await expect(pending).resolves.toEqual({ approved: true })

    const other = createLocalToolApproval({ conversationId: 'conv-session-b', window, config: { policy: 'safe', timeoutMs: 5000 } })
    void other(request('conv-session-b', 'call-b', 'execute_command'))
    expect(shownApprovalIds(sent)).toHaveLength(2)
  })

  it('does not grant anything when the user declines', async () => {
    const { window, sent } = harness()
    const conversationId = 'conv-session-declined'
    const approve = createLocalToolApproval({ conversationId, window, config: { policy: 'safe', timeoutMs: 5000 } })

    const first = approve(request(conversationId, 'call-a', 'execute_command'))
    expect(resolvePendingApproval(shownApprovalIds(sent)[0], false, 'no', 'session')).toBe(true)
    await expect(first).resolves.toEqual({ approved: false, message: 'no' })

    void approve(request(conversationId, 'call-b', 'write_terminal'))
    expect(shownApprovalIds(sent)).toHaveLength(2)
  })

  it('forgets the grant once the conversation is deleted', async () => {
    const { window, sent } = harness()
    const conversationId = 'conv-session-deleted'
    const approve = createLocalToolApproval({ conversationId, window, config: { policy: 'safe', timeoutMs: 5000 } })

    const first = approve(request(conversationId, 'call-a', 'execute_command'))
    expect(resolvePendingApproval(shownApprovalIds(sent)[0], true, undefined, 'session')).toBe(true)
    await expect(first).resolves.toEqual({ approved: true })

    clearSessionApprovals(conversationId)
    void approve(request(conversationId, 'call-b', 'write_terminal'))
    expect(shownApprovalIds(sent)).toHaveLength(2)
  })
})

// A phone terminal drives a conversation over a transport that has no
// `BrowserWindow`. Two things used to break there: the card was announced before
// its id was resolvable, so a client that answered immediately had its decision
// silently dropped and the tool hung until the approval timed out; and a card
// that could not be handed over waited for a reply from a client that never got
// one. A network client must never be auto-approved.
describe('approval relay (non-window transports)', () => {
  function harness() {
    const sent: Array<Record<string, unknown>> = []
    const window = {
      isDestroyed: () => false,
      webContents: { send: (_channel: string, payload: Record<string, unknown>) => { sent.push(payload) } },
    } as unknown as BrowserWindow
    return { window, sent }
  }

  function request(conversationId: string, toolCallId: string, name: string): ToolApprovalRequest {
    return { toolCall: { id: toolCallId, name, arguments: {} }, workspacePath: conversationId }
  }

  function cardIds(sent: Array<Record<string, unknown>>): string[] {
    return sent
      .filter((event) => event.type === 'tool_approval_request')
      .map((event) => (event.toolApproval as { id: string }).id)
  }

  it('gives the card to the relay rather than the window', async () => {
    const { window, sent } = harness()
    const conversationId = 'conv-relay-owns'
    const received: string[] = []
    setApprovalRelay(conversationId, (approval) => { received.push(approval.id); return true })
    try {
      const approve = createLocalToolApproval({ conversationId, window, config: { policy: 'paranoid', timeoutMs: 5000 } })
      const pending = approve(request(conversationId, 'call-a', 'execute_command'))

      expect(received).toHaveLength(1)
      expect(cardIds(sent)).toHaveLength(0)
      expect(resolvePendingApproval(received[0], true)).toBe(true)
      await expect(pending).resolves.toEqual({ approved: true })
    } finally {
      setApprovalRelay(conversationId, null)
    }
  })

  it('accepts a decision that arrives from inside the announce callback', async () => {
    const { window } = harness()
    const conversationId = 'conv-relay-early-answer'
    // A short timeout turns a registration-order regression into a visible
    // denial instead of an infinitely pending promise.
    const approve = createLocalToolApproval({ conversationId, window, config: { policy: 'paranoid', timeoutMs: 60 } })
    setApprovalRelay(conversationId, (approval) => {
      resolvePendingApproval(approval.id, true, undefined, 'once')
      return true
    })
    try {
      await expect(approve(request(conversationId, 'call-a', 'execute_command'))).resolves.toEqual({ approved: true })
    } finally {
      setApprovalRelay(conversationId, null)
    }
  })

  it('denies on the spot when the client cannot be handed the card, and frees the slot', async () => {
    const { window } = harness()
    const conversationId = 'conv-relay-undeliverable'
    const delivered: string[] = []
    let accepting = false
    setApprovalRelay(conversationId, (approval) => { delivered.push(approval.id); return accepting })
    try {
      const approve = createLocalToolApproval({ conversationId, window, config: { policy: 'paranoid', timeoutMs: 5000 } })

      await expect(approve(request(conversationId, 'call-a', 'execute_command'))).resolves.toEqual({
        approved: false,
        message: '审批卡片无法送达该客户端，本次调用已按拒绝处理。',
      })
      expect(delivered).toHaveLength(1)

      // A denial that left the slot claimed would stall every later call in this
      // conversation, so the next request must still reach a willing client.
      accepting = true
      const second = approve(request(conversationId, 'call-b', 'write_file'))
      expect(delivered).toHaveLength(2)
      expect(resolvePendingApproval(delivered[1], true)).toBe(true)
      await expect(second).resolves.toEqual({ approved: true })
    } finally {
      setApprovalRelay(conversationId, null)
    }
  })

  it('covers one conversation only, and releasing restores the window path', async () => {
    const { window, sent } = harness()
    const owned = 'conv-relay-scoped'
    const foreign = 'conv-relay-foreign'
    const received: string[] = []
    setApprovalRelay(owned, (approval) => { received.push(approval.id); return true })
    try {
      const approveOwned = createLocalToolApproval({ conversationId: owned, window, config: { policy: 'paranoid', timeoutMs: 5000 } })
      const approveForeign = createLocalToolApproval({ conversationId: foreign, window, config: { policy: 'paranoid', timeoutMs: 5000 } })

      const pendingOwned = approveOwned(request(owned, 'call-a', 'execute_command'))
      const pendingForeign = approveForeign(request(foreign, 'call-b', 'execute_command'))

      expect(received).toHaveLength(1)
      expect(cardIds(sent)).toHaveLength(1)

      expect(resolvePendingApproval(cardIds(sent)[0], true)).toBe(true)
      setApprovalRelay(owned, null)
      expect(resolvePendingApproval(received[0], true)).toBe(true)
      await expect(pendingOwned).resolves.toEqual({ approved: true })
      await expect(pendingForeign).resolves.toEqual({ approved: true })

      // With the relay released, the next card goes back to the window.
      const pendingThird = approveOwned(request(owned, 'call-c', 'write_file'))
      expect(received).toHaveLength(1)
      expect(cardIds(sent)).toHaveLength(2)
      expect(resolvePendingApproval(cardIds(sent)[1], true)).toBe(true)
      await expect(pendingThird).resolves.toEqual({ approved: true })
    } finally {
      setApprovalRelay(owned, null)
    }
  })

  it('denies rather than auto-approving when neither window nor relay exists', async () => {
    const conversationId = 'conv-relay-absent'
    const approve = createLocalToolApproval({ conversationId, window: null, config: { policy: 'paranoid', timeoutMs: 5000 } })
    await expect(approve(request(conversationId, 'call-a', 'execute_command'))).resolves.toMatchObject({ approved: false })
  })
})
