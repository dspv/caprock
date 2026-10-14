import { describe, expect, it, vi } from 'vitest'
import { MAX_CELL_RETRIES, cellRatio, checkTerminalCell, clearGlyphAtlas, implausibleCell, loadTerminalFont, terminalFontSamples, watchTerminalFont, TERMINAL_FONT_FAMILY } from './termfont'
import type { Terminal as Xterm } from '@xterm/xterm'

function fakeTerm() {
  const steps: string[] = []
  const options: Record<string, unknown> = {}
  let family = '"JetBrains Mono Variable", Menlo, monospace'
  Object.defineProperty(options, 'fontFamily', {
    get: () => family,
    set: (v: string) => { family = v; steps.push(`family:${v}`) },
  })
  options.fontSize = 13
  const cell = { width: 7.8 }
  const term = { options, rows: 24, clearTextureAtlas: () => steps.push('atlas'), refresh: () => steps.push('refresh'), _core: { _renderService: { dimensions: { css: { cell } } } } }
  return { term: term as unknown as Xterm, steps, cell }
}

function fakeFonts(loaded: boolean) {
  const listeners: ((e: Event) => void)[] = []
  return {
    load: vi.fn().mockResolvedValue([]),
    check: vi.fn(() => loaded),
    addEventListener: (_: string, f: (e: Event) => void) => { listeners.push(f) },
    removeEventListener: (_: string, f: (e: Event) => void) => { listeners.splice(listeners.indexOf(f), 1) },
    fire: (family: string) => { for (const f of [...listeners]) f(Object.assign(new Event('loadingdone'), { fontfaces: [{ family }] })) },
    listeners,
  }
}

describe('termfont', () => {
  it('asks for every subset in regular and bold', async () => {
    const fonts = fakeFonts(false)
    await loadTerminalFont(fonts as unknown as FontFaceSet)
    const calls = fonts.load.mock.calls as [string, string][]
    expect(calls).toHaveLength(terminalFontSamples().length * 2)
    expect(calls.every(([f]) => f.endsWith(TERMINAL_FONT_FAMILY))).toBe(true)
    expect(new Set(calls.map(([f]) => f.split(' ')[0]))).toEqual(new Set(['400', '700']))
    // Six subsets, one sample each; the Cyrillic two are built at run time.
    expect(terminalFontSamples().map((s) => s.codePointAt(0))).toEqual([0x41, 0x101, 0x42b, 0x462, 0x3a9, 0x1ebf])
  })

  it('re-measures, drops the atlas and refits once the faces land', async () => {
    const fonts = fakeFonts(false)
    const { term, steps } = fakeTerm()
    const after = vi.fn()
    const stop = watchTerminalFont(term, after, fonts as unknown as FontFaceSet)
    await vi.waitFor(() => expect(after).toHaveBeenCalledTimes(1))
    // The family is changed and put back — that is what makes xterm measure.
    expect(steps).toEqual(['family:monospace', 'family:"JetBrains Mono Variable", Menlo, monospace', 'atlas', 'refresh'])
    stop()
    expect(fonts.listeners).toHaveLength(0)
  })

  it('does nothing at open when the faces are in, and answers only faces in its stack', async () => {
    const fonts = fakeFonts(true)
    const { term, steps } = fakeTerm()
    const after = vi.fn()
    const stop = watchTerminalFont(term, after, fonts as unknown as FontFaceSet)
    expect(fonts.load).not.toHaveBeenCalled()
    fonts.fire('Hanken Grotesk Variable')
    await new Promise((r) => requestAnimationFrame(r))
    expect(steps).toEqual([])
    fonts.fire('Menlo')
    await vi.waitFor(() => expect(after).toHaveBeenCalledTimes(1))
    expect(steps).toContain('atlas')
    stop()
  })

  // The owner, 2026-10-14: rows of garbage glyphs in one tab after another
  // tab rebuilt the atlas — xterm shares it among terminals of one face, and
  // clearTextureAtlas() forgets only the caller's cell model.
  it('clears the shared atlas for every live terminal, never one alone, and stops counting a terminal once it is gone', () => {
    const fonts = fakeFonts(true)
    const a = fakeTerm()
    const b = fakeTerm()
    const c = fakeTerm()
    const stopA = watchTerminalFont(a.term, () => {}, fonts as unknown as FontFaceSet)
    const stopB = watchTerminalFont(b.term, () => {}, fonts as unknown as FontFaceSet)
    clearGlyphAtlas(a.term)
    for (const t of [a, b]) expect(t.steps).toEqual(['atlas', 'refresh'])
    // One not watched still gets it when it asks.
    clearGlyphAtlas(c.term)
    expect(c.steps).toEqual(['atlas', 'refresh'])
    expect(b.steps).toEqual(['atlas', 'refresh', 'atlas', 'refresh'])
    stopB()
    clearGlyphAtlas(a.term)
    expect(b.steps).toHaveLength(4)
    expect(a.steps).toHaveLength(6)
    stopA()
  })

  it('judges a cell by its width over the font size', () => {
    const { term, cell } = fakeTerm()
    expect(cellRatio(term)).toBeCloseTo(0.6, 1)
    expect(implausibleCell(cellRatio(term))).toBe(false)
    cell.width = 23.4 // three times too wide, as the owner saw it
    expect(implausibleCell(cellRatio(term))).toBe(true)
    cell.width = 4
    expect(implausibleCell(cellRatio(term))).toBe(true)
    // Nothing measured yet (a pane never laid out): no verdict.
    cell.width = 0
    expect(cellRatio(term)).toBeUndefined()
    expect(implausibleCell(undefined)).toBe(false)
  })

  // The owner, 2026-10-14, after an update restarted the app: every glyph
  // in a cell about three times too wide until font size + then − made
  // xterm measure again.
  it('measures again while the cell is implausible, until it is right, a few times at most', async () => {
    const fonts = fakeFonts(true)
    const { term, steps, cell } = fakeTerm()
    cell.width = 23.4
    // The second measurement comes out right.
    const after = vi.fn(() => { cell.width = 7.8 })
    const stop = watchTerminalFont(term, after, fonts as unknown as FontFaceSet)
    await vi.waitFor(() => expect(after).toHaveBeenCalledTimes(1))
    expect(steps.slice(0, 2)).toEqual(['family:monospace', 'family:"JetBrains Mono Variable", Menlo, monospace'])
    for (let i = 0; i < 6; i++) await new Promise((r) => requestAnimationFrame(r))
    expect(after).toHaveBeenCalledTimes(1)
    // Shown later and wrong again: checked on request, fixed again.
    cell.width = 23.4
    checkTerminalCell(term)
    await vi.waitFor(() => expect(after).toHaveBeenCalledTimes(2))
    stop()

    // One that never comes right stops after MAX_CELL_RETRIES.
    const stuck = fakeTerm()
    stuck.cell.width = 23.4
    const tries = vi.fn()
    const stop2 = watchTerminalFont(stuck.term, tries, fonts as unknown as FontFaceSet)
    for (let i = 0; i < 4 * (MAX_CELL_RETRIES + 3); i++) await new Promise((r) => requestAnimationFrame(r))
    expect(tries).toHaveBeenCalledTimes(MAX_CELL_RETRIES)
    stop2()
  })

  it('a plausible cell is left alone', async () => {
    const fonts = fakeFonts(true)
    const { term, steps } = fakeTerm()
    const stop = watchTerminalFont(term, () => {}, fonts as unknown as FontFaceSet)
    for (let i = 0; i < 6; i++) await new Promise((r) => requestAnimationFrame(r))
    expect(steps).toEqual([])
    stop()
  })
})
