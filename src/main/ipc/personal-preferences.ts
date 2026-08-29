import { trustedIpcMain as ipcMain } from './trusted-ipc'
import { IPC } from '../../shared/ipc-channels'
import type { PersonalPreference, PersonalPreferenceSettings } from '../../shared/types/personal-preferences'
import { getStorage } from '../storage'

export function registerPersonalPreferenceHandlers(): void {
  ipcMain.handle(IPC.PREFERENCE_LIST, async (): Promise<PersonalPreference[]> => getStorage().personalPreferences.list())
  ipcMain.handle(IPC.PREFERENCE_SETTINGS_GET, async (): Promise<PersonalPreferenceSettings> => getStorage().personalPreferences.getSettings())
  ipcMain.handle(IPC.PREFERENCE_SETTINGS_SAVE, async (_event, settings: Partial<PersonalPreferenceSettings>): Promise<PersonalPreferenceSettings> => getStorage().personalPreferences.saveSettings(settings))
  ipcMain.handle(IPC.PREFERENCE_DELETE, async (_event, id: string): Promise<void> => getStorage().personalPreferences.remove(id))
  ipcMain.handle(IPC.PREFERENCE_CLEAR, async (): Promise<void> => getStorage().personalPreferences.clear())
}
