/**
 * The share pictures embed only the faces this page loaded, from the
 * browser's cache: drawing asked the daemon for eight font files and waited
 * behind its slowest answers (preview stand, 2026-10-31).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pageFontCSS, resetPageFontCSS } from './fontEmbed'

afterEach(() => { resetPageFontCSS(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

// jsdom keeps no `src` in a parsed @font-face, so the sheet is a stand-in.
function faces() {
  const rule = (css: string) => Object.defineProperty(Object.create(CSSFontFaceRule.prototype), 'cssText', { value: css }) as CSSFontFaceRule
  const sheet = {
    href: null,
    cssRules: [
      rule('@font-face { font-family: "Hanken"; src: url("/assets/latin.woff2") format("woff2"); unicode-range: U+0-FF; }'),
      rule('@font-face { font-family: "Hanken"; src: url("/assets/greek.woff2") format("woff2"); unicode-range: U+370-3FF; }'),
    ],
  }
  vi.spyOn(document, 'styleSheets', 'get').mockReturnValue([sheet] as unknown as StyleSheetList)
}

describe('pageFontCSS', () => {
  it('inlines the faces the page loaded, from the cache, and leaves the others out', async () => {
    faces()
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ name: new URL('/assets/latin.woff2', location.href).href }] as never)
    const fetch = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['font'], { type: 'font/woff2' }) }))
    vi.stubGlobal('fetch', fetch)
    const css = await pageFontCSS()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(new URL('/assets/latin.woff2', location.href).href, { cache: 'force-cache' })
    expect(css).toContain('url(data:font/woff2;base64,')
    expect(css).not.toContain('greek')
    // Once per page.
    await pageFontCSS()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('hands html-to-image nothing when no loaded face matches, so it embeds as before', async () => {
    faces()
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([] as never)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await pageFontCSS()).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })
})
