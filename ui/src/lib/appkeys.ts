/**
 * The app's keyboard map (F09, WP-04).
 *
 * The app's shortcuts use Cmd on macOS and Ctrl+Shift on Windows and Linux,
 * so they never collide with what a terminal needs: Ctrl+C, Ctrl+W in a
 * shell, Option as Meta. Ctrl+Shift+C and Ctrl+Shift+V stay the terminal's
 * copy and paste off macOS, so neither letter is bound here.
 *
 * One pure function decides, so the terminal's key handler and the window's
 * listener ask the same question and can never disagree about whose key it is.
 */

/** Dispatched on window by ⌘F; the focused pane of the tab in front opens its find bar (F16). */
export const FIND_EVENT = 'caprock:terminal-find'

export type AppCommand =
  | { kind: 'new-shell' }
  | { kind: 'new-agent' }
  | { kind: 'quick-chat' }
  | { kind: 'add-project' }
  | { kind: 'detach-tab' }
  | { kind: 'palette' }
  | { kind: 'inspector' }
  | { kind: 'sidebar' }
  | { kind: 'dashboard' }
  | { kind: 'next-tab' }
  | { kind: 'prev-tab' }
  | { kind: 'tab'; index: number }
  | { kind: 'split'; direction: 'row' | 'column' }
  | { kind: 'next-pane' }
  | { kind: 'prev-pane' }
  | { kind: 'next-waiting' }
  | { kind: 'find' }
  | { kind: 'settings' }

/** The subset of a KeyboardEvent the map reads. */
export interface KeyLike {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/** The letter or digit a key stands for, independent of Shift and layout quirks. */
function baseKey(e: KeyLike): string {
  if (e.code?.startsWith('Key')) return e.code.slice(3).toLowerCase()
  if (e.code?.startsWith('Digit')) return e.code.slice(5)
  if (e.code === 'BracketLeft') return '['
  if (e.code === 'BracketRight') return ']'
  if (e.code === 'Backslash') return '\\'
  return e.key.length === 1 ? e.key.toLowerCase() : e.key
}

/** Which app command a key press is, or null when it belongs to the page or the terminal. */
export function matchAppShortcut(e: KeyLike, isMac: boolean): AppCommand | null {
  // ⌥⌘N (Ctrl+Alt+Shift+N off macOS) is Quick chat: the one chord with
  // Option, which is otherwise the terminal's Meta and never the app's.
  if (e.altKey) {
    const quick = isMac ? e.metaKey && !e.ctrlKey && !e.shiftKey : e.ctrlKey && e.shiftKey && !e.metaKey
    return quick && baseKey(e) === 'n' ? { kind: 'quick-chat' } : null
  }
  // Ctrl+Tab and Ctrl+Shift+Tab cycle tabs everywhere, as in every tabbed app.
  if (e.key === 'Tab' && e.ctrlKey && !e.metaKey) return e.shiftKey ? { kind: 'prev-tab' } : { kind: 'next-tab' }
  const k = baseKey(e)
  if (isMac) {
    if (!e.metaKey || e.ctrlKey) return null
    if (e.shiftKey) {
      switch (k) {
        case 'n': return { kind: 'new-agent' }
        case 'd': return { kind: 'dashboard' }
        case '[': return { kind: 'prev-tab' }
        case ']': return { kind: 'next-tab' }
        case 'e': return { kind: 'split', direction: 'column' }
        default: return null
      }
    }
    // ⌘[ and ⌘] move between panes, as in iTerm; off macOS Ctrl+Shift+[ ]
    // already cycle tabs, so panes are reached from the palette there.
    if (k === '[') return { kind: 'prev-pane' }
    if (k === ']') return { kind: 'next-pane' }
    return plain(k)
  }
  // Off macOS every app shortcut is Ctrl+Shift, and the terminal keeps Ctrl alone.
  if (!e.ctrlKey || !e.shiftKey || e.metaKey) return null
  switch (k) {
    case 'n': return { kind: 'new-agent' }
    case 'd': return { kind: 'dashboard' }
    case '[': return { kind: 'prev-tab' }
    case ']': return { kind: 'next-tab' }
    // C and V are the terminal's copy and paste: never ours.
    case 'c':
    case 'v':
      return null
    default:
      return plain(k)
  }
}

function plain(k: string): AppCommand | null {
  switch (k) {
    case 't': return { kind: 'new-shell' }
    // ⌘, is Settings in every Mac app.
    case ',': return { kind: 'settings' }
    case 'o': return { kind: 'add-project' }
    case 'w': return { kind: 'detach-tab' }
    case 'k': return { kind: 'palette' }
    case 'i': return { kind: 'inspector' }
    case '\\': return { kind: 'sidebar' }
    case 'e': return { kind: 'split', direction: 'row' }
    case 'j': return { kind: 'next-waiting' }
    case 'f': return { kind: 'find' }
    default:
      if (/^[1-9]$/.test(k)) return { kind: 'tab', index: Number(k) - 1 }
      return null
  }
}

/** How a shortcut is written in a menu or a tooltip on this platform. */
export function shortcutLabel(keys: string, opts: { shift?: boolean } = {}, isMac = true): string {
  if (isMac) return `${opts.shift ? '⇧' : ''}⌘${keys}`
  return `Ctrl+Shift+${keys}`
}

/** The app's keys as the shortcuts sheet lists them, macOS spelling; off
 *  macOS each is Ctrl+Shift with the same key (docs/app.md § Keyboard). */
export const SHORTCUTS: [keys: string, does: string][] = [
  ['⇧⌘N', 'New agent'],
  ['⌥⌘N', 'Quick chat: no folder, the agent and model used last'],
  ['⌘T', 'New shell in the folder of the tab'],
  ['⌘O', 'Add a project'],
  ['⌘K', 'Command palette'],
  ['⌘J', 'Next session waiting on you'],
  ['⌘1–8, ⌘9', 'A tab by position; the last tab'],
  ['⌃Tab, ⇧⌘[ ]', 'Next and previous tab'],
  ['⌘W', 'Close the tab or pane — the session keeps going'],
  ['⌘E, ⇧⌘E', 'Split: a new shell beside, below'],
  ['⌘[ ]', 'Previous and next pane'],
  ['⌘F', 'Find in the terminal'],
  ['⌘I', 'Inspector'],
  ['⌘\\', 'Hide or show the sidebar'],
  ['⇧⌘D', 'Dashboard'],
  ['⌘,', 'Settings'],
  ['⌘R', 'Reload the window'],
]
