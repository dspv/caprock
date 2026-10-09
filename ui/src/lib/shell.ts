/**
 * The Tauri shell's commands, for the app's native surfaces (WP-10): the
 * menu bar or tray, the badge and the global hotkey. Each is a no-op outside
 * the shell, and the shell grants them to the daemon's page alone
 * (app/README.md § What a page may call).
 */
import { isTauri } from './appmode'
import type { AppUpdateInfo } from './appupdate'

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

/** The event the shell dispatches before it brings the window up from the tray or the hotkey. */
export const SHOWN_EVENT = 'caprock:shown'

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
  /** From the menu bar popover: hide it and bring the window up, on a session when one is named. */
  trayOpen: (session?: string) => shellInvoke<void>('tray_open', { session: session ?? null }),
  /** From the menu bar popover: the height its content needs (the shell clamps it). */
  trayFit: (height: number) => shellInvoke<void>('tray_fit', { height }),
  /** From the menu bar popover: hide it. */
  trayHide: () => shellInvoke<void>('tray_hide'),
  /** The app's updater (F20): its version, whether it can update itself, where it stands. */
  updateStatus: () => shellInvoke<AppUpdateInfo>('app_update_status'),
  /** Fetch latest.json once. */
  updateCheck: () => shellInvoke<AppUpdateInfo>('app_update_check'),
  /** Download, verify, install and restart; resolves only when it did not. */
  updateInstall: () => shellInvoke<AppUpdateInfo>('app_update_install'),
  /** The first-launch question about update checks was answered. */
  updateAsked: () => shellInvoke<void>('app_update_asked'),
  /** Open an http, https or mailto link in the default browser or mail app; rejects on any other scheme. */
  openExternal: (url: string) => shellInvoke<void>('open_external', { url }),
}
