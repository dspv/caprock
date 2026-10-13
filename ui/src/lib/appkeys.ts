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

import { isMacPlatform } from './appmode'

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
  | { kind: 'deck' }
  | { kind: 'changes' }
  | { kind: 'sidebar' }
  | { kind: 'dashboard' }
  | { kind: 'next-tab' }
  | { kind: 'prev-tab' }
  /** ⌘1–⌘9: a tab by its place in the strip, ⌘9 the last. */
  | { kind: 'tab'; index: number }
  /** The next or previous row under the project in front (⌥⌘↓ ⌥⌘↑). */
  | { kind: 'session'; delta: 1 | -1 }
  /** The next or previous project in the sidebar (⌥⌘→ ⌥⌘←). */
  | { kind: 'step-project'; delta: 1 | -1 }
  | { kind: 'split'; direction: 'row' | 'column' }
  | { kind: 'next-pane' }
  | { kind: 'prev-pane' }
  | { kind: 'next-waiting' }
  | { kind: 'find' }
  | { kind: 'settings' }
  | { kind: 'zoom'; step: 1 | -1 | 0 }

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
  if (e.code === 'Equal' || e.code === 'NumpadAdd') return '='
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') return '-'
  const arrow = ARROWS[e.code ?? ''] ?? ARROWS[e.key]
  if (arrow) return arrow
  return e.key.length === 1 ? e.key.toLowerCase() : e.key
}

const ARROWS: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' }

/**
 * The arrow chords: ⌥⌘ arrows on macOS, Alt+Shift arrows elsewhere. The
 * owner asked for ⌘↑ ⌘↓ and ⌥← ⌥→ (2026-10-13); both belong to the
 * terminal. ⌥← ⌥→ are word-jump in every shell and in Claude Code's prompt,
 * and ⌘↑ ⌘↓ (⌘← ⌘→) are scroll-to-top, prompt jumps and line start/end in
 * the Mac terminals people bring their fingers from. ⌥⌘ arrows reach no
 * shell, and are next/previous tab or pane in Chrome and iTerm, so the hand
 * already reads them as "move". Off macOS each other spelling is taken:
 * Ctrl+Shift+← → are PowerShell's SelectBackwardWord / SelectNextWord
 * (PSReadLine, Windows mode, and in pwsh on Linux too), Ctrl+arrows its and
 * readline's word moves, Ctrl+PageUp/PageDown its ScrollDisplayUpLine /
 * DownLine, Ctrl+Alt arrows switch workspaces in GNOME (and rotate the
 * screen on some Windows drivers), Ctrl+Alt+Shift arrows move the window
 * to another workspace there. Alt+Shift arrows are bound by none of them:
 * not by PSReadLine in any mode, not by bash's readline or zsh's emacs
 * keymap, not by GNOME; VS Code ships them as its own Windows/Linux
 * defaults (copy line, expand selection). Alt alone stays the terminal's
 * Meta. In a text field the arrow chords stay the field's (isTextField,
 * AppShell).
 */
function arrowCommand(k: string): AppCommand | null {
  switch (k) {
    case '↓': return { kind: 'session', delta: 1 }
    case '↑': return { kind: 'session', delta: -1 }
    case '→': return { kind: 'step-project', delta: 1 }
    case '←': return { kind: 'step-project', delta: -1 }
    default: return null
  }
}

/** ⌘1–⌘9: the tab at that place in the strip, ⌘9 the last. */
function digitCommand(k: string): AppCommand | null {
  return /^[1-9]$/.test(k) ? { kind: 'tab', index: Number(k) - 1 } : null
}

/** Whether a command is one of the arrow chords, which a text field keeps. */
export function isArrowCommand(c: AppCommand): boolean {
  return c.kind === 'session' || c.kind === 'step-project'
}

