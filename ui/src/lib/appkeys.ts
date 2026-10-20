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

/** Dispatched on window by ⇧⌘T; the sidebar footer's theme button opens its picker, or closes it. */
export const THEME_MENU_EVENT = 'caprock:theme-menu'

/** Keys named after what they open (owner, 2026-10-15), in macOS spelling; `keys()` writes them for this OS. */
export const DASHBOARD_KEY = '⌘D'
export const PIPELINE_KEY = '⌘P'
export const WORK_KEY = '⇧⌘W'
export const THEME_KEY = '⇧⌘T'
/** A browser tab's own keys (lib/browsertab browserKey, ADR-075): only while one is in front, never a terminal's. */
export const BROWSER_TAB_KEYS = '⌥←, ⌥→'

/**
 * ⌥⌘G (Ctrl+Alt+Shift+G off macOS): the highlight where you type — the band
 * on Claude Code's input box and the chat field's resting tint — on or off
 * (owner, 2026-10-17, translated: "a toggle to turn the input field
 * highlight on/off … some simple key combination"). Not ⌥⌘I, the first
 * thought: in every Mac browser that is the web inspector, which takes it
 * before the page, so in the dashboard in a browser it would never arrive.
 * ⌥⌘G is bound by no Mac browser, terminal or macOS menu (⌥⌘H is Hide
 * Others, ⌥⌘D the Dock, ⌥⌘L and ⌥⌘B the browsers' downloads and bookmarks),
 * and it reaches no shell: ⌘ is never typed. Off macOS it takes Ctrl+Alt+
 * Shift, as Quick chat does: Ctrl+Shift+G is Changes, and Ctrl+Alt+Shift+G
 * is bound by no shell, readline, PSReadLine, Windows Terminal or GNOME
 * default.
 */
export const INPUT_HIGHLIGHT_KEY = '⌥⌘G'

/**
 * The two clicks on a link in a terminal (lib/termlinks.ts), in macOS
 * spelling; `keys()` writes them Ctrl+click and Ctrl+Shift+click off macOS.
 * ⌘-click opens the default browser, as in every Mac terminal. ⇧⌘-click
 * opens a chooser of the browsers installed here (owner, 2026-10-17,
 * translated: "another chord, and there I see and choose which browser").
 * Off macOS Ctrl+Shift+click collides with nothing: Windows Terminal,
 * GNOME Terminal, Konsole and VS Code's terminal open a link on Ctrl+click
 * and bind nothing to it with Shift added, and in the page a terminal has no
 * `<a>`, so the webview's own Ctrl+Shift+click (a new tab in front) never
 * fires. Shift alone keeps xterm's extend-the-selection and, off macOS,
 * select-even-when-the-program-reads-the-mouse; neither is a link's.
 */
export const LINK_OPEN_CLICK = '⌘-click'
export const LINK_CHOOSE_CLICK = '⇧⌘-click'

export type AppCommand =
  | { kind: 'new-shell' }
  | { kind: 'new-agent' }
  | { kind: 'quick-chat' }
  /** ⇧⌘H: the quick capture into Second Brain (ADR-063). */
  | { kind: 'brain-capture' }
  | { kind: 'add-project' }
  | { kind: 'detach-tab' }
  | { kind: 'palette' }
  | { kind: 'inspector' }
  | { kind: 'deck' }
  /** ⌘P (⇧⌘B, its older key): the Pipeline tab, or, from it, back to where it was pressed. */
  | { kind: 'pipeline' }
  /** ⇧⌘W: the Work page on the dashboard, or, from it, back to where it was pressed. */
  | { kind: 'work' }
  /** ⇧⌘T: the theme picker at the foot of the sidebar, open or closed. */
  | { kind: 'theme' }
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
  /** ⇧⌘F: the Send feedback form, from anywhere. */
  | { kind: 'feedback' }
  /** ⇧⌘M: Mail, in a window of its own (lib/mailwindow.ts). */
  | { kind: 'mail' }
  | { kind: 'zoom'; step: 1 | -1 | 0 }
  /** ⌥⌘G: the highlight where you type, on or off in every terminal (INPUT_HIGHLIGHT_KEY). */
  | { kind: 'input-highlight' }
  /** ⌥⌘1–⌥⌘9: the Nth private module the admin key opens (ADR-076, moduleKey). */
  | { kind: 'module'; index: number }

