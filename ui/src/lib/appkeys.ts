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

export type AppCommand =
  | { kind: 'new-shell' }
  | { kind: 'new-agent' }
  | { kind: 'add-project' }
  | { kind: 'detach-tab' }
  | { kind: 'palette' }
  | { kind: 'inspector' }
  | { kind: 'sidebar' }
  | { kind: 'dashboard' }
  | { kind: 'next-tab' }
  | { kind: 'prev-tab' }
  | { kind: 'tab'; index: number }

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
  if (e.altKey) return null
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
        default: return null
      }
    }
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
    case 'o': return { kind: 'add-project' }
    case 'w': return { kind: 'detach-tab' }
    case 'k': return { kind: 'palette' }
    case 'i': return { kind: 'inspector' }
    case '\\': return { kind: 'sidebar' }
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
