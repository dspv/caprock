/**
 * How the sidebar lists the sessions: **Tree** ("Projects" on the switch),
 * projects with their sessions under them, each row with its tab's ⌘N — or
 * **Flat** ("Tabs"), one list in the tab strip's order, each row with its
 * tab's ⌘N and its project's tag, sessions with no tab after them. Chosen in
 * Settings → Appearance or with the Projects | Tabs switch in the sidebar's
 * heading; kept per viewer, in this browser's storage. The key is the one the
 * toggle has used since 2026-10-13: 'on' is Tree, 'off' Flat.
 *
 * Nobody is switched without asking (2026-10-14). 0.116.0 read a missing key
 * as Flat, and so moved every viewer who had never touched the toggle off
 * the Tree they had used for months; a user wrote (translated): "a project
 * folder with its worktrees inside is more convenient". So a missing key is
 * resolved once and written down: a viewer this browser already knows — the
 * app has kept its tabs, its preferences or a theme here before — keeps
 * Tree; a viewer with none of that is new and starts on Flat.
 */
import { useEffect, useState } from 'react'

export type SidebarMode = 'flat' | 'tree'

export const SIDEBAR_MODE_KEY = 'caprock.app.sidebar-grouped'
/** Said on window when the mode changes, so the sidebar and Settings agree at once. */
export const SIDEBAR_MODE_EVENT = 'caprock:sidebar-mode'

/**
 * Keys the app has written for a long time, and only after someone used it:
 * the open tabs and the app's own preferences (since 2026-10-05), the
 * order and hidden rows set by hand, terminal settings, a chosen theme. Any
 * one of them means this browser has used Caprock before the switch had a
 * default of its own.
 */
export const EXISTING_VIEWER_KEYS = [
  'caprock.app.workspace.v1',
  'caprock.app.ui',
  'caprock.app.hidden-projects',
  'caprock.app.hidden-sessions',
  'caprock.app.row-order',
  'caprock.app.terminal',
  'caprock.app.project-folds',
  'caprock-theme',
  'caprock-theme-mode',
] as const

/** Whether this browser has used Caprock before: see EXISTING_VIEWER_KEYS. */
export function isExistingViewer(get: (k: string) => string | null = (k) => localStorage.getItem(k)): boolean {
  return EXISTING_VIEWER_KEYS.some((k) => get(k) !== null)
}

/**
 * The kept mode. With none kept, the default for this viewer (Tree for one
 * this browser already knows, Flat for a new one) is written down at once, so
 * the tabs and preferences the app writes next never change the answer.
 */
export function loadSidebarMode(): SidebarMode {
  try {
    const v = localStorage.getItem(SIDEBAR_MODE_KEY)
    if (v === 'on') return 'tree'
    if (v === 'off') return 'flat'
    const mode: SidebarMode = isExistingViewer() ? 'tree' : 'flat'
    localStorage.setItem(SIDEBAR_MODE_KEY, mode === 'tree' ? 'on' : 'off')
    return mode
  } catch {
    return 'flat'
  }
}

export function saveSidebarMode(mode: SidebarMode) {
  try { localStorage.setItem(SIDEBAR_MODE_KEY, mode === 'tree' ? 'on' : 'off') } catch { /* for this page only */ }
  window.dispatchEvent(new CustomEvent(SIDEBAR_MODE_EVENT, { detail: mode }))
}

export function useSidebarMode(): [SidebarMode, (mode: SidebarMode) => void] {
  const [mode, setMode] = useState<SidebarMode>(loadSidebarMode)
  useEffect(() => {
    const reload = () => setMode(loadSidebarMode())
    const onEvent = (e: Event) => setMode((e as CustomEvent<SidebarMode>).detail ?? loadSidebarMode())
    const onStorage = (e: StorageEvent) => { if (e.key === SIDEBAR_MODE_KEY) reload() }
    window.addEventListener(SIDEBAR_MODE_EVENT, onEvent)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(SIDEBAR_MODE_EVENT, onEvent)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return [mode, (m: SidebarMode) => { setMode(m); saveSidebarMode(m) }]
}
