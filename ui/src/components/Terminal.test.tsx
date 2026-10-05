/**
 * The terminal is the reason at least one user moved onto Caprock full-time,
 * and it renders to a canvas rather than the DOM — which is what made both of
 * these defects invisible until someone read Russian output on it.
 */
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'

const ctor = vi.hoisted(() => vi.fn())

type KeyHandler = (e: KeyboardEvent) => boolean
const pasteCalls = vi.hoisted(() => [] as { name: string; type: string; data: string }[])
const written = vi.hoisted(() => [] as string[])
const selection = vi.hoisted(() => ({ text: '' }))
const pasted = vi.hoisted(() => [] as string[])
const opened = vi.hoisted(() => ({ fn: undefined as (() => void) | undefined }))
const resizeHandler = vi.hoisted(() => ({ fn: undefined as ((s: { cols: number; rows: number }) => void) | undefined }))
const keyHandler = vi.hoisted((): { fn: KeyHandler | null } => ({ fn: null }))
// What the terminal did on mount, in order: "focus", "addon:webgl", and the
// socket's creation — so a test can say the keyboard and the socket come
// before the slow GPU set-up.
const steps = vi.hoisted(() => [] as string[])
const resets = vi.hoisted(() => ({ n: 0 }))
// xterm's grid (.xterm-screen), whose height a renderer swap changes.
const grid = vi.hoisted(() => ({ el: undefined as HTMLElement | undefined, height: 300 }))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(opts: unknown) { ctor(opts) }
    // Recorded so a test can tell whether anything re-themed the terminal
    // after it opened.
    options: Record<string, unknown> = {}
    // The real xterm throws here when an addon cannot initialise, which is
    // what WebGL does on a machine without it — jsdom is such a machine. A
    // mock that swallowed it would let a missing fallback ship: the component
    // would die in a browser and pass every test here.
    loadAddon(a: unknown) {
      if ((a as { __webgl?: boolean })?.__webgl) {
        steps.push('addon:webgl')
        throw new Error('WebGL is not supported in this environment')
      }
    }
    element: HTMLElement | undefined
    open(parent: HTMLElement) {
      const el = document.createElement('div')
      const g = document.createElement('div')
      g.className = 'xterm-screen'
      Object.defineProperty(g, 'clientHeight', { configurable: true, get: () => grid.height })
      el.appendChild(g)
      parent.appendChild(el)
      this.element = el
      grid.el = g
    }
    focus() { steps.push('focus') }
    write(d: string) { written.push(d) }
    reset() { resets.n++ }
    onData() { return { dispose() {} } }
    // The size the daemon is told about. A real terminal reports these after
    // it has measured its own cell; the fake reports a plausible pair so the
    // resize path can be exercised.
    cols = 120
    rows = 40
    onResize(fn: (s: { cols: number; rows: number }) => void) { resizeHandler.fn = fn; return { dispose() {} } }
    // Selection and paste, for the copy/paste rules. `selection.text` is what
    // a test says is highlighted; `pasted` records what reached the terminal,
    // which is where a paste has to land so bracketed paste is applied.
    getSelection() { return selection.text }
    clearSelection() { selection.text = '' }
    paste(t: string) { pasted.push(t) }
    attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean) { keyHandler.fn = fn }
    dispose() {}
  },
}))
let fitCalls = 0
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() { fitCalls++ } } }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      // Answers like the daemon: a path under paste/ named after the file,
      // and a 415 carrying {error, detail} for a type it does not take.
      paste: async (f: { name: string; type: string; data: string }) => {
        pasteCalls.push(f)
        if (f.name.endsWith('.exe')) {
          throw new actual.ApiError(415, '415 Unsupported Media Type', {
            error: 'unsupported file type: .exe', detail: 'accepted: PDF (pdf); data (csv)',
          })
        }
        return { path: f.name === 'shot.png' ? '/data/paste/x.png' : `/data/paste/d/${f.name}` }
      },
    },
  }
})
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class { __webgl = true; onContextLoss() {} dispose() {} },
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

// A ResizeObserver we can fire by hand, and an element whose size we control:
// jsdom lays nothing out, so clientWidth/clientHeight are 0 for everything and
// the "did the geometry change" guard could not otherwise be exercised.
const roHandler: { fn?: () => void } = {}
const observed: Element[] = []
const hostSize = { width: 400, height: 300 }
vi.stubGlobal('ResizeObserver', class {
  constructor(fn: () => void) { roHandler.fn = fn }
  observe(el: Element) { observed.push(el) }
  disconnect() { roHandler.fn = undefined }
})
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return hostSize.width } })
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return hostSize.height } })

