/**
 * The app terminal's find bar (F16) and its live appearance (F21), with xterm,
 * its addons and the socket stubbed: what matters here is which pane answers
 * ⌘F, what reaches the search addon, and that a Settings change re-themes
 * every open pane in place.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  terms: [] as { options: Record<string, unknown>; focused: number; cols: number; rows: number; buffer: { active: { viewportY: number; baseY: number } }; scrolledTo: number | null }[],
  calls: [] as [string, string, Record<string, unknown>?][],
  results: [] as ((r: { resultIndex: number; resultCount: number }) => void)[],
  clears: 0,
  steps: [] as string[],
  clients: [] as { callbacks: { write: (d: Uint8Array, done: () => void) => void; reset: () => void; state: (s: string) => void; status: (l: unknown) => void } }[],
  reconnects: 0,
  writes: [] as unknown[],
  suspends: 0,
  claims: 0,
  claimSizes: [] as unknown[][],
  blurs: 0,
  webgl: { made: 0, disposed: 0 },
  noInsides: false,
  resizes: [] as number[][],
  wakes: 0,
  /** What the fit addon measures; null as for a pane never laid out. */
  fitSize: null as { cols: number; rows: number } | null,
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>
    focused = 0
    cols = 80
    rows = 24
    element: HTMLElement | undefined
    buffer = { active: { viewportY: 0, baseY: 0 } }
    scrolledTo: number | null = null
    // xterm's render service, as paintNow reaches it.
    _core = { _renderService: { _handleIntersectionChange: () => { h.steps.push('paint') } } }
    constructor(opts: Record<string, unknown>) { this.options = { ...opts }; h.terms.push(this) }
    loadAddon(a: { term?: unknown }) { a.term = this }
    resize(cols: number, rows: number) { this.cols = cols; this.rows = rows }
    open(parent: HTMLElement) { h.steps.push('open'); this.element = document.createElement('div'); parent.appendChild(this.element) }
    focus() { this.focused++ }
    write(d: unknown, cb?: () => void) { h.writes.push(d); cb?.() }
    scrollToLine(n: number) { this.scrolledTo = n }
    reset() { h.writes.push('reset') }
    clearTextureAtlas() { h.steps.push('atlas') }
    refresh() {}
    scrollToBottom() {}
    onData() { return { dispose() {} } }
    onResize() { return { dispose() {} } }
    onWriteParsed() { return { dispose() {} } }
    onScroll() { return { dispose() {} } }
    attachCustomKeyEventHandler() {}
    dispose() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    term?: { resize(c: number, r: number): void }
    fit() {
      h.steps.push('fit')
      if (h.fitSize) this.term?.resize(h.fitSize.cols, h.fitSize.rows)
    }
    proposeDimensions() { return h.fitSize ?? undefined }
  },
}))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    constructor() { h.webgl.made++; h.steps.push('webgl') }
    // The addon's insides reuploadGlyphs reaches; null in a test of the fallback.
    _renderer = h.noInsides ? undefined : { _charAtlas: {}, _glyphRenderer: { value: { setAtlas: () => { h.steps.push('upload') } } } }
    onContextLoss() {}
    dispose() { h.webgl.disposed++ }
  },
}))
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    findNext(q: string, o: Record<string, unknown>) { h.calls.push(['next', q, o]); return true }
    findPrevious(q: string, o: Record<string, unknown>) {
      if (o.regex && q === '(') throw new SyntaxError('Invalid regular expression')
      h.calls.push(['prev', q, o]); return true
    }
    clearDecorations() { h.clears++ }
    onDidChangeResults(fn: (r: { resultIndex: number; resultCount: number }) => void) { h.results.push(fn); return { dispose() {} } }
  },
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('@/lib/termv2', () => ({
  TermClient: class {
    state = 'connecting'
    protocol = 'v2'
    constructor(opts: (typeof h.clients)[number]) { h.clients.push(opts) }
    reconnectNow() { h.reconnects++ }
    start() {}
    wake() { h.wakes++ }
    suspend() { h.suspends++ }
    send() { return true }
    resize(cols: number, rows: number) { h.resizes.push([cols, rows]) }
    focus(...size: unknown[]) { h.claims++; h.claimSizes.push(size) }
    blur() { h.blurs++ }
    dispose() {}
  },
}))
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })

import { HIDDEN_DISCONNECT_MS, HIDDEN_HOLD_BYTES, KEEP_WEBGL_HIDDEN, LONG_HIDDEN_MS, SETTLE_MS, TerminalPane, keptWebglCount } from './TerminalPane'
import { WEBGL_QUIET_MS } from './Terminal'
import { FIND_EVENT } from '@/lib/appkeys'
import { setTerminalPrefs, DEFAULT_PREFS } from '@/lib/termprefs'
import { APP_UPDATE_EVENT } from '@/lib/appupdate'
import { RESUME_KEY } from '@/lib/termresume'

beforeEach(() => {
  h.terms.length = 0
  h.calls.length = 0
  h.results.length = 0
  h.clears = 0
  h.steps.length = 0
  h.clients.length = 0
  h.writes.length = 0
  h.suspends = 0
  h.claims = 0
  h.claimSizes.length = 0
  h.blurs = 0
  h.webgl.made = 0
  h.webgl.disposed = 0
  h.resizes.length = 0
  h.wakes = 0
  h.reconnects = 0
  h.fitSize = { cols: 120, rows: 40 }
  localStorage.clear()
  setTerminalPrefs(DEFAULT_PREFS)
  // Laid out: jsdom measures every box as zero.
  widthSpy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
})
let widthSpy: { mockRestore(): void } | undefined
afterEach(() => {
  widthSpy?.mockRestore()
  setTerminalPrefs(DEFAULT_PREFS)
})

const find = () => act(() => { window.dispatchEvent(new Event(FIND_EVENT)) })

