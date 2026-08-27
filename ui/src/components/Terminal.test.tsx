/**
 * The terminal is the reason at least one user moved onto Caprock full-time,
 * and it renders to a canvas rather than the DOM — which is what made both of
 * these defects invisible until someone read Russian output on it.
 */
import { render } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const ctor = vi.hoisted(() => vi.fn())

type KeyHandler = (e: KeyboardEvent) => boolean
const keyHandler = vi.hoisted((): { fn: KeyHandler | null } => ({ fn: null }))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(opts: unknown) { ctor(opts) }
    loadAddon() {}
    open() {}
    write() {}
    onData() { return { dispose() {} } }
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

  function mount(): KeyHandler {
    sent.length = 0
    keyHandler.fn = null
    vi.stubGlobal('WebSocket', class {
      static OPEN = 1
      readyState = 1
      binaryType = ''
      send(d: string) { sent.push(d) }
      close() {}
    })
    render(<TerminalView sessionId="s-keys" owned />)
    const fn = keyHandler.fn
    if (!fn) throw new Error('no key handler was installed')
    return fn
  }

  const key = (over: Partial<KeyboardEvent>) =>
    ({ type: 'keydown', key: 'Enter', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...over }) as KeyboardEvent

  it('sends the escape sequence Claude Code listens for', () => {
    const h = mount()
    expect(h(key({ shiftKey: true }))).toBe(false)  // xterm must not also send \r
    expect(sent).toEqual(['\x1b[13;2u'])
  })

  it('leaves plain Enter alone', () => {
    // Breaking submit would be far worse than the bug being fixed.
    const h = mount()
    expect(h(key({}))).toBe(true)
    expect(sent).toEqual([])
  })

  it('leaves other Enter modifiers alone', () => {
    // Ctrl+Enter and Alt+Enter mean things in other programs; only Shift is ours.
    const h = mount()
    for (const mod of ['ctrlKey', 'altKey', 'metaKey'] as const) {
      expect(h(key({ shiftKey: true, [mod]: true }))).toBe(true)
    }
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
    expect(sent).toEqual(['\x1b[13;2u'])
  })
})
