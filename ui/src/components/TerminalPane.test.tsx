/**
 * The app terminal's find bar (F16) and its live appearance (F21), with xterm,
 * its addons and the socket stubbed: what matters here is which pane answers
 * ⌘F, what reaches the search addon, and that a Settings change re-themes
 * every open pane in place.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  terms: [] as { options: Record<string, unknown>; focused: number }[],
  calls: [] as [string, string, Record<string, unknown>?][],
  results: [] as ((r: { resultIndex: number; resultCount: number }) => void)[],
  clears: 0,
  steps: [] as string[],
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>
    focused = 0
    cols = 80
    rows = 24
    element: HTMLElement | undefined
    buffer = { active: { viewportY: 0, baseY: 0 } }
    constructor(opts: Record<string, unknown>) { this.options = { ...opts }; h.terms.push(this) }
    loadAddon() {}
    open(parent: HTMLElement) { h.steps.push('open'); this.element = document.createElement('div'); parent.appendChild(this.element) }
    focus() { this.focused++ }
    write() {}
    reset() {}
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
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() { h.steps.push('fit') } } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }))
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
    start() {}
    wake() {}
    suspend() {}
    send() { return true }
    resize() {}
    dispose() {}
  },
}))
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })

import { TerminalPane } from './TerminalPane'
import { FIND_EVENT } from '@/lib/appkeys'
import { setTerminalPrefs, DEFAULT_PREFS } from '@/lib/termprefs'

beforeEach(() => {
  h.terms.length = 0
  h.calls.length = 0
  h.results.length = 0
  h.clears = 0
  h.steps.length = 0
  setTerminalPrefs(DEFAULT_PREFS)
})
afterEach(() => setTerminalPrefs(DEFAULT_PREFS))

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
