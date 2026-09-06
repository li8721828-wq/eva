import { trustedIpcMain as ipcMain } from './trusted-ipc'
import { IPC } from '../../shared/ipc-channels'
import fs from 'fs/promises'
import { dialog } from 'electron'
import type { PersonalPreference, PersonalPreferenceImportOptions, PersonalPreferenceImportResult, PersonalPreferenceSettings } from '../../shared/types/personal-preferences'
import { getStorage } from '../storage'
import { recordActivity } from '../services/activity-log'

const MAX_PROFILE_SIZE = 256 * 1024

export function registerPersonalPreferenceHandlers(): void {
  ipcMain.handle(IPC.PREFERENCE_LIST, async (): Promise<PersonalPreference[]> => getStorage().personalPreferences.list())
  ipcMain.handle(IPC.PREFERENCE_SETTINGS_GET, async (): Promise<PersonalPreferenceSettings> => getStorage().personalPreferences.getSettings())
  ipcMain.handle(IPC.PREFERENCE_SETTINGS_SAVE, async (_event, settings: Partial<PersonalPreferenceSettings>): Promise<PersonalPreferenceSettings> => getStorage().personalPreferences.saveSettings(settings))
  ipcMain.handle(IPC.PREFERENCE_DELETE, async (_event, id: string): Promise<void> => getStorage().personalPreferences.remove(id))
  ipcMain.handle(IPC.PREFERENCE_CLEAR, async (): Promise<void> => getStorage().personalPreferences.clear())
  ipcMain.handle(IPC.PREFERENCE_EXPORT, async (): Promise<string | null> => {
    const selection = await dialog.showSaveDialog({
      title: '导出 Eva 偏好配置',
      defaultPath: `eva-preferences-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'Eva 偏好配置', extensions: ['json'] }],
    })
    if (selection.canceled || !selection.filePath) return null
    await fs.writeFile(selection.filePath, `${JSON.stringify(getStorage().personalPreferences.exportProfile(), null, 2)}\n`, 'utf8')
    void recordActivity({ category: 'system', action: 'preferences.exported', status: 'success', summary: 'Exported personal preference profile.' })
    return selection.filePath
  })
  ipcMain.handle(IPC.PREFERENCE_IMPORT, async (_event, options: PersonalPreferenceImportOptions): Promise<PersonalPreferenceImportResult | null> => {
    if (!options || (options.mode !== 'merge' && options.mode !== 'replace')) throw new Error('导入选项无效。')
    const selection = await dialog.showOpenDialog({
      title: '导入 Eva 偏好配置',
      filters: [{ name: 'Eva 偏好配置', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (selection.canceled || !selection.filePaths[0]) return null
    const data = await fs.readFile(selection.filePaths[0])
    if (data.byteLength > MAX_PROFILE_SIZE) throw new Error('偏好配置文件不能超过 256 KB。')
    let profile: unknown
    try {
      profile = JSON.parse(data.toString('utf8'))
    } catch {
      throw new Error('偏好配置文件不是有效的 JSON。')
    }
    const result = getStorage().personalPreferences.importProfile(profile, options)
    void recordActivity({ category: 'system', action: 'preferences.imported', status: 'success', summary: `Imported ${result.imported} personal preferences.` })
    return result
  })
}