/**
 * How many private modules have a key (ADR-076): lib/modules sets it from the
 * daemon's answer. With none, ⌥⌘1–9 (Ctrl+Alt+Shift+1–9) belong to nobody
 * here and reach the page or the terminal as before: an AltGr layout off
 * macOS types characters with Ctrl+Alt, and nothing about modules may change
 * a key for someone without one.
 */
let moduleKeys = 0

export function setModuleKeyCount(n: number): void {
  moduleKeys = Math.max(0, Math.min(9, n))
}

/**
 * A module's key, in macOS spelling, by its place in the sidebar: ⌥⌘1 for the
 * first. ⌥ beside ⌘ because ⌘1–9 are the tabs; ⌥⌘ with a digit is bound by
 * no Mac browser, terminal or macOS menu, and ⌘ never reaches a shell. Off
 * macOS it is Ctrl+Alt+Shift with the digit, as Quick chat is with N:
 * Ctrl+Shift+digit is a tab, and Ctrl+Alt+Shift+digit is bound by no shell,
 * readline, PSReadLine, Windows Terminal or GNOME default.
 */
export function moduleKey(index: number): string | undefined {
  return index >= 0 && index < 9 ? `⌥⌘${index + 1}` : undefined
}

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

/**
 * The tail of a held arrow chord, kept out of the terminal.
 *
 * Holding ⌥⌘↓ (Alt+Shift+↓ off macOS) steps through sessions and repeats,
 * and every repeat is the app's. Let go of the modifiers a beat before the
 * arrow, as a hand does, and the OS keeps repeating the arrow with what is
 * still held: ⌥↓ (`ESC [1;3B`) or a bare ↓ (`ESC [B`), no longer a chord,
 * so it went to the terminal in front, which by then is the session the
 * chord had just opened. Claude Code reads either as Down, and Down on its
 * prompt with background agents running moves into their list and opens
 * one (owner, 2026-10-14, translated: "sometimes it switches me to a
 * subagent, I never understood why").
 *
 * So an arrow pressed as an app chord stays the app's until that key is
 * released: its later keydowns, whatever modifiers are left, never reach
 * the terminal (`ownsTerminalKey`). A fresh press after the release is the
 * terminal's again, so plain arrows and ⌥← ⌥→ word jumps are untouched.
 * Tracked by the arrow, on window in the capture phase, so the listener
 * sees the chord even though AppShell stops it there.
 */
const chordArrows = new Set<string>()
let chordMac = false
let watching = false

function arrowOf(e: KeyLike): string | undefined {
  return ARROWS[e.code ?? ''] ?? ARROWS[e.key]
}

/** Starts tracking held arrow chords; safe to call from every terminal. */
export function watchChordArrows(isMac: boolean): void {
  chordMac = isMac
  if (watching || typeof window === 'undefined') return
  watching = true
  window.addEventListener('keydown', (e) => {
    const a = arrowOf(e)
    if (!a) return
    const c = matchAppShortcut(e, chordMac)
    if (c && isArrowCommand(c)) chordArrows.add(a)
  }, true)
  window.addEventListener('keyup', (e) => {
    const a = arrowOf(e)
    if (a) chordArrows.delete(a)
  }, true)
  // A key let go while the window had no focus never sends its keyup.
  window.addEventListener('blur', () => chordArrows.clear())
}

/** Whether this keydown is an arrow still held from an app chord (see above). */
export function isChordTail(e: KeyLike): boolean {
  const a = arrowOf(e)
  return !!a && chordArrows.has(a)
}

/**
 * ⌥⇧↑ ⌥⇧↓ (Ctrl+Shift+↑ ↓ off macOS): the sidebar's move-a-row keys, which
 * act only on a focused row (ProjectRow). Pressed in a terminal they were
 * typed as `ESC [1;4B` (`ESC [1;6B`), which Claude Code reads as Down, the
 * same trip into the background-agents list. bash's readline, zsh's emacs
 * keymap and PSReadLine bind neither, so in a terminal they do nothing.
 */
export function isRowMoveKey(e: KeyLike, isMac: boolean): boolean {
  const a = arrowOf(e)
  if (a !== '↑' && a !== '↓') return false
  if (!e.shiftKey || e.metaKey) return false
  return isMac ? e.altKey && !e.ctrlKey : e.ctrlKey && !e.altKey
}

/** The terminal's question: is this key the app's, never to be typed? */
export function ownsTerminalKey(e: KeyLike, isMac: boolean): boolean {
  return matchAppShortcut(e, isMac) !== null || isChordTail(e) || isRowMoveKey(e, isMac)
}

