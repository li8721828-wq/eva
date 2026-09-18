import { describe, expect, it } from 'vitest'
import { requiresApproval } from '../../src/main/services/tool-approval-policy'

describe('tool approval policy', () => {
  describe('off', () => {
    it('never asks for any tool', () => {
      expect(requiresApproval('write_file', 'off')).toBeNull()
      expect(requiresApproval('execute_command', 'off')).toBeNull()
      expect(requiresApproval('mcp__srv__tool', 'off')).toBeNull()
      expect(requiresApproval('browser_navigate', 'off')).toBeNull()
    })
  })

  describe('safe', () => {
    it('auto-approves read-only tools', () => {
      for (const t of ['read_file', 'list_directory', 'search_files', 'web_search', 'read_web_page', 'read_terminal', 'project_search']) {
        expect(requiresApproval(t, 'safe')).toBeNull()
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

    it('requires approval for browser-control tools', () => {
      expect(requiresApproval('browser_navigate', 'safe')).toBe('browser-control')
      expect(requiresApproval('browser_click', 'safe')).toBe('browser-control')
    })
  })

  describe('strict', () => {
    it('only auto-approves read-only tools, asks for everything else', () => {
      expect(requiresApproval('read_file', 'strict')).toBeNull()
      expect(requiresApproval('execute_command', 'strict')).toBe('terminal-command')
      expect(requiresApproval('write_file', 'strict')).toBe('workspace-write')
      // read_terminal is read-only, so strict also auto-approves it.
      expect(requiresApproval('read_terminal', 'strict')).toBeNull()
    })
  })

  describe('paranoid', () => {
    it('requires approval for every tool', () => {
      for (const t of ['read_file', 'list_directory', 'execute_command', 'browser_navigate', 'delegate_to_team']) {
        expect(requiresApproval(t, 'paranoid')).not.toBeNull()
      }
    })
  })
})
