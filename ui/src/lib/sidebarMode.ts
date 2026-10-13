/**
 * How the sidebar lists the sessions (owner, 2026-10-14): **Flat**, the
 * default — one list in the tab strip's order, each row with its tab's ⌘N
 * and its project's tag, sessions with no tab after them — or **Tree**,
 * projects with their sessions under them, each row still with its tab's
 * ⌘N. Chosen in Settings → Appearance or with the folder toggle beside the
 * sidebar's heading; kept per viewer, in this browser's storage. The key is
 * the one the toggle has used since 2026-10-13: 'on' was Tree, 'off' Flat,
 * and a viewer who never touched it gets the new default, Flat.
 */
import { useEffect, useState } from 'react'

export type SidebarMode = 'flat' | 'tree'

export const SIDEBAR_MODE_KEY = 'caprock.app.sidebar-grouped'
/** Said on window when the mode changes, so the sidebar and Settings agree at once. */
export const SIDEBAR_MODE_EVENT = 'caprock:sidebar-mode'

export function loadSidebarMode(): SidebarMode {
  try { return localStorage.getItem(SIDEBAR_MODE_KEY) === 'on' ? 'tree' : 'flat' } catch { return 'flat' }
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
