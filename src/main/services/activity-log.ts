import { BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { ActivityLogEntry, CreateActivityLogEntry } from '../../shared/types/activity'
import { getStorage } from '../storage'

function broadcast(entry: ActivityLogEntry, target?: BrowserWindow | null): void {
  const windows = target ? [target] : BrowserWindow.getAllWindows()
  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC.ACTIVITY_STREAM, entry)
    }
  }
}

export async function recordActivity(input: CreateActivityLogEntry, target?: BrowserWindow | null): Promise<ActivityLogEntry | null> {
  try {
    const entry = await getStorage().activity.append(input)
    broadcast(entry, target)
    return entry
  } catch (error) {
    console.warn('Unable to record activity:', error)
    return null
  }
}