import { START_TIMEOUT_MS, TERMINAL_THEME, TerminalView, WEBGL_QUIET_MS } from './Terminal'
import { BACKOFF_MAX_MS, BACKOFF_MIN_MS } from '@/lib/termv2'

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

  it('draws a dark terminal in the paper theme, and keeps it dark across a theme switch', async () => {
    // Owner reports, 2026-10-04: on paper, Claude Code's dim text and status
    // line were grey on cream; and with the app switched to dark while a
    // terminal was open, it stayed paper — the colours were read once, at
    // mount, from whichever theme was on then.
    const root = document.documentElement
    root.setAttribute('data-theme', 'light')
    root.setAttribute('data-tone', 'paper')
    root.style.setProperty('--color-bg', '#efe7d6')
    root.style.setProperty('--color-fg', '#24211c')
    render(<TerminalView sessionId="theme" owned />)
    const opts = ctor.mock.calls[0]?.[0] as { theme: Record<string, string> }
    expect(opts.theme).toEqual(TERMINAL_THEME)
    expect(opts.theme.background).toBe('#1b1b1a')
    // The ground around the canvas is the terminal's, not the page's.
    const host = document.querySelector('[data-term-host]')
    expect(host?.parentElement?.className).toContain('bg-term-bg')
    expect(host?.parentElement?.className).not.toMatch(/\bbg-bg\b/)

    // Toggle both ways with the terminal open: nothing re-creates or re-themes it.
    for (const t of ['dark', 'light']) {
      root.setAttribute('data-theme', t)
      root.style.setProperty('--color-bg', t === 'dark' ? '#1b1b1a' : '#faf9f7')
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(ctor).toHaveBeenCalledTimes(1)
    expect(opts.theme).toEqual(TERMINAL_THEME)
    root.removeAttribute('data-theme')
    root.removeAttribute('data-tone')
    root.style.removeProperty('--color-bg')
    root.style.removeProperty('--color-fg')
  })

  it('says it is starting until the first output, and offers a retry when none comes', async () => {
    // Owner report, 2026-10-04: after "continue in terminal" the panel stayed
    // black for over half a minute while `claude --resume` started, with
    // nothing to tell a slow start from a broken one.
    vi.useFakeTimers()
    const sockets: { onmessage?: (e: { data: unknown }) => void; onclose?: () => void }[] = []
    vi.stubGlobal('WebSocket', class {
      static OPEN = 1
      readyState = 1
      binaryType = ''
      onmessage?: (e: { data: unknown }) => void
      onclose?: () => void
      constructor() { sockets.push(this) }
      send() {}
      close() {}
    })
    try {
      render(<TerminalView sessionId="slow" owned />)
      expect(screen.getByRole('status').textContent).toContain('Starting the session')
      const { act } = await import('@testing-library/react')
      act(() => { sockets[0]!.onmessage?.({ data: new Uint8Array([104, 105]).buffer }) })
      expect(screen.queryByRole('status')).toBeNull()

      // A second terminal that never prints: after the timeout, a retry that reconnects.
      render(<TerminalView sessionId="mute" owned />)
      act(() => { vi.advanceTimersByTime(START_TIMEOUT_MS + 1000) })
      // The terminal that never printed is also silent past the dead socket
      // deadline, so a connection status is up beside this one.
      expect(screen.getByText(/Nothing from the session/)).toBeTruthy()
      const before = sockets.length
      act(() => { screen.getByRole('button', { name: 'Retry' }).click() })
      expect(sockets.length).toBe(before + 1)
      expect(screen.getByText(/Starting the session/)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens the socket and takes the keyboard before the slow GPU set-up', async () => {
    // Owner report, 2026-10-04: opening a session's terminal froze the tab
    // and typing lagged. The WebGL renderer was set up synchronously before
    // the socket was even created — 1.5 s of context creation in his Chrome,
    // 0.4 s of shader linking in a profile — so input and output both waited
    // behind it. Now the socket and focus come first, and WebGL only after
    // the first output and a quiet moment with no typing.
    vi.useFakeTimers()
    steps.length = 0
    const sockets: { onmessage?: (e: { data: unknown }) => void }[] = []
    vi.stubGlobal('WebSocket', class {
      static OPEN = 1
      readyState = 1
      binaryType = ''
      onmessage?: (e: { data: unknown }) => void
      constructor() { steps.push('socket'); sockets.push(this) }
      send() {}
      close() {}
    })
    try {
      render(<TerminalView sessionId="quick" owned />)
      expect(steps).toEqual(['focus', 'socket'])
      const { act } = await import('@testing-library/react')
      // No output yet: however long it waits, no WebGL.
      act(() => { vi.advanceTimersByTime(WEBGL_QUIET_MS * 3) })
      expect(steps).not.toContain('addon:webgl')
      act(() => { sockets[0]!.onmessage?.({ data: new Uint8Array([104]).buffer }) })
      act(() => { vi.advanceTimersByTime(WEBGL_QUIET_MS * 2) })
      // Tried once, after the output; jsdom has no WebGL, and the terminal
      // carries on without it.
      expect(steps.filter((s) => s === 'addon:webgl')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
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
describe('a session Caprock did not start', () => {
  it('offers the one action that produces a terminal, and blames nobody', () => {
    // The panel used to open with "This is an externally started session —
    // Caprock observes it but never writes into a terminal it does not own":
    // true, and written for the people who built it. The reader's reaction was
    // "I have no idea what is being asked of me."
    render(<TerminalView sessionId="s1" owned={false} />)

    // A way out, not just an explanation — and an action rather than a link.
    // It was a link to the main screen, which is navigation dressed as an
    // offer: it moved the reader away from what they were doing and left them
    // to find the real button themselves.
    expect(screen.getByRole('button', { name: /start a session here/i })).toBeTruthy()
    expect(screen.queryByRole('link', { name: /start|launch/i })).toBeNull()

    // And it must say what happens to the session already running, because the
    // reasonable fear about a button on this screen is that it disturbs it.
    // The wording may change; the promise may not.
    expect(document.body.textContent).toMatch(/this one keeps running|keeps running, untouched/i)

    // And none of the vocabulary that only makes sense from inside.
    for (const jargon of [/externally started/i, /does not own/i, /spawn/i]) {
      expect(document.body.textContent).not.toMatch(jargon)
    }
  })

  it('offers to start in the repository already on screen', () => {
    // Asking for the working directory, on a screen that is showing it, is
    // asking someone to retype what they are looking at.
    render(<TerminalView sessionId="s1" owned={false} cwd="/Users/x/dev/thing" />)
    // The path itself, not the words "this repository": a reader should be
    // able to check where it will run before clicking, not after.
    expect(screen.getByText('/Users/x/dev/thing')).toBeTruthy()
  })
})

describe('a session Caprock started before it restarted', () => {
  it('says the terminal is gone and offers continue, not an empty screen', () => {
    // FB-040: the tab opened a blank terminal for a session whose terminal
    // went with the previous run, while the list's continue worked. Then the
    // words were the problem: the owner could not tell what "its terminal
    // went with that run" meant. Plain words, and continue named as the way on.
    render(<TerminalView sessionId="s1" owned={false} detached resume={<button>Continue it here</button>} />)
    expect(document.body.textContent).toMatch(/terminal was closed when Caprock restarted/)
    expect(document.body.textContent).toMatch(/The conversation is saved/)
    expect(screen.getByRole('button', { name: 'Continue it here' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /start a session here/i })).toBeNull()
  })

  it('does not promise a continue it cannot offer', () => {
    // Transcript gone: the reason is shown instead of the button, so the line
    // pointing at the button must go too.
    render(<TerminalView sessionId="s1" owned={false} detached canContinue={false} resume={<span>can’t continue here: deleted</span>} />)
    expect(document.body.textContent).toMatch(/terminal was closed when Caprock restarted/)
    expect(document.body.textContent).not.toMatch(/conversation is saved/)
  })
})

describe('a Caprock restart under an open terminal', () => {
  type Sock = { onclose?: (e: { code: number }) => void; onmessage?: (e: { data: string }) => void; onopen?: () => void }
  const socks: Sock[] = []
  beforeEach(() => {
    socks.length = 0
    written.length = 0
    resets.n = 0
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', class {
      static OPEN = 1
      readyState = 1
      binaryType = ''
      onclose?: (e: { code: number }) => void
      onmessage?: (e: { data: string }) => void
      onopen?: () => void
      constructor() { socks.push(this) }
      send() {}
      close() {}
    })
  })
  afterEach(() => { vi.useRealTimers() })

  it('reconnects when the connection drops, says so over the terminal, and never gives up', async () => {
    // ADR-033: the session lives in its pty-host and outlives the daemon, so
    // a dropped socket is Caprock restarting, not the session ending. It used
    // to print "[session ended]" over a session that was still running, then
    // "[Caprock is restarting — reconnecting…]" into the scrollback, and gave
    // up after 60 attempts.
    const { act } = await import('@testing-library/react')
    render(<TerminalView sessionId="s-re" owned />)
    expect(socks).toHaveLength(1)
    act(() => { socks[0]?.onmessage?.({ data: 'screen' }) })
    act(() => { socks[0]?.onclose?.({ code: 1006 }) })
    // Which try, and when: never just "reconnecting".
    expect(screen.getByText(/^Reconnecting \(1\) · next try in \d+ s$/)).toBeTruthy()
    expect(screen.getByText('Typed keys will be sent')).toBeTruthy()
    expect(written.join('')).not.toMatch(/reconnecting|session ended/i)
    act(() => { vi.advanceTimersByTime(BACKOFF_MIN_MS) })
    expect(socks).toHaveLength(2)
    // An older daemon (version 1) replays the screen; it is cleared first.
    act(() => { socks[1]?.onmessage?.({ data: 'screen' }) })
    expect(resets.n).toBe(1)
    act(() => { socks[1]?.onmessage?.({ data: 'more' }) })
    expect(resets.n).toBe(1)
    // A hundred failures later it is still trying, fifteen seconds apart at most.
    for (let i = 0; i < 100; i++) {
      act(() => { socks[socks.length - 1]?.onclose?.({ code: 1006 }) })
      act(() => { vi.advanceTimersByTime(BACKOFF_MAX_MS) })
    }
    expect(socks).toHaveLength(102)
    expect(written.join('')).not.toMatch(/reload/)
  })

  it('says the session ended when the daemon says so, and stops', () => {
    render(<TerminalView sessionId="s-end" owned />)
    socks[0]?.onclose?.({ code: 1000 })
    expect(written.join('')).toMatch(/session ended/)
    vi.advanceTimersByTime(5000)
    expect(socks).toHaveLength(1)
  })
})

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
    ({
      type: 'keydown',
      key: 'Enter',
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      // The handler calls both on the newline keys: returning false is not
      // enough to stop xterm's hidden textarea emitting its own carriage
      // return. A fixture without them throws rather than failing usefully.
      preventDefault() {},
      stopPropagation() {},
      ...over,
    }) as unknown as KeyboardEvent

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
  ])('%s sends ESC CR', (_name, mods) => {
    // `1b 0d`, verified against a running Claude Code with text already in the
    // prompt — which is the part three earlier answers got wrong.
    //
    // This test asserted two of those wrong answers in turn, which is how the
    // bug reached users twice. CSI u needs the kitty protocol negotiated.
    // `5c 6e` misread the iTerm2 binding, whose Send Text interprets the
    // escape rather than sending both characters. A bare line feed looked
    // right on an *empty* prompt and submits once anything is typed — the
    // exact symptom reported. Only ESC CR keeps the prompt and adds a line.
    const h = mount()
    const ev = key(mods)
    const prevented: string[] = []
    ;(ev as { preventDefault?: () => void }).preventDefault = () => prevented.push('default')
    ;(ev as { stopPropagation?: () => void }).stopPropagation = () => prevented.push('propagation')

    expect(h(ev)).toBe(false)
    expect(sent).toEqual(['\x1b\r'])
    expect([...(sent[0] ?? '')].map((c) => c.charCodeAt(0))).toEqual([0x1b, 0x0d])

    // The half that took four attempts to find. Returning false stops xterm
    // *interpreting* the key, but the browser still delivers it to xterm's
    // hidden textarea, which emits a carriage return through onData — so the
    // socket carried our sequence and then a bare 0d, and Claude Code
    // submitted on the second one. On the wire: [27,13] immediately followed
    // by [13], which is exactly what "it always sends" looks like.
    expect(prevented).toContain('default')
  })

  it('sends the same sequence for Ctrl+J', () => {
    // Ctrl+J is not an Enter key at all, and people reach for it because it is
    // the one Claude Code's documentation names. It gets the same treatment,
    // so whichever key someone learned elsewhere produces a newline here.
    const h = mount()
    expect(h(key({ key: 'j', ctrlKey: true }))).toBe(false)
    expect(sent).toEqual(['\x1b\r'])
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
    expect(sent).toEqual(['\x1b\r'])
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

  /**
   * fit() writes to the element this observer watches, so calling it straight
   * from the callback lets a resize cause a resize. Idle, that settles after a
   * frame and nobody notices. Under a TUI that repaints on every keystroke —
   * Gemini CLI does — it was a visible flicker on every key, reported by the
   * first user to run one.
   */
  it('does not refit when the geometry has not changed', async () => {
    mount()
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    // Settle on a size first: the observer's very first callback is the one
    // that records the baseline, and fitting once for that is correct.
    roHandler.fn?.()
    await new Promise((r) => requestAnimationFrame(() => r(null)))

    const before = fitCalls
    // Now the case that mattered: many fires, nothing moved — which is what a
    // TUI repainting on every keystroke produces.
    for (let i = 0; i < 20; i++) roHandler.fn?.()
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    expect(fitCalls - before).toBe(0)
  })

  it('coalesces a burst of resizes into one fit', async () => {
    mount()
    // Let mount's own fits (on socket open, and again when fonts resolve)
    // settle before counting; this is about the observer, not startup.
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    const before = fitCalls
    // A real resize, reported many times as the drag proceeds.
    for (let i = 0; i < 10; i++) {
      hostSize.width = 400 + i * 10
      roHandler.fn?.()
    }
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    // One frame, one fit — not ten.
    expect(fitCalls - before).toBe(1)
  })

  // A renderer swap (WebGL loaded late, or dropped after a context loss)
  // changes the cell and keeps the row count: the grid grew past its box at
  // 390px and covered the keys bar's field, with the box itself unchanged.
  it('refits when the grid changes size inside an unchanged box', async () => {
    mount()
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    roHandler.fn?.()
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    expect(observed).toContain(grid.el)
    const before = fitCalls
    grid.height = 496
    roHandler.fn?.()
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    expect(fitCalls - before).toBe(1)
    grid.height = 300
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
    expect(sent).toEqual(['\x1b\r', '{"resize":{"cols":100,"rows":30}}'])
    // The frame type is the whole protocol: binary is what the user typed,
    // text is a message about the terminal. Swap them and the daemon writes
    // `{"resize":…}` into the session as keystrokes.
    expect(frames).toEqual(['binary', 'text'])
  })

  /**
   * Copy and paste in a terminal you live in.
   *
   * xterm.js gives you neither: every key goes to the process, so Ctrl+C is
   * always SIGINT and nothing copies. The rule here is VS Code's, because it is
   * the one people already have in their fingers — Ctrl+C copies when something
   * is selected and interrupts when nothing is.
   */
  const setPlatform = (p: string) => {
    Object.defineProperty(navigator, 'platform', { value: p, configurable: true })
  }
  const clipboard = { written: [] as string[], text: '' }

  beforeEach(() => {
    selection.text = ''
    pasted.length = 0
    clipboard.written.length = 0
    clipboard.text = ''
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (t: string) => { clipboard.written.push(t); return Promise.resolve() },
        readText: () => Promise.resolve(clipboard.text),
      },
    })
  })

  it('copies with Ctrl+C when there is a selection, and does not interrupt', () => {
    setPlatform('Linux x86_64')
    const h = mount()
    selection.text = 'some output'
    // false = xterm must not also send 0x03; a person who just dragged across
    // output means copy, not stop.
    expect(h(key({ key: 'c', ctrlKey: true }))).toBe(false)
    expect(clipboard.written).toEqual(['some output'])
  })

  it('interrupts with Ctrl+C when nothing is selected', () => {
    // The far more common case, and the one that must never be taken away:
    // Ctrl+C is how you stop a runaway command.
    setPlatform('Linux x86_64')
    const h = mount()
    selection.text = ''
    expect(h(key({ key: 'c', ctrlKey: true }))).toBe(true)
    expect(clipboard.written).toEqual([])
  })

  it('uses Cmd+C and Cmd+V on macOS, where they collide with nothing', () => {
    setPlatform('MacIntel')
    const h = mount()
    selection.text = 'copied on a mac'
    expect(h(key({ key: 'c', metaKey: true }))).toBe(false)
    expect(clipboard.written).toEqual(['copied on a mac'])
  })

  it('leaves Ctrl+C alone on macOS even with a selection', () => {
    // On a Mac the two are different keys, so the overload never arises and
    // Ctrl+C stays what it has always been.
    setPlatform('MacIntel')
    const h = mount()
    selection.text = 'still selected'
    expect(h(key({ key: 'c', ctrlKey: true }))).toBe(true)
    expect(clipboard.written).toEqual([])
  })

  it('leaves paste keys to the browser, so a paste is sent exactly once', async () => {
    // The browser's own paste reaches xterm's textarea, which brackets it.
    // Pasting from a clipboard read as well sent every Cmd+V twice (FB-034):
    // short text doubled, long text arrived as two pastes and did not
    // collapse. false = xterm must not send ^V; nothing else may happen.
    clipboard.text = 'first line\nsecond line'
    setPlatform('Linux x86_64')
    const h = mount()
    expect(h(key({ key: 'v', ctrlKey: true, shiftKey: true }))).toBe(false)
    setPlatform('MacIntel')
    const m = mount()
    expect(m(key({ key: 'v', metaKey: true }))).toBe(false)
    await new Promise((r) => setTimeout(r, 20))
    expect(pasted).toEqual([])
  })

  it('catches a keyboard image paste that xterm stops from bubbling', async () => {
    // A real Cmd+V lands on xterm's textarea, whose handler stops
    // propagation; a bubbling listener on the host never saw it.
    pasteCalls.length = 0
    mount()
    const host = document.querySelector<HTMLDivElement>('[data-term-host]') ?? undefined
    const textarea = document.createElement('textarea')
    textarea.addEventListener('paste', (e) => e.stopPropagation())
    host?.appendChild(textarea)
    const file = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([1]).buffer })
    const ev = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(ev, 'clipboardData', {
      value: { items: [{ kind: 'file', getAsFile: () => file }] },
    })
    textarea.dispatchEvent(ev)
    await vi.waitFor(() => expect(pasteCalls.length).toBe(1))
  })

  /**
   * A pasted image becomes a path.
   *
   * A browser hands over an image's bytes and never a path — there is no path
   * for something copied out of a screenshot tool — and Claude Code reads
   * files by path. The bytes go to the daemon, which writes them, and the path
   * it returns is typed into the session.
   */
  it('sends a pasted image to the daemon and types the path it gets back', async () => {
    const h = mount()
    void h
    const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })
    // jsdom's File has no arrayBuffer(); a browser's does. Supplying it keeps
    // the test about what the component does with the bytes rather than about
    // what jsdom is missing.
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new Uint8Array([1, 2, 3]).buffer,
    })
    const ev = new Event('paste') as ClipboardEvent
    Object.defineProperty(ev, 'clipboardData', {
      value: { items: [{ kind: 'file', getAsFile: () => file }] },
    })
    // The listener is on the element the terminal mounts into, which is the
    // div the component renders — found by ref in the component, and here by
    // taking the last one, since the hint below it renders divs too.
    const host = document.querySelector<HTMLDivElement>('[data-term-host]') ?? undefined
    host?.dispatchEvent(ev)
    await vi.waitFor(() => expect(pasteCalls.length).toBe(1))
    expect(pasteCalls[0]?.type).toBe('image/png')
    expect(pasteCalls[0]?.name).toBe('shot.png')
    // Quoted: a data directory on macOS contains "Application Support", and an
    // unquoted path there is two arguments rather than one.
    await vi.waitFor(() => expect(sent.some((x) => x.includes('"/data/paste/x.png"'))).toBe(true))
  })

  /**
   * Documents dragged from Finder: every file, not only the first, each with
   * its own name — a browser leaves `type` empty for Markdown and CSV, so the
   * name is what the daemon decides by.
   */
  const fileOf = (name: string, type: string) => {
    const f = new File([new Uint8Array([7])], name, { type })
    Object.defineProperty(f, 'arrayBuffer', { value: async () => new Uint8Array([7]).buffer })
    return f
  }
  const drop = (files: File[]) => {
    const host = document.querySelector<HTMLDivElement>('[data-term-host]') ?? undefined
    const ev = new Event('drop', { cancelable: true }) as DragEvent
    Object.defineProperty(ev, 'dataTransfer', { value: { files } })
    host?.dispatchEvent(ev)
    return ev
  }

  it('sends every dropped file, in order, with its name, and types each path quoted', async () => {
    pasteCalls.length = 0
    mount()
    const ev = drop([fileOf('Contract Notes.md', ''), fileOf('scan.pdf', 'application/pdf'), fileOf('data.csv', '')])
    expect(ev.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(pasteCalls.length).toBe(3))
    expect(pasteCalls.map((c) => c.name)).toEqual(['Contract Notes.md', 'scan.pdf', 'data.csv'])
    // The empty type goes as it is: the daemon decides by the name.
    expect(pasteCalls[0]?.type).toBe('')
    await vi.waitFor(() => expect(sent.filter((x) => x.startsWith('"/data/paste/')).length).toBe(3))
    expect(sent.filter((x) => x.startsWith('"/data/paste/'))).toEqual([
      '"/data/paste/d/Contract Notes.md" ',
      '"/data/paste/d/scan.pdf" ',
      '"/data/paste/d/data.csv" ',
    ])
  })

  it('says which file was refused and what is accepted, and still sends the rest', async () => {
    pasteCalls.length = 0
    written.length = 0
    mount()
    drop([fileOf('setup.exe', ''), fileOf('notes.md', '')])
    await vi.waitFor(() => expect(pasteCalls.length).toBe(2))
    await vi.waitFor(() => expect(written.some((w) => w.includes('[caprock: setup.exe: unsupported file type: .exe — accepted: PDF (pdf)'))).toBe(true))
    // Yellow, like every caprock line in the terminal.
    expect(written.find((w) => w.includes('setup.exe'))).toContain('\x1b[33m')
    await vi.waitFor(() => expect(sent).toContain('"/data/paste/d/notes.md" '))
  })

  it('sends every file in a paste, not only the first', async () => {
    pasteCalls.length = 0
    mount()
    const host = document.querySelector<HTMLDivElement>('[data-term-host]') ?? undefined
    const ev = new Event('paste', { cancelable: true }) as ClipboardEvent
    const a = fileOf('a.md', ''), b = fileOf('b.json', '')
    Object.defineProperty(ev, 'clipboardData', {
      value: { items: [{ kind: 'file', getAsFile: () => a }, { kind: 'string', getAsFile: () => null }, { kind: 'file', getAsFile: () => b }] },
    })
    host?.dispatchEvent(ev)
    await vi.waitFor(() => expect(pasteCalls.map((c) => c.name)).toEqual(['a.md', 'b.json']))
  })

  it('leaves an ordinary text paste to xterm', () => {
    // Text pasting already works and already applies bracketed paste;
    // intercepting it would break multi-line pastes.
    pasteCalls.length = 0
    mount()
    const ev = new Event('paste', { cancelable: true }) as ClipboardEvent
    Object.defineProperty(ev, 'clipboardData', { value: { items: [{ kind: 'string' }] } })
    const host2 = document.querySelector<HTMLDivElement>('[data-term-host]') ?? undefined
    host2?.dispatchEvent(ev)
    expect(pasteCalls).toEqual([])
    // And the event is not swallowed: xterm's own paste handling has to run,
    // or a multi-line text paste stops arriving as one bracketed paste.
    expect(ev.defaultPrevented).toBe(false)
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

/**
 * The WebGL renderer, and what happens when it is not there.
 *
 * A machine with no WebGL, a driver that refuses, or a GPU reset mid-session
 * must all leave a working terminal behind — a slower terminal is a cost, a
 * blank one is a broken product. jsdom has no WebGL at all, which makes it the
 * exact environment this has to survive.
 */
describe('rendering', () => {
  it('still renders when WebGL is unavailable', () => {
    // If the addon threw and nothing caught it, the terminal would never
    // reach the DOM and this would find nothing.
    const { container } = render(<TerminalView sessionId="s-webgl" owned />)
    expect(container.querySelector('div')).toBeTruthy()
    expect(document.body.textContent).toMatch(/new line/i)
  })

  it('keeps ten thousand lines of scrollback', () => {
    // A build log scrolls past five thousand easily, and losing the start of
    // what you are reading is where a terminal stops being one you can work
    // in.
    render(<TerminalView sessionId="s-scroll" owned />)
    expect((ctor.mock.calls[0]?.[0] as { scrollback?: number })?.scrollback).toBe(10000)
  })
})
