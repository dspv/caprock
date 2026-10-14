/**
 * No app chord with an arrow ever reaches the session (owner, 2026-10-14,
 * translated: "sometimes it switches me to a subagent, I never understood
 * why"). Claude Code reads any Down — `ESC [B`, `ESC [1;3B`, `ESC [1;4B` —
 * as Down, and Down on its prompt with background agents running opens one.
 *
 * The real xterm here, not a stub: what matters is which bytes it puts on
 * the socket for a key, and only xterm decides that. The socket is a mock
 * that records every send. Each chord is pressed as macOS, Windows and
 * Linux spell it (CLAUDE.md rule 12), the way AppShell's window listener
 * sees it and, with a sheet open, the way it does not.
 */
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ sent: [] as string[] }))

vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { activate() {} dispose() {} fit() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { activate() {} onContextLoss() {} dispose() {} } }))
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    activate() {}
    dispose() {}
    findNext() { return true }
    findPrevious() { return true }
    clearDecorations() {}
    onDidChangeResults() { return { dispose() {} } }
  },
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('@/lib/termv2', () => ({
  TermClient: class {
    state = 'connecting'
    protocol = 'v2'
    start() {}
    wake() {}
    suspend() {}
    send(d: string) { h.sent.push(d); return true }
    resize() {}
    focus() {}
    blur() {}
    dispose() {}
  },
}))

import { TerminalPane } from './TerminalPane'
import { SHORTCUTS, keys, matchAppShortcut } from '@/lib/appkeys'

const PLATFORMS = [
  { os: 'macOS', platform: 'MacIntel', isMac: true },
  { os: 'Windows', platform: 'Win32', isMac: false },
  { os: 'Linux', platform: 'Linux x86_64', isMac: false },
] as const

const ARROW_CODE: Record<string, { key: string; keyCode: number }> = {
  '↑': { key: 'ArrowUp', keyCode: 38 },
  '↓': { key: 'ArrowDown', keyCode: 40 },
  '←': { key: 'ArrowLeft', keyCode: 37 },
  '→': { key: 'ArrowRight', keyCode: 39 },
}

interface Press { key: string; code: string; keyCode: number; metaKey: boolean; altKey: boolean; shiftKey: boolean; ctrlKey: boolean }

/** One chord as a platform spells it ('⌥⌘↓' on macOS, 'Alt+Shift+↓' elsewhere) to a key press. */
function parse(spelled: string): Press {
  const arrow = spelled.slice(-1)
  const a = ARROW_CODE[arrow]!
  const mods = spelled.slice(0, -1)
  return {
    key: a.key,
    code: a.key,
    keyCode: a.keyCode,
    metaKey: mods.includes('⌘'),
    altKey: mods.includes('⌥') || mods.includes('Alt'),
    shiftKey: mods.includes('⇧') || mods.includes('Shift'),
    ctrlKey: mods.includes('⌃') || mods.includes('Ctrl'),
  }
}

/** Every SHORTCUTS row with an arrow, each chord in it, in this platform's words. */
function arrowChords(isMac: boolean): string[] {
  return SHORTCUTS.filter(([k]) => /[↑↓←→]/.test(k))
    .flatMap(([k]) => k.split(', '))
    .map((k) => keys(k, isMac))
}

function textarea(): HTMLTextAreaElement {
  const t = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
  if (!t) throw new Error('xterm did not open')
  return t
}

function down(p: Press, repeat = false) {
  act(() => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { ...p, repeat, bubbles: true, cancelable: true }))
  })
}
function up(p: Press) {
  act(() => {
    textarea().dispatchEvent(new KeyboardEvent('keyup', { ...p, bubbles: true, cancelable: true }))
  })
}

/** AppShell's listener, as it stands: the window, the capture phase, the app's chords stopped there. */
function appShell(isMac: boolean) {
  const onKey = (e: KeyboardEvent) => {
    if (!matchAppShortcut(e, isMac)) return
    e.preventDefault()
    e.stopPropagation()
  }
  window.addEventListener('keydown', onKey, true)
  return () => window.removeEventListener('keydown', onKey, true)
}

// jsdom's KeyboardEvent drops keyCode from its init dictionary, and xterm reads it.
const NativeKeyboardEvent = globalThis.KeyboardEvent
class KeyCodeEvent extends NativeKeyboardEvent {
  constructor(type: string, init: KeyboardEventInit & { keyCode?: number } = {}) {
    super(type, init)
    Object.defineProperty(this, 'keyCode', { value: init.keyCode ?? 0 })
    Object.defineProperty(this, 'which', { value: init.keyCode ?? 0 })
  }
}

let restore: (() => void)[] = []
beforeEach(() => {
  h.sent.length = 0
  vi.stubGlobal('KeyboardEvent', KeyCodeEvent)
  // xterm watches the device pixel ratio through it; jsdom has none.
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => {
  for (const r of restore) r()
  restore = []
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

async function mount(platform: string) {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
  render(<TerminalPane sessionId="s" active focused />)
  // The pane opens xterm once the font is asked for.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  textarea().focus()
}

describe.each(PLATFORMS)('an app arrow chord in a focused terminal, $os', ({ platform, isMac }) => {
  it('lists the chords it presses', () => {
    // ⌥⌘↓ ⌥⌘↑ ⌥⌘→ ⌥⌘← and the sidebar's ⌥⇧↑ ⌥⇧↓, in this platform's words.
    expect(arrowChords(isMac)).toHaveLength(6)
  })

  it('a plain arrow still reaches the session (the control)', async () => {
    await mount(platform)
    restore.push(appShell(isMac))
    down(parse('↓'))
    expect(h.sent).toEqual(['\x1b[B'])
  })

  it('writes nothing to the session, with AppShell listening and with a sheet open', async () => {
    await mount(platform)
    for (const chord of arrowChords(isMac)) {
      down(parse(chord))
      up(parse(chord))
    }
    expect(h.sent).toEqual([])
    restore.push(appShell(isMac))
    for (const chord of arrowChords(isMac)) {
      down(parse(chord))
      down(parse(chord), true)
      up(parse(chord))
    }
    expect(h.sent).toEqual([])
  })

  it('an arrow still repeating after the modifiers lift is the chord\'s, until it is released', async () => {
    await mount(platform)
    restore.push(appShell(isMac))
    const chord = parse(keys('⌥⌘↓', isMac))
    down(chord)
    down(chord, true)
    // The hand lets go of one modifier, then the rest; the arrow repeats on.
    down({ ...chord, metaKey: false, ctrlKey: false, shiftKey: false }, true)
    down({ ...chord, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }, true)
    expect(h.sent).toEqual([])
    up(parse('↓'))
    // A fresh press after the release is the terminal's again.
    down(parse('↓'))
    expect(h.sent).toEqual(['\x1b[B'])
  })

  it('keeps the terminal\'s own Option/Alt arrows, word jumps included', async () => {
    await mount(platform)
    restore.push(appShell(isMac))
    down({ ...parse('←'), altKey: true })
    down({ ...parse('→'), altKey: true })
    expect(h.sent).toEqual(['\x1b[1;3D', '\x1b[1;3C'])
  })
})
