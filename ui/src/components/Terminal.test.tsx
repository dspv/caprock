/**
 * The terminal is the reason at least one user moved onto Caprock full-time,
 * and it renders to a canvas rather than the DOM — which is what made both of
 * these defects invisible until someone read Russian output on it.
 */
import { render } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const ctor = vi.hoisted(() => vi.fn())

type KeyHandler = (e: KeyboardEvent) => boolean
const opened = vi.hoisted(() => ({ fn: undefined as (() => void) | undefined }))
const resizeHandler = vi.hoisted(() => ({ fn: undefined as ((s: { cols: number; rows: number }) => void) | undefined }))
const keyHandler = vi.hoisted((): { fn: KeyHandler | null } => ({ fn: null }))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(opts: unknown) { ctor(opts) }
    loadAddon() {}
    open() {}
    write() {}
    onData() { return { dispose() {} } }
    // The size the daemon is told about. A real terminal reports these after
    // it has measured its own cell; the fake reports a plausible pair so the
    // resize path can be exercised.
    cols = 120
    rows = 40
    onResize(fn: (s: { cols: number; rows: number }) => void) { resizeHandler.fn = fn; return { dispose() {} } }
    attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean) { keyHandler.fn = fn }
    dispose() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

import { TerminalView } from './Terminal'