/** Which app command a key press is, or null when it belongs to the page or the terminal. */
export function matchAppShortcut(e: KeyLike, isMac: boolean): AppCommand | null {
  // ⌥⌘N (Ctrl+Alt+Shift+N off macOS) is Quick chat: the one chord with
  // Option, which is otherwise the terminal's Meta and never the app's.
  if (e.altKey) {
    const quick = isMac ? e.metaKey && !e.ctrlKey && !e.shiftKey : e.ctrlKey && e.shiftKey && !e.metaKey
    if (quick && baseKey(e) === 'n') return { kind: 'quick-chat' }
    if (isMac && quick) return arrowCommand(baseKey(e))
    // Off macOS the arrow chords are Alt+Shift (arrowCommand).
    if (!isMac && e.shiftKey && !e.ctrlKey && !e.metaKey) return arrowCommand(baseKey(e))
    // Off macOS, a ⇧⌘ chord whose ⌘ twin is also the app's takes Alt too,
    // or both would be Ctrl+Shift+key (OFF_MAC_ALT).
    if (!isMac && e.ctrlKey && e.shiftKey && !e.metaKey) {
      switch (baseKey(e)) {
        case 'e': return { kind: 'split', direction: 'column' }
        case '0': return { kind: 'zoom', step: 0 }
      }
    }
    return null
  }
  // Ctrl+Tab and Ctrl+Shift+Tab cycle tabs everywhere, as in every tabbed app.
  if (e.key === 'Tab' && e.ctrlKey && !e.metaKey) return e.shiftKey ? { kind: 'prev-tab' } : { kind: 'next-tab' }
  const k = baseKey(e)
  if (isMac) {
    if (!e.metaKey || e.ctrlKey) return null
    // ⌘+ is ⌘= with or without Shift, as in every browser.
    if (k === '=') return { kind: 'zoom', step: 1 }
    if (e.shiftKey) {
      switch (k) {
        case 'n': return { kind: 'new-agent' }
        case 'd': return { kind: 'dashboard' }
        // ⌘0 is the Dashboard, so the interface's default size moved here.
        case '0': return { kind: 'zoom', step: 0 }
        case '[': return { kind: 'prev-tab' }
        case ']': return { kind: 'next-tab' }
        case 'e': return { kind: 'split', direction: 'column' }
        // G for git: the diff of the session in front.
        case 'g': return { kind: 'changes' }
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
    case 'g': return { kind: 'changes' }
    case '[': return { kind: 'prev-tab' }
    case ']': return { kind: 'next-tab' }
    // Ctrl+Shift arrows are PowerShell's select-by-word: the terminal's.
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
    // B for the band at the bottom. The Add project sheet's own ⌘B (Recent ⇄
    // Browse) is not reached: a sheet owns the keyboard while it is open.
    case 'b': return { kind: 'deck' }
    case '\\': return { kind: 'sidebar' }
    case 'e': return { kind: 'split', direction: 'row' }
    case 'j': return { kind: 'next-waiting' }
    case 'f': return { kind: 'find' }
    case '=': return { kind: 'zoom', step: 1 }
    case '-': return { kind: 'zoom', step: -1 }
    // ⌘0, beside ⌘1–⌘9: the Dashboard is the tab before the first (owner,
    // 2026-10-11: ⇧⌘D was awkward to reach). ⇧⌘D still works.
    case '0': return { kind: 'dashboard' }
    default:
      // ⌘1–⌘9 are the strip's tabs by place, ⌘9 the last, and the strip is
      // in the order the tabs were opened (owner, 2026-10-14, translated:
      // "I just want to switch between them with key combos"). For a day
      // they were the sidebar's Nth item, a project or a session by
      // grouping, and nobody could predict which. Projects have no digits.
      return digitCommand(k)
  }
}

/**
 * A key written the macOS way ('⇧⌘N', '⌘↩', '⌃Tab') in this platform's words.
 *
 * Every label in the UI is written once, in macOS spelling, and passes through
 * here: Windows and Linux users were reading ⌘ on keys they do not have. Off
 * macOS the app's chords are Ctrl+Shift with the same key (matchAppShortcut),
 * Quick chat is Ctrl+Alt+Shift, an Enter chord in a text field is Ctrl alone,
 * reload is F5, and ⌘[ ⌘] (panes) have no key, so they come back empty.
 */
export function keys(mac: string, isMac = isMacPlatform()): string {
  if (isMac) return mac
  return mac.split(', ').map(offMac).filter(Boolean).join(', ')
}

/** ⇧⌘ chords whose ⌘ twin is also a shortcut: off macOS both would read
 *  Ctrl+Shift+key, so these take Alt as well (split below, default size). */
const OFF_MAC_ALT = new Set(['⇧⌘E', '⇧⌘0'])

function offMac(k: string): string {
  if (/[↩↵]/.test(k)) return `${k.includes('⌘') ? 'Ctrl+' : ''}${k.includes('⇧') ? 'Shift+' : ''}Enter`
  if (k.startsWith('⌃')) return `Ctrl+${k.slice(1)}`
  // ⌥⇧↑ ⌥⇧↓, the sidebar's move-a-row keys, are Ctrl+Shift off macOS:
  // Alt+Shift arrows are the app's there, and Ctrl+Shift arrows reach the
  // terminal only from the terminal, never from a focused sidebar row.
  if (k.includes('⌥') && !k.includes('⌘') && /[↑↓]$/.test(k)) return `Ctrl+Shift+${k.slice(-1)}`
  if (!k.includes('⌘')) return k
  // The arrow chords are Alt+Shift off macOS (arrowCommand).
  if (/[↑↓←→]$/.test(k)) return `Alt+Shift+${k.slice(-1)}`
  // Ctrl+Shift+= is the key that reads + with Shift held.
  const key = k.replace(/[⇧⌘⌥⌃]/g, '').replace('+', '=')
  if (k.includes('⌥')) return `Ctrl+Alt+Shift+${key}`
  if (OFF_MAC_ALT.has(k)) return `Ctrl+Alt+Shift+${key}`
  if (k === '⌘R') return 'F5'
  if (!k.includes('⇧') && /^(\[|\]|\[ \])$/.test(key)) return ''
  return `Ctrl+Shift+${key}`
}

/** The digit that jumps to the tab at `index` of `count`: 1–8 by
 *  position, 9 the last one, else none. */
export function tabDigit(index: number, count: number): number | null {
  if (index === count - 1 && count > 8) return 9
  return index < 8 ? index + 1 : null
}

/** A tab's jump key as the tab itself shows it: short enough for a tab. */
export function tabKey(digit: number, isMac = isMacPlatform()): string {
  return stripKey(String(digit), isMac)
}

/** A ⌘ chord drawn on the strip (⌘0, ⌘,): the same short spelling as a tab's
 *  ⌘N — Ctrl⇧ off macOS, where the chord is Ctrl+Shift with that key. */
export function stripKey(key: string, isMac = isMacPlatform()): string {
  return isMac ? `⌘${key}` : `Ctrl⇧${key}`
}

/** The one line that says how to move around, for the hint after an update. */
export function moveKeysLine(isMac = isMacPlatform()): string {
  return `${keys('⌘1', isMac).replace(/1$/, '1–9')} switch tabs in the order you opened them · double-click a tab to rename`
}

/** How a shortcut is written in a menu or a tooltip on this platform. */
export function shortcutLabel(keys: string, opts: { shift?: boolean } = {}, isMac = true): string {
  if (isMac) return `${opts.shift ? '⇧' : ''}⌘${keys}`
  return `Ctrl+Shift+${keys}`
}

/** The app's keys as the shortcuts sheet lists them, in macOS spelling; the
 *  sheet writes each through `keys` (docs/app.md § Keyboard). */
export const SHORTCUTS: [keys: string, does: string][] = [
  ['⇧⌘N', 'New agent'],
  ['⌥⌘N', 'Quick chat: no folder; asks which agent and model, Enter takes the last one'],
  ['⌘T', 'New shell in the folder of the tab'],
  ['⌘O', 'Add a project'],
  ['⌘K', 'Command palette'],
  ['⌘J', 'Next session waiting on you'],
  ['⌘1–8, ⌘9', 'The Nth tab, in the order opened, as its badge says; ⌘9 the last'],
  ['⌥⌘↓, ⌥⌘↑', 'Next and previous session of the project in front'],
  ['⌥⌘→, ⌥⌘←', 'Next and previous project'],
  ['⌥⇧↑, ⌥⇧↓', 'Move the focused session row up or down in the sidebar'],
  ['⌃Tab, ⇧⌘[ ]', 'Next and previous tab'],
  ['⌘W', 'Close the tab or pane — the session keeps going'],
  ['⌘E, ⇧⌘E', 'Split: a new shell beside, below'],
  ['⌘[ ]', 'Previous and next pane'],
  ['⌘F', 'Find in the terminal'],
  ['⌘I', 'Inspector'],
  ['⌘B', 'Session deck: the agent’s live figures under its terminal'],
  ['⇧⌘G', 'Changes: the diff of the session in front'],
  ['⌘\\', 'Hide or show the sidebar'],
  ['⌘0, ⇧⌘D', 'Dashboard'],
  ['⌘,', 'Settings'],
  ['⌘+, ⌘−, ⇧⌘0', 'Interface size: bigger, smaller, back to the default'],
  ['⌘R', 'Reload the window'],
]
