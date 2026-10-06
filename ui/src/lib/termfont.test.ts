import { describe, expect, it, vi } from 'vitest'
import { loadTerminalFont, terminalFontSamples, watchTerminalFont, TERMINAL_FONT_FAMILY } from './termfont'
import type { Terminal as Xterm } from '@xterm/xterm'

function fakeTerm() {
  const steps: string[] = []
  const options: Record<string, unknown> = {}
  let family = '"JetBrains Mono Variable", Menlo, monospace'
  Object.defineProperty(options, 'fontFamily', {
    get: () => family,
    set: (v: string) => { family = v; steps.push(`family:${v}`) },
  })
  const term = { options, rows: 24, clearTextureAtlas: () => steps.push('atlas'), refresh: () => steps.push('refresh') }
  return { term: term as unknown as Xterm, steps }
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
})
