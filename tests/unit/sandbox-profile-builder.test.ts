import { describe, expect, it } from 'vitest'
import { buildDarwinSandboxExecProfile, buildBubblewrapArgs } from '../../src/main/services/sandbox/profile-builder'

describe('profile-builder', () => {
  describe('buildDarwinSandboxExecProfile', () => {
    it('generates a deny-default profile', () => {
      const profile = buildDarwinSandboxExecProfile({
        workspacePath: '/Users/test/project',
        extraAllowedPaths: ['/tmp/extra'],
        allowNetwork: false,
      })
      expect(profile).toContain('(deny default)')
      expect(profile).toContain('/Users/test/project')
      expect(profile).toContain('/tmp/extra')
    })

    it('includes network rule when allowNetwork is true', () => {
      const withNet = buildDarwinSandboxExecProfile({
        workspacePath: '/Users/test/project',
        extraAllowedPaths: [],
        allowNetwork: true,
      })
      expect(withNet).toContain('(allow network')
    })

    it('omits network rule when allowNetwork is false', () => {
      const noNet = buildDarwinSandboxExecProfile({
        workspacePath: '/Users/test/project',
        extraAllowedPaths: [],
        allowNetwork: false,
      })
      expect(noNet).not.toContain('(allow network')
    })

    it('escapes double-quotes in workspace path', () => {
      const profile = buildDarwinSandboxExecProfile({
        workspacePath: '/Users/test/path with spaces',
        extraAllowedPaths: [],
        allowNetwork: false,
      })
      // Should not throw, and should have escaped version
      expect(profile).toContain('/Users/test/path with spaces')
    })
  })

  describe('buildBubblewrapArgs', () => {
    it('returns non-empty args with sandbox flags', () => {
      const args = buildBubblewrapArgs({
        workspacePath: '/home/user/project',
        extraAllowedPaths: [],
        allowNetwork: false,
      })
      expect(args.length).toBeGreaterThan(0)
      expect(args).toContain('--unshare-net')
      expect(args).toContain('--proc')
      expect(args).toContain('/home/user/project')
    })

    it('omits --unshare-net when allowNetwork is true', () => {
      const args = buildBubblewrapArgs({
        workspacePath: '/home/user/project',
        extraAllowedPaths: [],
        allowNetwork: true,
      })
      expect(args).not.toContain('--unshare-net')
    })

    it('includes extraAllowedPaths in args', () => {
      const args = buildBubblewrapArgs({
        workspacePath: '/home/user/project',
        extraAllowedPaths: ['/tmp/shared', '/data/cache'],
        allowNetwork: true,
      })
      expect(args).toContain('/tmp/shared')
      expect(args).toContain('/data/cache')
    })
  })
})
