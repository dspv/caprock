/**
 * What the sidebar lists under Open (every open tab, in the strip's order,
 * since 2026-11-05 for everyone): **Tree** ("Projects"), the projects, each
 * folded to a line and unfolding to its sessions — or **Flat** ("Tabs"), the
 * sessions running with no tab as one list, not by project. Chosen in
 * Settings → Appearance; kept per viewer, in this browser's storage. The
 * key is the one the toggle has used since 2026-10-13: 'on' is Tree, 'off'
 * Flat.
 *
 * The Projects | Tabs switch beside the sidebar's heading went on
 * 2026-11-05 (mockup V1): what it was for — the tabs in their order, each
 * with its key — is the Open section now, above either list, so the switch
 * only chose what sits under it, too small a choice for the heading. A new
 * viewer starts on Tree since that day, the layout the owner chose (Flat
 * from 2026-10-14, when a list in the tabs' order was the only way to see
 * the tabs as the strip has them).
 *
 * Nobody is switched without asking (2026-10-14). 0.116.0 read a missing key
 * as Flat, and so moved every viewer who had never touched the toggle off
 * the Tree they had used for months; a user wrote (translated): "a project
 * folder with its worktrees inside is more convenient". So a missing key is
 * resolved once and written down. Every viewer with no key gets Tree, and a
 * kept Flat stays Flat.
 */
import { useEffect, useState } from 'react'

export type SidebarMode = 'flat' | 'tree'

export const SIDEBAR_MODE_KEY = 'caprock.app.sidebar-grouped'
/** Said on window when the mode changes, so the sidebar and Settings agree at once. */
export const SIDEBAR_MODE_EVENT = 'caprock:sidebar-mode'

/**
 * The kept mode. With none kept, Tree is written down at once, so nothing
 * the app writes next changes the answer.
 */
export function loadSidebarMode(): SidebarMode {
  try {
    const v = localStorage.getItem(SIDEBAR_MODE_KEY)
    if (v === 'on') return 'tree'
    if (v === 'off') return 'flat'
    localStorage.setItem(SIDEBAR_MODE_KEY, 'on')
    return 'tree'
  } catch {
    return 'tree'
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
