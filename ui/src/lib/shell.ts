/**
 * The Tauri shell's commands, for the app's native surfaces (WP-10): the
 * menu bar or tray, the badge and the global hotkey. Each is a no-op outside
 * the shell, and the shell grants them to the daemon's page alone
 * (app/README.md § What a page may call).
 */
import { isTauri } from './appmode'
import type { AppUpdateInfo } from './appupdate'
import type { BrowserAct } from './browsertab'

interface TauriInternals {
  invoke: <T>(cmd: string, args?: Record<string, unknown> | Uint8Array) => Promise<T>
}

/** A session waiting on you, as the tray lists it. */
export interface TrayWaiting {
  id: string
  label: string
  /** May show the menu bar panel by itself (the peek, macOS); a shell that predates it ignores it. */
  peek?: boolean
}

/** What the menu bar or tray shows (app/src-tauri/src/tray.rs). */
export interface TrayView {
  title: string
  tooltip: string
  lines: string[]
  /** Needs you: what the badge and the count beside the icon count. */
  waiting: TrayWaiting[]
  /** Done, nothing needed: a submenu (a shell that predates it ignores it). */
  done?: TrayWaiting[]
  /** The session the window's front tab shows, sent only with the peek on: no peek for it while the window is in front. */
  shown?: string
}

/** `dictation_status` (app/src-tauri/src/dictate.rs). */
export interface DictationStatus {
  supported: boolean
  /** Without support: `unsupported`, `unbundled` (macOS), `no-model`, `downloading`, `cpu-unsupported` (Windows, Linux). */
  reason?: string
  /** Who listens; a shell that predates it is Apple's. */
  engine?: 'apple' | 'whisper'
}

export type VoiceModelId = 'small' | 'base'