describe('TerminalPane find (F16)', () => {
  it('opens only in the focused pane of the tab in front, and searches as you type', () => {
    render(
      <>
        <TerminalPane sessionId="a" active focused />
        <TerminalPane sessionId="b" active focused={false} />
        <TerminalPane sessionId="c" active={false} focused />
      </>,
    )
    find()
    const bars = screen.getAllByRole('search')
    expect(bars).toHaveLength(1)
    const input = screen.getByLabelText('Find')
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: 'error' } })
    const [dir, q, o] = h.calls.at(-1)!
    expect([dir, q]).toEqual(['next', 'error'])
    expect(o).toMatchObject({ caseSensitive: false, regex: false, incremental: true })
    expect((o!.decorations as Record<string, string>).matchBackground).toMatch(/^#[0-9a-f]{6}$/)
    // The pane that opened it is the one that hears its results.
    act(() => h.results[0]!({ resultIndex: 2, resultCount: 7 }))
    expect(screen.getByText('3 of 7')).toBeTruthy()
  })

  it('walks matches with Enter and Shift+Enter and honours the toggles', () => {
    render(<TerminalPane sessionId="a" active focused />)
    find()
    const input = screen.getByLabelText('Find')
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Match case' }))
    fireEvent.click(screen.getByRole('button', { name: 'Regular expression' }))
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(h.calls.at(-1)).toMatchObject(['next', 'x', { caseSensitive: true, regex: true }])
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(h.calls.at(-1)).toMatchObject(['prev', 'x', { caseSensitive: true, regex: true }])
    fireEvent.change(input, { target: { value: '(' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(screen.getByText('Invalid pattern')).toBeTruthy()
  })

  it('closes on Esc, clears the highlights and gives the keyboard back to the terminal', () => {
    render(<TerminalPane sessionId="a" active focused />)
    find()
    const focusedBefore = h.terms[0]!.focused
    fireEvent.keyDown(screen.getByLabelText('Find'), { key: 'Escape' })
    expect(screen.queryByRole('search')).toBeNull()
    expect(h.clears).toBeGreaterThan(0)
    expect(h.terms[0]!.focused).toBeGreaterThan(focusedBefore)
  })

  it('turns on the API the highlights need', () => {
    render(<TerminalPane sessionId="a" active focused />)
    expect(h.terms[0]!.options.allowProposedApi).toBe(true)
  })
})

describe('TerminalPane appearance (F21)', () => {
  it('opens with the stored prefs and follows a change in every pane, in place', () => {
    setTerminalPrefs({ theme: 'tokyo-night', fontSize: 15 })
    render(
      <>
        <TerminalPane sessionId="a" active focused />
        <TerminalPane sessionId="b" active={false} />
      </>,
    )
    expect(h.terms).toHaveLength(2)
    expect((h.terms[0]!.options.theme as { background: string }).background).toBe('#1a1b26')
    expect(h.terms[0]!.options.fontSize).toBe(15)
    act(() => setTerminalPrefs({ theme: 'paper', cursor: 'block', lineHeight: 1.3, font: 'menlo' }))
    // Re-themed, not re-created.
    expect(h.terms).toHaveLength(2)
    for (const t of h.terms) {
      expect((t.options.theme as { background: string }).background).toBe('#efe7d6')
      expect(t.options.cursorStyle).toBe('block')
      expect(t.options.lineHeight).toBe(1.3)
      expect(String(t.options.fontFamily)).toMatch(/^Menlo, /)
      expect(t.options.minimumContrastRatio).toBe(4.5)
    }
  })
})

describe('TerminalPane font', () => {
  it('asks for every subset of the face before it opens and first fits, and redraws when it lands', async () => {
    // xterm measures the cell when it opens, and the WebGL atlas keeps every
    // glyph it rasterised. Waiting on document.fonts.ready alone asked for
    // nothing, so the app terminal measured and drew in whatever face had
    // happened to load (lib/termfont).
    let land!: () => void
    const landed = new Promise<void>((r) => { land = r })
    const load = vi.fn((font: string, text: string) => {
      h.steps.push(`font:${font}:${text}`)
      return landed.then(() => [])
    })
    const fonts = { load, check: () => false, addEventListener() {}, removeEventListener() {}, ready: Promise.resolve() }
    const real = Object.getOwnPropertyDescriptor(document, 'fonts')
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    try {
      render(<TerminalPane sessionId="a" active focused />)
      const first = (p: string) => h.steps.findIndex((s) => s.startsWith(p))
      expect(first('font:')).toBeGreaterThanOrEqual(0)
      expect(first('font:')).toBeLessThan(first('open'))
      expect(first('open')).toBeLessThan(first('fit'))
      // Regular and bold, in the bundled face, for Latin, Greek and the rest.
      const asked = load.mock.calls
      expect(asked.every(([f]) => f.includes('"JetBrains Mono Variable"'))).toBe(true)
      expect(asked.some(([f]) => f.startsWith('700 '))).toBe(true)
      expect(asked.map(([, t]) => t).join('')).toMatch(/Ω/)
      expect(h.steps).not.toContain('atlas')
      // The face lands: the cell is measured again, the atlas rebuilt, the pane fitted.
      const fitsBefore = h.steps.filter((s) => s === 'fit').length
      await act(async () => { land() })
      await vi.waitFor(() => expect(h.steps).toContain('atlas'))
      expect(h.steps.filter((s) => s === 'fit').length).toBeGreaterThan(fitsBefore)
    } finally {
      width.mockRestore()
      if (real) Object.defineProperty(document, 'fonts', real)
      else delete (document as { fonts?: unknown }).fonts
    }
  })
})

describe('TerminalPane across an app update (F20)', () => {
  it('saves where it was scrolled as the update installs and goes back there after the relaunch', () => {
    vi.useFakeTimers()
    try {
      const first = render(<TerminalPane sessionId="a" active focused />)
      h.terms[0]!.buffer.active = { viewportY: 100, baseY: 500 }
      act(() => { window.dispatchEvent(new CustomEvent(APP_UPDATE_EVENT, { detail: { phase: 'installing', next: '0.79.0' } })) })
      expect(JSON.parse(localStorage.getItem(RESUME_KEY)!).panes.a).toEqual({ top: 100, total: 540, fromBottom: 400 })
      first.unmount()

      // The relaunched page: the replay lands at the bottom, then pauses.
      render(<TerminalPane sessionId="a" active focused />)
      const t = h.terms[1]!
      t.buffer.active = { viewportY: 500, baseY: 500 }
      act(() => h.clients[1]!.callbacks.write(new TextEncoder().encode('scrollback'), () => {}))
      expect(t.scrolledTo).toBeNull()
      act(() => { vi.advanceTimersByTime(500) })
      expect(t.scrolledTo).toBe(100)
      // Once: a later launch starts at the bottom.
      expect(JSON.parse(localStorage.getItem(RESUME_KEY)!).panes.a).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a terminal at the bottom saves nothing and stays at the bottom', () => {
    vi.useFakeTimers()
    try {
      const first = render(<TerminalPane sessionId="b" active focused />)
      h.terms[0]!.buffer.active = { viewportY: 500, baseY: 500 }
      act(() => { window.dispatchEvent(new CustomEvent(APP_UPDATE_EVENT, { detail: { phase: 'installing' } })) })
      first.unmount()
      render(<TerminalPane sessionId="b" active focused />)
      act(() => h.clients[1]!.callbacks.write(new TextEncoder().encode('x'), () => {}))
      act(() => { vi.advanceTimersByTime(4000) })
      expect(h.terms[1]!.scrolledTo).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a hidden pane does no terminal work', () => {
  const bytes = (n: number) => new Uint8Array(n).fill(120)

  // A pane that has been in front once, so fitted to its box.
  const behind = () => {
    const r = render(<TerminalPane sessionId="a" active />)
    r.rerender(<TerminalPane sessionId="a" active={false} />)
    return r
  }

  it('draws its first output while hidden, then holds what comes until it is shown', () => {
    vi.useFakeTimers()
    try {
      const { rerender } = behind()
      const write = h.clients[0]!.callbacks.write
      // The replay a tab opens with is drawn in the background.
      act(() => write(bytes(10), () => {}))
      expect(h.writes).toHaveLength(1)
      act(() => { vi.advanceTimersByTime(SETTLE_MS) })
      // After that, nothing reaches xterm while the tab is out of sight, and
      // the client is told nothing is parsed yet.
      const done = vi.fn()
      act(() => { write(bytes(5), done); write(bytes(6), done) })
      expect(h.writes).toHaveLength(1)
      expect(done).not.toHaveBeenCalled()
      // Shown: everything held, in order, before anything newer.
      rerender(<TerminalPane sessionId="a" active />)
      expect(h.writes.map((w) => (w as Uint8Array).length)).toEqual([10, 5, 6])
      expect(done).toHaveBeenCalledTimes(2)
      act(() => write(bytes(7), () => {}))
      expect(h.writes).toHaveLength(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a repaint while hidden drops what it replaces and keeps its place in line', () => {
    vi.useFakeTimers()
    try {
      const { rerender } = behind()
      const { write, reset } = h.clients[0]!.callbacks
      act(() => write(bytes(1), () => {}))
      act(() => { vi.advanceTimersByTime(SETTLE_MS) })
      const stale = vi.fn()
      act(() => { write(bytes(2), stale); reset(); write(bytes(3), () => {}) })
      // The client hears the stale bytes are done with; xterm never sees them.
      expect(stale).toHaveBeenCalledTimes(1)
      expect(h.writes).toHaveLength(1)
      rerender(<TerminalPane sessionId="a" active />)
      expect(h.writes.slice(1).map((w) => (typeof w === 'string' ? w : (w as Uint8Array).length))).toEqual(['reset', 3])
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets the socket go past the hold limit, so the daemon keeps the rest', () => {
    vi.useFakeTimers()
    try {
      behind()
      const write = h.clients[0]!.callbacks.write
      act(() => write(bytes(1), () => {}))
      act(() => { vi.advanceTimersByTime(SETTLE_MS) })
      act(() => write(bytes(HIDDEN_HOLD_BYTES), () => {}))
      expect(h.suspends).toBe(0)
      act(() => write(bytes(1), () => {}))
      expect(h.suspends).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a pane in front writes at once', () => {
    vi.useFakeTimers()
    try {
      render(<TerminalPane sessionId="a" active />)
      const write = h.clients[0]!.callbacks.write
      act(() => { vi.advanceTimersByTime(SETTLE_MS) })
      act(() => write(bytes(3), () => {}))
      act(() => write(bytes(4), () => {}))
      expect(h.writes).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

// A tab restored behind another has never been laid out, so its xterm is at
// the default 80x24. The replay it opens with was drawn at the PTY's width;
// parsed 80 wide, Claude Code's cursor moves land on the wrong rows and leave
// smeared rules and repeated status rows in the scrollback, which no later
// reflow undoes (user report, 2026-10-13).
describe('a pane never laid out', () => {
  const bytes = (n: number) => new Uint8Array(n).fill(120)

  it('holds its replay and sends no size until it is shown and fitted, then writes it at that size', () => {
    vi.useFakeTimers()
    try {
      const { rerender } = render(<TerminalPane sessionId="a" active={false} />)
      const { write, open } = h.clients[0]!.callbacks as typeof h.clients[0]['callbacks'] & { open: () => void }
      act(() => open())
      const done = vi.fn()
      act(() => write(bytes(10), done))
      act(() => { vi.advanceTimersByTime(SETTLE_MS) })
      act(() => write(bytes(5), done))
      // Nothing parsed at 80x24, and the daemon was not told 80x24.
      expect(h.writes).toHaveLength(0)
      expect(h.resizes).toEqual([])
      expect(done).not.toHaveBeenCalled()
      rerender(<TerminalPane sessionId="a" active />)
      const t = h.terms[0]!
      expect([t.cols, t.rows]).toEqual([120, 40])
      expect(h.resizes[0]).toEqual([120, 40])
      expect(h.writes.map((w) => (w as Uint8Array).length)).toEqual([10, 5])
      expect(done).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps holding while shown but not yet measurable, and claims without a size', () => {
    h.fitSize = null
    const { rerender } = render(<TerminalPane sessionId="a" active={false} />)
    rerender(<TerminalPane sessionId="a" active />)
    act(() => h.clients[0]!.callbacks.write(bytes(3), () => {}))
    expect(h.writes).toHaveLength(0)
    expect(h.resizes).toEqual([])
    expect(h.claimSizes.at(-1)).toEqual([])
  })
})

// One PTY, several terminals: the one in use sizes it (internal/api/termsize.go).
// A phone that typed into the session left the agent 45 columns wide in the
// app's pane until the pane's box next changed (Vova, 2026-10-12). Typing
// claims the PTY on the daemon's side; looking at the pane claims it here.
describe('a pane claims the PTY when it is looked at', () => {
  it('on coming to the front, on the window gaining focus or coming into view, and on a click', () => {
    const { container, rerender } = render(<TerminalPane sessionId="a" active={false} />)
    expect(h.claims).toBe(0)
    rerender(<TerminalPane sessionId="a" active />)
    expect(h.claims).toBe(1)
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(h.claims).toBe(2)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(h.claims).toBe(3)
    const host = container.querySelector('[data-term-host]')!
    fireEvent.pointerDown(host)
    expect(h.claims).toBe(4)
  })

  it('never from a tab out of sight', () => {
    render(<TerminalPane sessionId="a" active={false} />)
    act(() => { window.dispatchEvent(new Event('focus')) })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(h.claims).toBe(0)
  })

  // Vova (2026-10-13): the phone put away, the pane stayed drawn at the
  // phone's width until the session was reopened.
  it('with its size, so a PTY left at another terminal\'s size is put right by looking', () => {
    render(<TerminalPane sessionId="a" active />)
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(h.claimSizes.at(-1)).toEqual([120, 40])
  })

  it('on focus anywhere in the pane, the composer included', () => {
    const { container } = render(<TerminalPane sessionId="a" active />)
    const before = h.claims
    const field = document.createElement('textarea')
    container.firstElementChild!.appendChild(field)
    act(() => { field.focus() })
    expect(h.claims).toBe(before + 1)
  })

  it('and gives it back on going out of sight: behind another tab, the window hidden, the page gone', () => {
    const { rerender } = render(<TerminalPane sessionId="a" active />)
    const before = h.blurs
    rerender(<TerminalPane sessionId="a" active={false} />)
    expect(h.blurs).toBe(before + 1)
    rerender(<TerminalPane sessionId="a" active />)
    const claims = h.claims
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(h.blurs).toBe(before + 2)
    expect(h.claims).toBe(claims)
    vis.mockRestore()
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    expect(h.blurs).toBe(before + 3)
  })
})

// The owner saw the font "redrawn from scratch" for a moment on a tab switch
// (2026-10-14): a tab hidden 30 s came back on the DOM renderer and had WebGL
// swapped in 1.5 s later; one hidden for less had its glyph atlas cleared.
describe('switching tabs shows the terminal as it was', () => {
  let width: { mockRestore: () => void }
  beforeEach(() => {
    vi.useFakeTimers()
    width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  })
  afterEach(() => {
    width.mockRestore()
    vi.useRealTimers()
  })

  // A pane in front with output and WebGL in, as after a minute of work.
  const working = (id: string) => {
    const r = render(<TerminalPane sessionId={id} active />)
    const client = h.clients.at(-1)!
    act(() => client.callbacks.write(new TextEncoder().encode('$ ls'), () => {}))
    act(() => { vi.advanceTimersByTime(WEBGL_QUIET_MS + 10) })
    return r
  }
  const count = (step: string) => h.steps.filter((s) => s === step).length

  it('back and forth: no new renderer, no atlas rebuilt, no refit, even past the socket\'s 30 s', () => {
    const { rerender } = working('a')
    expect(h.webgl.made).toBe(1)
    const fits = count('fit')
    const paints = count('paint')
    for (const away of [2_000, HIDDEN_DISCONNECT_MS + 5_000]) {
      rerender(<TerminalPane sessionId="a" active={false} />)
      act(() => { vi.advanceTimersByTime(away) })
      rerender(<TerminalPane sessionId="a" active />)
    }
    expect(h.webgl).toEqual({ made: 1, disposed: 0 })
    expect(h.steps).not.toContain('atlas')
    expect(count('fit')).toBe(fits)
    // Drawn in the frame it appears in, not the one after.
    expect(count('paint')).toBe(paints + 2)
  })

  it('a pane that let its WebGL go gets it back in show(), before the first paint, with no quiet wait', () => {
    const panes = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, r: working(id) }))
    expect(h.webgl.made).toBe(5)
    // All five behind another tab, a first: only the three hidden last keep a context.
    for (const p of panes) p.r.rerender(<TerminalPane sessionId={p.id} active={false} />)
    expect(keptWebglCount()).toBe(KEEP_WEBGL_HIDDEN)
    expect(h.webgl.disposed).toBe(5 - KEEP_WEBGL_HIDDEN)
    // a comes back: a renderer at once (no timer advanced), then the fit, then the frame.
    h.steps.length = 0
    panes[0]!.r.rerender(<TerminalPane sessionId="a" active />)
    expect(h.webgl.made).toBe(6)
    expect(h.steps.indexOf('webgl')).toBeGreaterThanOrEqual(0)
    expect(h.steps.indexOf('webgl')).toBeLessThan(h.steps.indexOf('fit'))
    expect(h.steps.indexOf('fit')).toBeLessThan(h.steps.lastIndexOf('paint'))
    // Shown, it is not counted; hidden again it is, and c, hidden longest ago, lets its go.
    expect(keptWebglCount()).toBe(KEEP_WEBGL_HIDDEN)
    panes[0]!.r.rerender(<TerminalPane sessionId="a" active={false} />)
    expect(keptWebglCount()).toBe(KEEP_WEBGL_HIDDEN)
    expect(h.webgl.disposed).toBe(5 - KEEP_WEBGL_HIDDEN + 1)
  })

  it('a pane still waiting for its first output keeps the quiet path', () => {
    render(<TerminalPane sessionId="a" active />)
    expect(h.webgl.made).toBe(0)
    act(() => h.clients[0]!.callbacks.write(new TextEncoder().encode('x'), () => {}))
    expect(h.webgl.made).toBe(0)
    act(() => { vi.advanceTimersByTime(WEBGL_QUIET_MS * 2 + 10) })
    expect(h.webgl.made).toBe(1)
  })

  // #541: WebKit drops the atlas's texture without a contextlost event; the
  // squashed, half-cut letters must not come back.
  it('rebuilds the atlas after a long hide, and after a wake it missed while hidden', () => {
    const { rerender } = working('a')
    rerender(<TerminalPane sessionId="a" active={false} />)
    act(() => { vi.advanceTimersByTime(LONG_HIDDEN_MS + 1) })
    rerender(<TerminalPane sessionId="a" active />)
    expect(count('atlas')).toBe(1)

    rerender(<TerminalPane sessionId="a" active={false} />)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(count('atlas')).toBe(1)
    rerender(<TerminalPane sessionId="a" active />)
    expect(count('atlas')).toBe(2)

    // In front, a window back in view rebuilds it at once.
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(count('atlas')).toBe(3)
  })

  // The owner, 2026-10-14: garbled glyphs for about 2 s after closing a tab
  // (its neighbour came to the front), and after the chat. Every way back
  // into view is active false -> true here: a switch, the tab in front
  // closed, back from the dashboard (⌘0), back from the chat.
  it('every way back into view re-sends the atlas to the GPU before the frame it appears in, rasterising nothing', () => {
    const { rerender } = working('a')
    for (const away of [50, 2_000, HIDDEN_DISCONNECT_MS + 5_000]) {
      rerender(<TerminalPane sessionId="a" active={false} />)
      act(() => { vi.advanceTimersByTime(away) })
      h.steps.length = 0
      rerender(<TerminalPane sessionId="a" active />)
      expect(count('upload')).toBe(1)
      expect(h.steps.indexOf('upload')).toBeLessThan(h.steps.lastIndexOf('paint'))
      expect(h.steps).not.toContain('atlas')
    }
    expect(h.webgl).toEqual({ made: 1, disposed: 0 })
  })

  it('held output under a cover is written on the way back, in the same show', () => {
    const { rerender } = working('a')
    const client = h.clients.at(-1)!
    rerender(<TerminalPane sessionId="a" active={false} />)
    act(() => { vi.advanceTimersByTime(1_000) })
    const writes = h.writes.length
    act(() => client.callbacks.write(new TextEncoder().encode('covered'), () => {}))
    expect(h.writes).toHaveLength(writes)
    rerender(<TerminalPane sessionId="a" active />)
    expect(h.writes).toHaveLength(writes + 1)
  })

  // The atlas is shared: one pane rebuilding it must make every other pane
  // forget the glyph positions it cached (owner, 2026-10-14: rows of garbage
  // in a tab after another tab came back from a long hide).
  it('a pane that rebuilds the atlas has every other pane rebuild its cells too', () => {
    const a = working('a')
    const b = working('b')
    b.rerender(<TerminalPane sessionId="b" active={false} />)
    act(() => { vi.advanceTimersByTime(LONG_HIDDEN_MS + 1) })
    h.steps.length = 0
    b.rerender(<TerminalPane sessionId="b" active />)
    // b's own and a's, a still on screen in the tab beside it.
    expect(count('atlas')).toBe(2)
    a.unmount()
    b.rerender(<TerminalPane sessionId="b" active={false} />)
    act(() => { vi.advanceTimersByTime(LONG_HIDDEN_MS + 1) })
    h.steps.length = 0
    b.rerender(<TerminalPane sessionId="b" active />)
    expect(count('atlas')).toBe(1)
  })

  // The installed addon still has what reuploadGlyphs reaches for: an
  // upgrade that renames it would quietly fall back to rasterising.
  it('the installed WebGL addon has the insides the re-upload uses', () => {
    const src = readFileSync(join(process.cwd(), 'node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs'), 'utf8')
    expect(src).toContain('_glyphRenderer.value?.setAtlas(')
    expect(src).toMatch(/setAtlas\(\w\)\{this\._atlas=\w;for\(let \w of this\._atlasTextures\)\w\.version=-1\}/)
    expect(src).toContain('this._charAtlas=')
    expect(src).toContain('this._renderer=this._register(')
  })

  it('rebuilds the atlas instead when the addon\'s insides are not there (another version)', () => {
    h.noInsides = true
    try {
      const { rerender } = working('a')
      rerender(<TerminalPane sessionId="a" active={false} />)
      h.steps.length = 0
      rerender(<TerminalPane sessionId="a" active />)
      expect(count('upload')).toBe(0)
      expect(count('atlas')).toBe(1)
      expect(h.steps.indexOf('atlas')).toBeLessThan(h.steps.lastIndexOf('paint'))
    } finally {
      h.noInsides = false
    }
  })
})

// Vova, 2026-10-15: after a Wi-Fi drop every tab sat at "Reconnecting…" and
// the only way out was closing it. The badge says how it stands, and offers a
// retry by hand once the automatic ones have failed a few times.
describe('a terminal that is reconnecting says how it stands', () => {
  const ready = () => act(() => { h.clients[0]!.callbacks.write(new TextEncoder().encode('ready'), () => {}) })
  const down = (attempt: number, inMs: number) => act(() => {
    const c = h.clients[0]!.callbacks
    c.state('reconnecting')
    c.status({ phase: 'reconnecting', attempt, nextAt: Date.now() + inMs, downSince: Date.now() - 1_000 })
  })

  it('with the attempt and the next try, and Reconnect now once the retries keep failing', () => {
    render(<TerminalPane sessionId="a" active />)
    ready()
    down(1, 4_000)
    expect(screen.getByText(/Reconnecting \(2\) · next try in 4 s/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Reconnect now' })).toBeNull()
    down(3, 9_000)
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect now' }))
    expect(h.reconnects).toBe(1)
    act(() => { h.clients[0]!.callbacks.state('live') })
    expect(screen.queryByText(/Reconnecting/)).toBeNull()
  })

  it('before its first output too', () => {
    render(<TerminalPane sessionId="a" active />)
    down(4, 2_000)
    expect(screen.getByText('Connecting to the session…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect now' }))
    expect(h.reconnects).toBe(1)
  })

  it('checks its socket when the window gets focus, as on visibility and online', () => {
    render(<TerminalPane sessionId="a" active />)
    const before = h.wakes
    act(() => { window.dispatchEvent(new Event('focus')) })
    act(() => { window.dispatchEvent(new Event('online')) })
    expect(h.wakes).toBe(before + 2)
  })
})
