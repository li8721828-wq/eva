import fs from 'fs/promises'
import path from 'path'
import { shell } from 'electron'
import { trustedIpcMain as ipcMain } from './trusted-ipc'
import { IPC } from '../../shared/ipc-channels'
import type { SkillInventory, SkillRootKind } from '../../shared/types/skill'
import { getStorage } from '../storage'
import { conversationWorkspacePath } from './conversation'
import { invalidateSkillCache, resolveSkillRoots, scanSkillInventory } from '../services/skill-service'
import { recordActivity } from '../services/activity-log'

/**
 * Skills are read straight from their folders, so this surface only reports what
 * is on disk and turns a name on or off. There is nothing to import or delete here.
 */
export function registerSkillHandlers(): void {
  ipcMain.handle(IPC.SKILL_LIST, async (_event, workspacePath?: string): Promise<SkillInventory> =>
    scanSkillInventory(workspacePath))

  // The composer lists skills for the conversation it types into, and only the main
  // process may resolve which workspace that conversation belongs to.
  ipcMain.handle(IPC.SKILL_INVENTORY_FOR_CONVERSATION, async (_event, conversationId?: string): Promise<SkillInventory> => {
    const id = typeof conversationId === 'string' ? conversationId.trim() : ''
    const conversation = id ? await getStorage().conversations.getConversation(id) : null
    const inventory = scanSkillInventory(conversation
      ? conversationWorkspacePath(conversation, getStorage().config.get('workspacePath'))
      : undefined)
    return { ...inventory, skills: inventory.skills.filter((skill) => skill.enabled) }
  })

  ipcMain.handle(IPC.SKILL_RESCAN, async (_event, workspacePath?: string): Promise<SkillInventory> => {
    invalidateSkillCache()
    return scanSkillInventory(workspacePath)
  })

  ipcMain.handle(IPC.SKILL_TOGGLE, async (_event, name: string, enabled: boolean, workspacePath?: string): Promise<SkillInventory> => {
    const skillName = typeof name === 'string' ? name.trim() : ''
    if (!skillName) throw new Error('A skill name is required.')
    getStorage().skills.setDisabled(skillName, !enabled)
    invalidateSkillCache()
    void recordActivity({
      category: 'system',
      action: enabled ? 'skill.enabled' : 'skill.disabled',
      status: 'success',
      summary: `${enabled ? 'Enabled' : 'Disabled'} skill "${skillName}".`,
    })
    return scanSkillInventory(workspacePath)
  })

  // The renderer chooses which cataloged root to reveal; it never supplies a path.
  ipcMain.handle(IPC.SKILL_OPEN_FOLDER, async (_event, kind: SkillRootKind, workspacePath?: string): Promise<string> => {
    const roots = resolveSkillRoots(workspacePath)
    const root = kind === 'project' ? roots.project : roots.global
    if (!root) return 'No workspace is selected, so there is no project skill folder yet.'
    await fs.mkdir(root, { recursive: true })
    return shell.openPath(path.normalize(root))
  })
}
