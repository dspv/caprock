/**
 * Leaving Settings: what its × and Escape do (screens/Status.tsx).
 *
 * In the desktop app Settings is the Dashboard tab of the strip showing
 * `#/settings`, and the way out was that tab's small ×. The page itself had
 * none, and the owner could not see how to get out of it (2026-10-10). The
 * page's own × does exactly what the tab's does: the app shell provides its
 * `closeDashboard` here (screens/AppShell.tsx), so there is one way of
 * closing Settings, not two.
 *
 * In a browser there is no strip and no tab to close; the default goes back
 * to the screen Settings was opened from, or to Now when it was opened
 * directly.
 */
import { createContext, useContext } from 'react'
import { parseHash } from './router'

let before = '#/'

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', (e) => {
    let from = ''
    try { from = new URL(e.oldURL).hash } catch { return }
    if (parseHash(location.hash).name === 'settings' && parseHash(from).name !== 'settings') before = from || '#/'
  })
}

/** The browser's way out of Settings: back to the screen it was opened from. */
export function leaveSettings(): void {
  location.hash = before
}

export const CloseSettingsContext = createContext<() => void>(leaveSettings)

/** What closes Settings here: the app's Dashboard tab, or the screen before it. */
export function useCloseSettings(): () => void {
  return useContext(CloseSettingsContext)
}

/**
 * Whether an Escape aimed at `target` belongs to the page rather than to a
 * field: text being typed, a select being changed, or an editor keep it.
 */
export function escapeLeavesPage(e: Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'isComposing' | 'target'>): boolean {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return false
  const t = e.target as HTMLElement | null
  if (!t || typeof t.closest !== 'function') return true
  if (t.isContentEditable) return false
  return !t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
}
