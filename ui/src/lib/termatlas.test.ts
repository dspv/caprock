import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { healAtlasMerges, reuploadGlyphs } from './termatlas'

/**
 * The texture side of xterm's WebGL renderer, as the addon (0.19) has it: a
 * unit is uploaded when the page at its index has a version other than the
 * one last uploaded there, and `setAtlas` marks every unit stale.
 */
function fakeRenderer(pages: { version: number }[]) {
  const units = pages.map(() => -1)
  const uploaded: number[] = []
  const glyphs = {
    setAtlas: () => { units.fill(-1) },
    render: () => {
      for (let i = 0; i < pages.length; i++) {
        if (pages[i]!.version !== units[i]) { units[i] = pages[i]!.version; uploaded.push(i) }
      }
    },
  }
  let listener: (() => void) | undefined
  const addon = {
    _renderer: { _charAtlas: { pages }, _glyphRenderer: { value: glyphs } },
    onRemoveTextureAtlasCanvas: (fn: () => void) => { listener = fn; return { dispose: () => { listener = undefined } } },
  }
  return { addon, glyphs, uploaded, units, merge: () => listener?.() }
}

describe('healAtlasMerges', () => {
  // The addon's own sequence, two merges in: the first merged page sat at
  // unit 12 at version 1; the second merged page lands at index 12, also at
  // version 1, and the renderer kept the first one's pixels there.
  it('a page swapped in at the same index with the same version is uploaded again', async () => {
    const pages = Array.from({ length: 16 }, (_, i) => ({ version: 100 + i }))
    pages[12] = { version: 1 }
    const r = fakeRenderer(pages)
    const refreshed: number[] = []
    healAtlasMerges(r.addon, { rows: 24, refresh: (a: number, b: number) => { refreshed.push(a, b) } })
    r.glyphs.render()
    r.uploaded.length = 0

    // Without the heal: the swap goes unnoticed.
    pages[12] = { version: 1 }
    r.glyphs.render()
    expect(r.uploaded).toEqual([])

    // With it: the merge's events mark every unit stale before the frame's upload.
    for (let i = 0; i < 4; i++) r.merge()
    r.glyphs.render()
    expect(r.uploaded).toContain(12)
    expect(r.uploaded).toHaveLength(16)
    await Promise.resolve()
    // One full redraw for the four events: cells drawn before the merge point at shifted pages.
    expect(refreshed).toEqual([0, 23])
  })

  it('falls back (once) when the addon has not the insides, and stops on dispose', async () => {
    let listener: (() => void) | undefined
    const addon = { onRemoveTextureAtlasCanvas: (fn: () => void) => { listener = fn; return { dispose: () => { listener = undefined } } } }
    let fallbacks = 0
    const sub = healAtlasMerges(addon, { rows: 24, refresh: () => {} }, () => { fallbacks++ })
    listener?.(); listener?.()
    await Promise.resolve()
    expect(fallbacks).toBe(1)
    sub.dispose()
    expect(listener).toBeUndefined()
  })

  it('does nothing with an addon without the event', () => {
    expect(() => healAtlasMerges({}, { rows: 24, refresh: () => {} }).dispose()).not.toThrow()
    expect(reuploadGlyphs({})).toBe(false)
  })

  // What the heal stands on, in the installed addon: per-page versions
  // compared by index (the bug), the merge firing the remove event, and
  // setAtlas marking units stale. An upgrade to a global version counter
  // (0.20 betas) makes the heal redundant, not wrong.
  it('the installed addon merges pages the way this heals', () => {
    const src = readFileSync(join(process.cwd(), 'node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs'), 'utf8')
    expect(src).toContain('onRemoveTextureAtlasCanvas')
    expect(src).toMatch(/_onRemoveTextureAtlasCanvas\.fire\(/)
    expect(src).toMatch(/setAtlas\(\w\)\{this\._atlas=\w;for\(let \w of this\._atlasTextures\)\w\.version=-1\}/)
  })
})