describe('TerminalView', () => {
  beforeEach(() => {
    ctor.mockClear()
    vi.stubGlobal('WebSocket', class {
      static OPEN = 1
      readyState = 0
      binaryType = ''
      send() {}
      close() {}
    })
  })

  it('hands xterm a resolved font stack, not an unresolved CSS variable', () => {
    // xterm passes fontFamily straight to a canvas 2D context, which does not
    // resolve custom properties: `var(--font-mono)` is not a font name, so
    // every glyph fell back to the system monospace. That is invisible in
    // Latin and unreadable in Cyrillic.
    document.documentElement.style.setProperty('--font-mono', '"JetBrains Mono Variable", monospace')
    render(<TerminalView sessionId="s1" owned />)
    const opts = ctor.mock.calls[0]?.[0] as { fontFamily: string } | undefined
    expect(opts).toBeDefined()
    expect(opts!.fontFamily).not.toMatch(/var\(/)
    expect(opts!.fontFamily).toContain('JetBrains Mono')
  })

  it('asks for every subset the face ships, not just Latin', () => {
    // Subsets load when a matching character appears in the DOM. Canvas text
    // never does, and the dashboard's own chrome is English — so without an
    // explicit request per range, only the range the chrome happens to use is
    // ever fetched. A Russian session, a Greek one and a Vietnamese one all
    // rendered in the fallback face.
    const load = vi.fn().mockResolvedValue([])
    vi.stubGlobal('document', Object.assign(document, {
      fonts: { load, ready: Promise.resolve() },
    }))
    render(<TerminalView sessionId="s2" owned />)
    const asked = load.mock.calls.map((c) => c[1] as string).join('')
    // One representative per range JetBrains Mono actually covers. CJK, Arabic
    // and Hebrew are absent from the face itself, so they are deliberately not
    // asserted here — asking for them would fetch nothing.
    for (const [range, re] of [
      ['latin', /[A-Za-z]/],
      ['latin-ext', /[\u0100-\u02BA]/],
      ['cyrillic', /[\u0400-\u045F]/],
      ['cyrillic-ext', /[\u0460-\u052F]/],
      ['greek', /[\u0370-\u03FF]/],
      ['vietnamese', /[\u1EA0-\u1EF9\u0102\u01A0\u01AF]/],
    ] as const) {
      expect(asked, `no character asked for from ${range}`).toMatch(re)
    }
  })
})

/**
 * Shift+Enter, so a prompt can be more than one line.
 *
 * A terminal cannot tell Shift+Enter from Enter — both are carriage return,
 * ASCII 13. Claude Code asks for CSI u instead. Without it, a user typing a
 * numbered list had their first line submitted and the rest of the thought
 * thrown away, which is how this was reported.
 *
 * The risk in fixing it is breaking plain Enter, which would be far worse than
 * the bug, so that is what most of this tests.
 */
describe('Shift+Enter', () => {
  const sent: string[] = []
  // Which frame each send used. The daemon tells keystrokes from control
  // messages by frame type, so a test that only checks the decoded text would
  // pass with the two swapped — and the session would fill with JSON.
  const frames: string[] = []

  function mount(): KeyHandler {
    sent.length = 0
    frames.length = 0
    keyHandler.fn = null
    vi.stubGlobal('WebSocket', class {
      static OPEN = 1
      readyState = 1
      binaryType = ''
      // Input now goes as bytes, because the socket also carries control
      // messages as text and the daemon tells them apart by frame type.
      // Decoding here keeps the assertions about what reaches the PTY rather
      // than about how it was framed — a control message is recorded as the
      // JSON it is, so a test can tell the two apart.
      send(d: string | Uint8Array) {
        sent.push(typeof d === 'string' ? d : new TextDecoder().decode(d))
        frames.push(typeof d === 'string' ? 'text' : 'binary')
      }
      // Captured so a test can open the socket itself: the size has to be
      // sent the moment it opens, because the PTY was created before it.
      set onopen(fn: () => void) { opened.fn = fn }
      close() {}
    })
    render(<TerminalView sessionId="s-keys" owned />)
    const fn = keyHandler.fn
    if (!fn) throw new Error('no key handler was installed')
    return fn
  }

  const key = (over: Partial<KeyboardEvent>) =>
    ({ type: 'keydown', key: 'Enter', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...over }) as KeyboardEvent

  // Claude Code accepts four ways of asking for a newline and a person reaches
  // for whichever one they learned elsewhere. This shipped supporting only
  // Shift+Enter, and the first user to try it reported back that Option+Enter
  // was the one he knew — which is what Claude Code's own macOS docs tell
  // people to enable. Each row is the exact byte sequence Claude Code expects
  // to receive over the PTY for that key.
  it.each([
    ['Shift+Enter', { shiftKey: true }],
    ['Option+Enter', { altKey: true }],
    ['Ctrl+Enter', { ctrlKey: true }],
  ])('%s sends a line feed', (_name, mods) => {
    // All of them send 0x0A, and that is the point rather than a shortcut.
    // Shift+Enter used to send CSI u, which a terminal only sends after
    // negotiating the kitty keyboard protocol — a negotiation this terminal
    // never performs, so the binding could fail silently. A line feed is what
    // Claude Code's documentation states works in every terminal with no
    // setup at all.
    const h = mount()
    expect(h(key(mods))).toBe(false)  // xterm must not also send \r
    expect(sent).toEqual(['\n'])
  })

  it('sends a newline for Ctrl+J, the one that needs no terminal setup', () => {
    // Not an Enter key at all: Ctrl+J is line feed, and it is the combination
    // that works in every terminal with no configuration whatsoever. If
    // everything else here failed, this would still give someone a newline.
    const h = mount()
    expect(h(key({ key: 'j', ctrlKey: true }))).toBe(false)
    expect(sent).toEqual(['\n'])
  })

  it('leaves plain Enter alone', () => {
    // Breaking submit would be far worse than the bug being fixed.
    const h = mount()
    expect(h(key({}))).toBe(true)
    expect(sent).toEqual([])
  })

  it('leaves combinations of modifiers alone', () => {
    // Two modifiers is somebody else's binding — a window manager, the
    // browser, an OS shortcut. Only a single modifier means "newline" here.
    const h = mount()
    expect(h(key({ shiftKey: true, altKey: true }))).toBe(true)
    expect(h(key({ ctrlKey: true, metaKey: true }))).toBe(true)
    expect(h(key({ shiftKey: true, ctrlKey: true, altKey: true }))).toBe(true)
    expect(sent).toEqual([])
  })

  it('leaves Cmd+Enter alone', () => {
    // Cmd is the browser's and the OS's, never ours.
    const h = mount()
    expect(h(key({ metaKey: true }))).toBe(true)
    expect(sent).toEqual([])
  })

  it('leaves every other key alone', () => {
    const h = mount()
    for (const k of ['a', 'Escape', 'Tab', 'ArrowUp']) {
      expect(h(key({ key: k, shiftKey: true }))).toBe(true)
    }
    expect(sent).toEqual([])
  })

  it('ignores keyup, so one press sends one sequence', () => {
    const h = mount()
    h(key({ shiftKey: true }))
    h(key({ shiftKey: true, type: 'keyup' }))
    expect(sent).toEqual(['\n'])
  })

  /**
   * The daemon has to be told how big the window is.
   *
   * `fit()` resizes the canvas and nothing else, so the PTY kept whatever size
   * it was created with — 120x40 by default — for its whole life. Claude Code
   * lays its menus out to the terminal size, so on any other window it drew an
   * interface for a screen that was not there: arrow keys moved a selection
   * nobody could see, which is what the first user reported as "only Enter
   * works".
   */
  it('tells the daemon the size as soon as the socket opens', () => {
    mount()
    opened.fn?.()
    expect(sent).toContain('{"resize":{"cols":120,"rows":40}}')
  })

  it('tells it again when the terminal is resized', () => {
    mount()
    resizeHandler.fn?.({ cols: 143, rows: 38 })
    expect(sent).toContain('{"resize":{"cols":143,"rows":38}}')
  })

  it('never sends a zero size', () => {
    // The ResizeObserver fires mid-layout, sometimes with no width at all. A
    // zero reaching the kernel is a terminal with no columns.
    mount()
    resizeHandler.fn?.({ cols: 0, rows: 0 })
    resizeHandler.fn?.({ cols: 80, rows: 0 })
    expect(sent.filter((x) => x.includes('resize'))).toEqual([])
  })

  it('sends keystrokes as bytes and the size as text', () => {
    // The daemon tells input from control apart by frame type; if the size
    // went as a binary frame it would be typed into the session as JSON.
    const h = mount()
    h(key({ shiftKey: true }))
    resizeHandler.fn?.({ cols: 100, rows: 30 })
    expect(sent).toEqual(['\n', '{"resize":{"cols":100,"rows":30}}'])
    // The frame type is the whole protocol: binary is what the user typed,
    // text is a message about the terminal. Swap them and the daemon writes
    // `{"resize":…}` into the session as keystrokes.
    expect(frames).toEqual(['binary', 'text'])
  })
})


/**
 * The hint under the terminal.
 *
 * Shift+Enter worked from v0.30.1 and the first user to want a second line
 * still could not find it: he pressed Enter, watched half a thought get sent,
 * and concluded multi-line prompts were not possible. A feature nobody can
 * discover is not shipped.
 */
describe('the multi-line hint', () => {
  it('names the combinations, so nobody has to guess one', () => {
    render(<TerminalView sessionId="s-hint" owned />)
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/Shift/)
    expect(text).toMatch(/Option/)
    // Ctrl+J earns its place by needing no terminal configuration at all — it
    // is the answer when the others are eaten by the OS or the browser.
    expect(text).toMatch(/Ctrl/)
    expect(text).toMatch(/new line/i)
  })

  it('says nothing on a session Caprock does not own', () => {
    // There is no terminal to type into, so a hint about typing is noise.
    render(<TerminalView sessionId="s-observed" owned={false} />)
    expect(document.body.textContent).not.toMatch(/new line/i)
  })
})