/** `voice_model_status` (app/src-tauri/src/voicemodel.rs). */
export interface VoiceModelStatus {
  /** Windows and Linux; false on a Mac. */
  offered: boolean
  /** This processor can run the model (AVX2, FMA and F16C on x86-64). */
  cpu_ok: boolean
  dir?: string
  installed?: VoiceModelId
  path?: string
  /** Each model with the speech detector's bytes added: what a download costs. */
  models: { id: VoiceModelId; file: string; bytes: number }[]
  download?: { model: VoiceModelId; done: number; total: number }
  error?: { model: VoiceModelId; error: 'checksum' | 'network' | 'disk' }
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

/**
 * The event the shell dispatches when a notification about no session is
 * clicked: its detail is the route to open, a private module's `#/x/<id>`.
 */
export const OPEN_ROUTE_EVENT = 'caprock:open-route'

/** The routes a notification may open: a private module's screen (ADR-076), or a Talk a hold waits in (ADR-110). */
export function notifyRoute(route: unknown): string | null {
  return typeof route === 'string' && (/^#\/x\/[a-z][a-z0-9-]{0,31}$/.test(route) || /^#\/talks\/t_[0-9a-f]{24}$/.test(route)) ? route : null
}

/** The event the shell dispatches before it brings the window up from the tray or the hotkey. */
export const SHOWN_EVENT = 'caprock:shown'

/**
 * The event the macOS shell dispatches for File -> Close Tab, the menu item
 * that holds ⌘W: the menu takes the key before the page sees it, so the page
 * hears it as this instead (app/src-tauri/src/main.rs, `menu`).
 */
export const CLOSE_TAB_EVENT = 'caprock:close-tab'

/** A command's arguments, or for the screenshot commands the raw bytes of an image. */
type Args = Record<string, unknown> | Uint8Array

function shellInvoke<T>(cmd: string, args?: Args): Promise<T> {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
  if (!isTauri() || !internals) return Promise.reject(new Error('not in the desktop app'))
  return internals.invoke<T>(cmd, args ?? {})
}

export const shell = {
  setTray: (view: TrayView) => shellInvoke<void>('set_tray', { view }),
  setBadge: (count: number) => shellInvoke<void>('set_badge', { count }),
  /** The webview's zoom, which the shell clamps to 0.8–1.6 (lib/uiscale.ts). */
  setZoom: (scale: number) => shellInvoke<void>('set_zoom', { scale }),
  hotkeyStatus: () => shellInvoke<HotkeyStatus>('hotkey_status'),
  /** `null` turns the hotkey off. Rejects with the system's reason when it refuses one. */
  registerHotkey: (accelerator: string | null) => shellInvoke<HotkeyStatus>('register_hotkey', { accelerator }),
  /** From the menu bar popover: hide it and bring the window up, on a session when one is named. */
  trayOpen: (session?: string) => shellInvoke<void>('tray_open', { session: session ?? null }),
  /** From the menu bar popover: the height its content needs (the shell clamps it). */
  trayFit: (height: number) => shellInvoke<void>('tray_fit', { height }),
  /** From the menu bar popover: hide it; `answered` after Approve or Deny in a peek (no quiet minute follows). */
  trayHide: (answered = false) => shellInvoke<void>('tray_hide', { answered }),
  /** The app's updater (F20): its version, whether it can update itself, where it stands. */
  updateStatus: () => shellInvoke<AppUpdateInfo>('app_update_status'),
  /** Fetch latest.json once. */
  updateCheck: () => shellInvoke<AppUpdateInfo>('app_update_check'),
  /** Download and verify, and hold it for a later install (Update automatically). */
  updateDownload: (known?: string) => shellInvoke<AppUpdateInfo>('app_update_download', known ? { known } : {}),
  /** Download, verify, install and restart; resolves only when it did not.
   *  `known`: the daemon's newest release; an older bundle is not installed in its name. */
  updateInstall: (known?: string) => shellInvoke<AppUpdateInfo>('app_update_install', known ? { known } : {}),
  /** The first-launch question about update checks was answered. */
  updateAsked: () => shellInvoke<void>('app_update_asked'),
  /** Open an http, https or mailto link in the default browser or mail app; rejects on any other scheme. */
  openExternal: (url: string) => shellInvoke<void>('open_external', { url }),
  /** The system's folder chooser (New project): the folder picked, or null when cancelled. Opens at `start` when it is a folder. */
  pickFolder: (start?: string) => shellInvoke<string | null>('pick_folder', { start: start ?? null }),
  /** A PNG onto the system clipboard, through the shell rather than the webview (app/src-tauri/src/capture.rs). */
  clipboardImage: (png: Uint8Array) => shellInvoke<void>('clipboard_image', png),
  /** The app's own page as PNG bytes: the webview's drawing, never the screen. */
  captureWindow: () => shellInvoke<ArrayBuffer>('capture_webview'),
  /** An image file from the last drop on the window (png/jpg/jpeg/gif/webp, at most 10 MB). */
  readDroppedImage: (path: string) => shellInvoke<ArrayBuffer>('read_dropped_image', { path }),
  /** Any regular file from the last drop on the window (at most 10 MB, Attach's limit): a document dropped on a chat. Missing in an app built before it; the caller falls back to the path. */
  readDroppedFile: (path: string) => shellInvoke<ArrayBuffer>('read_dropped_file', { path }),
  /** The text of a .md, .markdown or .txt file from the last drop on the window (at most 1 MiB, UTF-8): a template project's brief. */
  readDroppedText: (path: string) => shellInvoke<string>('read_dropped_text', { path }),
  /** macOS: launch or bring forward the installed Caprock Mail preview; false when there is none (and on every other OS). */
  openMailApp: () => shellInvoke<boolean>('open_mail_app'),
  /** A second window of the app on the daemon's `/?mail=1`, focused when already open; false with no daemon to load it from. */
  openMailWindow: () => shellInvoke<boolean>('open_mail_window'),
  /** A browser tab's page: a window of its own the shell lays over the tab (ADR-075, app/src-tauri/src/browser.rs). */
  browserTab: (id: string, act: BrowserAct) => shellInvoke<void>('browser_tab', { id, act }),
  /** One line in the app's own log on this machine (`app.log` in the data directory), never sent anywhere: why the window had to recover. */
  appLog: (message: string) => shellInvoke<void>('app_log', { message }),
  /** Whether the chat's voice input works here, and who listens: Apple on a Mac from the app bundle (ADR-102), whisper.cpp on Windows and Linux once the voice model is in (ADR-104); app/src-tauri/src/dictate.rs. */
  dictationStatus: () => shellInvoke<DictationStatus>('dictation_status'),
  /** Listen for `lang` (BCP-47), on this computer only; its words come as `caprock:dictation` events with the id returned. */
  dictationStart: (lang: string) => shellInvoke<number>('dictation_start', { lang }),
  /** Stop listening: the final words follow; with `cancel`, only the end. */
  dictationStop: (id: number, cancel = false) => shellInvoke<void>('dictation_stop', { id, cancel }),
  /** Settings → Voice input on Windows and Linux (ADR-104, app/src-tauri/src/voicemodel.rs): the voice model's state. */
  voiceModelStatus: () => shellInvoke<VoiceModelStatus>('voice_model_status'),
  /** Downloads `model` from huggingface.co, SHA-256 checked; returns at once and the status follows it. Only on the user's click (rule 4). */
  voiceModelDownload: (model: VoiceModelId) => shellInvoke<void>('voice_model_download', { model }),
  voiceModelCancel: () => shellInvoke<void>('voice_model_cancel'),
  /** Deletes the model and the speech detector; the mic then offers the download again. */
  voiceModelRemove: () => shellInvoke<void>('voice_model_remove'),
  /** The installed model in the file manager. */
  voiceModelReveal: () => shellInvoke<void>('voice_model_reveal'),
}

/**
 * Whether the app can capture its own window: macOS (WKWebView) and Windows
 * (WebView2). Linux's WebKitGTK path is not built, so the button is hidden
 * there, and in a browser tab, which has no shell at all.
 */
export function captureSupported(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return isTauri() && /Mac|Windows/.test(ua) && !/Linux|Android/.test(ua)
}