/** Which app command a key press is, or null when it belongs to the page or the terminal. */
export function matchAppShortcut(e: KeyLike, isMac: boolean): AppCommand | null {
  // ⌥⌘N (Ctrl+Alt+Shift+N off macOS) is Quick chat and ⌥⌘G the input
  // highlight: the letter chords with Option, which is otherwise the
  // terminal's Meta and never the app's.
  if (e.altKey) {
    const quick = isMac ? e.metaKey && !e.ctrlKey && !e.shiftKey : e.ctrlKey && e.shiftKey && !e.metaKey
    if (quick && baseKey(e) === 'n') return { kind: 'quick-chat' }
    if (quick && baseKey(e) === 'g') return { kind: 'input-highlight' }
    if (quick && /^[1-9]$/.test(baseKey(e)) && Number(baseKey(e)) <= moduleKeys) return { kind: 'module', index: Number(baseKey(e)) - 1 }
    if (isMac && quick) return arrowCommand(baseKey(e))
    // Off macOS the arrow chords are Alt+Shift (arrowCommand).
    if (!isMac && e.shiftKey && !e.ctrlKey && !e.metaKey) return arrowCommand(baseKey(e))
    // Off macOS, a ⇧⌘ chord whose ⌘ twin is also the app's takes Alt too,
    // or both would be Ctrl+Shift+key (OFF_MAC_ALT).
    if (!isMac && e.ctrlKey && e.shiftKey && !e.metaKey) {
      switch (baseKey(e)) {
        case 'e': return { kind: 'split', direction: 'column' }
        case '0': return { kind: 'zoom', step: 0 }
        case 'b': return { kind: 'pipeline' }
        case 'f': return { kind: 'feedback' }
        case 't': return { kind: 'theme' }
        case 'w': return { kind: 'work' }
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
        // H for hold on to it: a line into Second Brain (ADR-063). ⌘H
        // stays the app's Hide; macOS, its Services and the Mac terminals
        // bind nothing to ⇧⌘H (⇧⌘M is Mail's, ⇧⌘Y and ⇧⌘L are Services').
        case 'h': return { kind: 'brain-capture' }
        // The Pipeline's key until 2026-10-15, when it became ⌘P (P for
        // Pipeline); kept working, no longer shown.
        case 'b': return { kind: 'pipeline' }
        // T for theme: the picker at the foot of the sidebar (owner,
        // 2026-10-15, translated: "bind shortcuts to the names"). ⌘T stays
        // New shell, as in every terminal, so the theme takes Shift; off
        // macOS Ctrl+Shift+T is ⌘T's, so it takes Alt too (OFF_MAC_ALT).
        // No Mac terminal binds ⇧⌘T and Tauri's default menu has none; in a
        // browser it is Reopen closed tab, which the browser keeps.
        case 't': return { kind: 'theme' }
        // W for Work, the dashboard's page of work on its way to a release.
        // ⌘W stays Close the tab or pane (the app menu's Close Tab, which
        // hands it to the page as CLOSE_TAB_EVENT); ⇧⌘W is no item of the
        // app's menu and reaches no shell. Off macOS
        // Ctrl+Shift+W is ⌘W's, so it takes Alt too (OFF_MAC_ALT). In a
        // browser it closes the window, which the browser keeps.
        case 'w': return { kind: 'work' }
        // F for feedback (owner, 2026-10-14, translated: "Send feedback
        // should also open with a key combo … maybe people will file more
        // issues"). ⇧⌘F is bound by no Mac terminal or browser default that
        // reaches a page; off macOS Ctrl+Shift+F is ⌘F, Find, so it takes
        // Alt as well (OFF_MAC_ALT).
        case 'f': return { kind: 'feedback' }
        // M for Mail (owner, 2026-10-14, translated: "a button … and it
        // opens another system tab with its own key combo"). Plain ⌘M is
        // the window's Minimize and stays it; ⇧⌘M is bound by no Mac
        // terminal, and off macOS Ctrl+Shift+M has no Ctrl+Shift twin of
        // ours, reaches no shell (Ctrl+M is Enter, never typed with Shift
        // to mean it) and no PSReadLine or GNOME default.
        case 'm': return { kind: 'mail' }
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
    case 'm': return { kind: 'mail' }
    // Ctrl+Shift+H: no ⌘H twin among the app's keys, and bound by no
    // shell, readline, zsh's emacs keymap, PSReadLine or GNOME default (Ctrl+
    // Shift+U is GNOME's Unicode entry, so not U).
    case 'h': return { kind: 'brain-capture' }
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
    // Keys named after what they open (owner, 2026-10-15, translated: "bind
    // shortcuts to the names: ⌘D Dashboard (keep ⌘0 too) … ⌘P Pipeline").
    // ⌘D is no item of Tauri's default menu and reaches no shell (the
    // terminal's split is ⌘E here). Off macOS it is Ctrl+Shift+D, the same
    // key ⇧⌘D always was there: bare Ctrl+D is a shell's end of input and
    // stays the terminal's.
    case 'd': return { kind: 'dashboard' }
    // ⌘P, Pipeline: the Tauri menu has no Print, and the palette is ⌘K, so
    // nothing of ours or the webview's holds it; off macOS Ctrl+Shift+P is
    // bound by no other key of the app (Ctrl+P alone stays readline's and
    // PSReadLine's previous-line).
    case 'p': return { kind: 'pipeline' }
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
 *  Ctrl+Shift+key, so these take Alt as well (split below, default size,
 *  the Pipeline's older key beside the deck's own Ctrl+Shift+B, feedback
 *  beside Find's Ctrl+Shift+F, the theme beside New shell's Ctrl+Shift+T,
 *  Work beside Close's Ctrl+Shift+W). Ctrl+Alt+Shift+B, F, T and W are bound
 *  by no shell, PSReadLine, Windows Terminal or GNOME default (GNOME's
 *  terminal key is Ctrl+Alt+T, without Shift). */
const OFF_MAC_ALT = new Set(['⇧⌘E', '⇧⌘0', '⇧⌘B', '⇧⌘F', '⇧⌘T', '⇧⌘W'])

function offMac(k: string): string {
  // A click chord (⌘-click, ⇧⌘-click): Ctrl stands for ⌘, Shift stays.
  if (k.endsWith('-click')) return `${k.includes('⌘') ? 'Ctrl+' : ''}${k.includes('⌥') ? 'Alt+' : ''}${k.includes('⇧') ? 'Shift+' : ''}click`
  if (/[↩↵]/.test(k)) return `${k.includes('⌘') ? 'Ctrl+' : ''}${k.includes('⇧') ? 'Shift+' : ''}Enter`
  if (k.startsWith('⌃')) return `Ctrl+${k.slice(1)}`
  // ⌥⇧↑ ⌥⇧↓, the sidebar's move-a-row keys, are Ctrl+Shift off macOS:
  // Alt+Shift arrows are the app's there, and Ctrl+Shift arrows reach the
  // terminal only from the terminal, never from a focused sidebar row.
  if (k.includes('⌥') && !k.includes('⌘') && /[↑↓]$/.test(k)) return `Ctrl+Shift+${k.slice(-1)}`
  // A browser tab's ⌥← ⌥→ (lib/browsertab browserKey): Alt+← → are Back and
  // Forward in every browser off macOS, so the tab keys are theirs there.
  if (k === '⌥←') return 'Ctrl+PageUp'
  if (k === '⌥→') return 'Ctrl+PageDown'
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

/** A tab's jump key as the tab itself shows it: ⌘3 on a Mac, the whole
 *  chord, Ctrl+Shift+3, elsewhere (see `stripKey`). */
export function tabKey(digit: number, isMac = isMacPlatform()): string {
  return stripKey(String(digit), isMac)
}

/**
 * A ⌘ chord drawn on the strip (⌘0, ⌘,, ⌘3): ⌘ and the key on a Mac; off
 * macOS the chord as `keys()` writes it, Ctrl+Shift+0. It was `Ctrl⇧0`, and
 * on Windows that read "Ctrl@0" (a user's screenshot, 2026-10-19): the
 * bundled JetBrains Mono carries no ⇧ (U+21E7 is in none of its subsets),
 * Consolas has none either, and the fallback Windows picks drew it at 10px
 * as a blob that reads as @. A Mac draws ⇧ from Menlo. So no label off
 * macOS holds a Mac glyph (`isPlainKeyLabel`); its length is handled by
 * drawing it on demand (`keyChipMode`), never by a glyph the font may lack.
 */
export function stripKey(key: string, isMac = isMacPlatform()): string {
  return isMac ? `⌘${key}` : keys(`⌘${key}`, false)
}

/** Whether a label drawn off macOS is free of the Mac's modifier glyphs
 *  (⇧ ⌘ ⌥ ⌃), which the fonts there may not carry, and of a stray @. */
export function isPlainKeyLabel(label: string): boolean {
  return !/[⇧⌘⌥⌃@]/.test(label)
}

/**
 * How the key chips beside labels are drawn. On a Mac they are short (⌘D,
 * ⇧⌘N) and always shown, as before. Off macOS the same keys are
 * Ctrl+Shift+N and Ctrl+Alt+Shift+T, 80–140px: drawn always they crowded
 * and cut the labels beside them ("Settings" under its chip, the palette's
 * name half hidden, "Quick chat" on two lines; a Windows user's
 * screenshot, 2026-10-19). There a chip is drawn on demand only: over its
 * row while the keyboard focus is on it, and every chip at once while Ctrl
 * is held alone (lib/keyreveal.ts), the way Windows apps show their access
 * keys while Alt is held. Not on hover: there the row's tooltip, which
 * names the key, is the one hint (a Windows tester, 2026-10-20, saw both).
 * At rest every label is whole.
 */
export function keyChipMode(isMac = isMacPlatform()): 'always' | 'on-demand' {
  return isMac ? 'always' : 'on-demand'
}

/** The class a row's chip adds for `keyChipMode`: off macOS shown on keyboard
 *  focus or held Ctrl, never on hover (`.app-kbd-reveal`, design/tokens.css); none on a Mac. */
export function revealClass(isMac = isMacPlatform()): string {
  return keyChipMode(isMac) === 'always' ? '' : 'app-kbd-reveal'
}

/** The classes a tab's chip adds, with a leading space: off macOS shown only
 *  while Ctrl is held (`.app-kbd-held`), since hovering a tab puts its ×
 *  where the key is; `start` anchors it to the tab's left edge, for the
 *  pinned tabs at the strip's start. None on a Mac. */
export function heldClass(start = false, isMac = isMacPlatform()): string {
  if (keyChipMode(isMac) === 'always') return ''
  return start ? ' app-kbd-held app-kbd-held-start' : ' app-kbd-held'
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
  ['⌥⌘N', 'Quick chat: no folder; starts at once on the model used last'],
  ['⌘T', 'New shell in the folder of the tab'],
  ['⌘O', 'Add a project'],
  ['⌘K', 'Command palette'],
  ['⌘J', 'Next session waiting on you'],
  ['⇧⌘H', 'Add to Second Brain: keep a line of your own'],
  ['⌘1–8, ⌘9', 'The Nth tab, in the order opened, as its badge says; ⌘9 the last'],
  ['⌥⌘↓, ⌥⌘↑', 'Next and previous session of the project in front'],
  ['⌥⌘→, ⌥⌘←', 'Next and previous project'],
  ['⌥⇧↑, ⌥⇧↓', 'Move the focused session row up or down in the sidebar or the Live pulse, or a right panel section by its grip'],
  ['⌃Tab, ⇧⌘[ ]', 'Next and previous tab'],
  [BROWSER_TAB_KEYS, 'In a browser tab (beta): the tab before and after, outside a text field'],
  ['⌘W', 'Close the tab or pane — the session keeps going'],
  ['⌘E, ⇧⌘E', 'Split: a new shell beside, below'],
  ['⌘[ ]', 'Previous and next pane'],
  ['⌘F', 'Find in the terminal; with Settings in front, search Settings'],
  [INPUT_HIGHLIGHT_KEY, 'Highlight where you type: on or off, in every terminal'],
  [LINK_OPEN_CLICK, 'A link in the terminal: open it in your default browser'],
  [LINK_CHOOSE_CLICK, 'A link in the terminal: choose the browser to open it in, or copy it'],
  ['⌘I', 'Inspector'],
  ['⌘B', 'Pipeline bar under the agent’s terminal, shown or hidden'],
  ['⌘P', 'Pipeline, in a tab of its own; there, back to where you were'],
  ['⇧⌘W', 'Work on the dashboard: every piece of work on its way to a release; there, back'],
  ['⇧⌘G', 'Changes: the diff of the session in front'],
  ['⌘\\', 'Hide or show the sidebar'],
  ['⌘D, ⌘0', 'Dashboard, where you left it; again: Home, at its top'],
  ['⌘,', 'Settings'],
  ['⇧⌘T', 'Theme: open the picker'],
  ['⇧⌘F', 'Send feedback: a bug, an idea or a question'],
  ['⇧⌘M', 'Mail, in a window of its own'],
  ['⌘+, ⌘−, ⇧⌘0', 'Interface size: bigger, smaller, back to the default'],
  ['⌘R', 'Reload the window'],
]
