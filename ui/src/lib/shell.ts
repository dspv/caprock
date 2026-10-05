/**
 * The Tauri shell's commands, for the app's native surfaces (WP-10): the
 * menu bar or tray, the badge and the global hotkey. Each is a no-op outside
 * the shell, and the shell grants them to the daemon's page alone
 * (app/README.md § What a page may call).
 */
import { isTauri } from './appmode'

interface TauriInternals {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
}

/** A session waiting on you, as the tray lists it. */
export interface TrayWaiting {
  id: string
  label: string
}

/** What the menu bar or tray shows (app/src-tauri/src/tray.rs). */
export interface TrayView {
  title: string
  tooltip: string
  lines: string[]
  waiting: TrayWaiting[]
}

/** The global hotkey as the shell holds it (app/src-tauri/src/hotkey.rs). */
export interface HotkeyStatus {
  accelerator: string | null
  default: string
  registered: boolean
  error: string | null
  wayland: boolean
}

/** The event the shell dispatches when a waiting session is clicked in the tray. */
export const OPEN_SESSION_EVENT = 'caprock:open-session'

function shellInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
  if (!isTauri() || !internals) return Promise.reject(new Error('not in the desktop app'))
  return internals.invoke<T>(cmd, args ?? {})
}

export const shell = {
  setTray: (view: TrayView) => shellInvoke<void>('set_tray', { view }),
  setBadge: (count: number) => shellInvoke<void>('set_badge', { count }),
  hotkeyStatus: () => shellInvoke<HotkeyStatus>('hotkey_status'),
  /** `null` turns the hotkey off. Rejects with the system's reason when it refuses one. */
  registerHotkey: (accelerator: string | null) => shellInvoke<HotkeyStatus>('register_hotkey', { accelerator }),
}
