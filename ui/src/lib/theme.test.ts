import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { THEME_COLORS, setThemeMode, themeColor, useTheme, useThemeMode } from './theme'
import { DEFAULT_DARK, THEMES, THEME_MODES, modeOfRoot, resolveMode, type ThemeMode } from './themes'

const ui = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

function reset() {
  localStorage.clear()
  vi.unstubAllGlobals()
  const el = document.documentElement
  for (const a of ['data-theme', 'data-tone', 'data-dark', 'data-glow']) el.removeAttribute(a)
  el.style.colorScheme = ''
  document.head.querySelector('meta[name="theme-color"]')?.remove()
}

function prefers(light: boolean) {
  vi.stubGlobal('matchMedia', () => ({ matches: light }) as MediaQueryList)
}

function seed(kv: Record<string, string>) {
  for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v)
}

describe('the palette table', () => {
  it('lists eight palettes, dark ones first, with unique ids and their sub-attribute', () => {
    expect(THEME_MODES).toEqual(['dark-pastel', 'dark-warm', 'dark-cold', 'dark-side', 'light', 'light-cold', 'book', 'light-side'])
    expect(THEMES.map((t) => t.name)).toEqual(['Dark Pastel', 'Dark Warm', 'Dark Cold', 'Dark Side', 'Light', 'Light Cold', 'Book', 'Light Side'])
    const keys = THEMES.map((t) => `${t.theme}/${t.sub}`)
    expect(new Set(keys).size).toBe(THEMES.length)
  })

  it('has a tokens.css block whose panel colour is the table’s, for every palette', () => {
    const css = readFileSync(join(ui, 'src', 'design', 'tokens.css'), 'utf8')
    for (const t of THEMES) {
      // Dark Warm is the @theme default and Light the bare light block.
      const head = t.id === 'dark-warm' ? '@theme {' : t.id === 'light' ? '[data-theme="light"] {'
        : `[data-theme="${t.theme}"][data-${t.theme === 'dark' ? 'dark' : 'tone'}="${t.sub}"] {`
      const at = css.indexOf(head)
      expect(at, t.id).toBeGreaterThan(-1)
      const block = css.slice(at, css.indexOf('}', at))
      expect(block, t.id).toContain(`--color-panel: ${t.panel};`)
    }
  })

  it('paints the default dark palette on a dark <html> that names no other', () => {
    expect(DEFAULT_DARK).toBe('dark-pastel')
    const css = readFileSync(join(ui, 'src', 'design', 'tokens.css'), 'utf8')
    const at = css.indexOf('[data-theme="dark"][data-dark="pastel"] {')
    // The selector list that opens the block: the fallback, then the palette's own.
    const head = css.slice(css.lastIndexOf('*/', at) + 2, at)
    expect(head).toMatch(/^\s*:where\(:root:not\(\[data-theme="light"\]\):not\(/)
    // Every other dark palette is excluded, or its <html> would fall to pastel.
    for (const t of THEMES.filter((r) => r.theme === 'dark' && r.id !== DEFAULT_DARK)) expect(head, t.id).toContain(`[data-dark="${t.sub}"]`)
  })
})

/** WCAG contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (h: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!
  }
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x! + 0.05) / (y! + 0.05)
}

function block(head: string): Record<string, string> {
  const css = readFileSync(join(ui, 'src', 'design', 'tokens.css'), 'utf8')
  const at = css.indexOf(head)
  const body = css.slice(at, css.indexOf('}', at))
  return Object.fromEntries([...body.matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1]!, m[2]!]))
}

describe('the calm palettes', () => {
  // Testers asked for a dark palette that does not shout (2026-10-12); calm
  // must not mean faint.
  it('Dark Pastel: body 7:1, muted and faint and accent 4.5:1, marks 3:1, on every surface', () => {
    const c = block('[data-theme="dark"][data-dark="pastel"] {')
    for (const g of ['bg', 'panel', 'panel-2']) {
      expect(contrast(c.fg!, c[g]!), `fg on ${g}`).toBeGreaterThanOrEqual(7)
      for (const k of ['fg-muted', 'fg-faint', 'accent', 'info']) expect(contrast(c[k]!, c[g]!), `${k} on ${g}`).toBeGreaterThanOrEqual(4.5)
      for (const k of ['ok', 'warn', 'danger', 'premium', 'merged']) expect(contrast(c[k]!, c[g]!), `${k} on ${g}`).toBeGreaterThanOrEqual(3)
    }
    // A filled accent button carries the panel colour as its label.
    expect(contrast(c.panel!, c.accent!)).toBeGreaterThanOrEqual(4.5)
  })

  it('Dark Cold’s softer accent still reads at 4.5:1 on every surface', () => {
    const c = block('[data-theme="dark"][data-dark="slate"] {')
    for (const g of ['bg', 'panel', 'panel-2']) expect(contrast(c.accent!, c[g]!), g).toBeGreaterThanOrEqual(4.5)
  })
})

describe('the kept palette', () => {
  afterEach(reset)

  it('follows the OS when nothing is kept: Dark Pastel, or Book', () => {
    prefers(false)
    expect(renderHook(() => useThemeMode()).result.current.mode).toBe('dark-pastel')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(document.documentElement.getAttribute('data-dark')).toBe('pastel')
    prefers(true)
    expect(renderHook(() => useThemeMode()).result.current.mode).toBe('book')
  })

  it('maps every value kept before the rename to its new name', () => {
    const get = (kv: Record<string, string>) => (k: string) => kv[k] ?? null
    expect(resolveMode(get({ 'caprock-theme': 'dark' }), true)).toBe('dark-pastel')
    // Graphite was the old default, not a choice: it moves to the new default.
    expect(resolveMode(get({ 'caprock-theme': 'dark', 'caprock-dark-tone': 'graphite' }), false)).toBe('dark-pastel')
    expect(resolveMode(get({ 'caprock-dark-tone': 'graphite' }), false)).toBe('dark-pastel')
    expect(resolveMode(get({ 'caprock-theme': 'dark', 'caprock-dark-tone': 'slate' }), false)).toBe('dark-cold')
    expect(resolveMode(get({ 'caprock-theme': 'light' }), false)).toBe('book')
    expect(resolveMode(get({ 'caprock-theme': 'light', 'caprock-light-tone': 'paper' }), false)).toBe('book')
    expect(resolveMode(get({ 'caprock-theme': 'light', 'caprock-light-tone': 'white' }), false)).toBe('light')
    // No side kept: the OS picks it, the old tone key still picks within it.
    expect(resolveMode(get({ 'caprock-dark-tone': 'slate' }), false)).toBe('dark-cold')
    expect(resolveMode(get({ 'caprock-light-tone': 'white' }), true)).toBe('light')
  })

  it('keeps a new choice, and lets a script that sets only caprock-theme switch sides', () => {
    const get = (kv: Record<string, string>) => (k: string) => kv[k] ?? null
    expect(resolveMode(get({ 'caprock-theme': 'light', 'caprock-theme-mode': 'light-cold' }), false)).toBe('light-cold')
    expect(resolveMode(get({ 'caprock-theme-mode': 'dark-side' }), true)).toBe('dark-side')
    // The screenshot scripts write caprock-theme alone: light wins over a dark mode.
    expect(resolveMode(get({ 'caprock-theme': 'light', 'caprock-theme-mode': 'dark-side' }), false)).toBe('book')
    expect(resolveMode(get({ 'caprock-theme': 'dark', 'caprock-theme-mode': 'gone' }), false)).toBe('dark-pastel')
    // A Dark Warm someone picked is a choice, and stays, old tone keys or not.
    expect(resolveMode(get({ 'caprock-theme': 'dark', 'caprock-theme-mode': 'dark-warm' }), false)).toBe('dark-warm')
    expect(resolveMode(get({ 'caprock-theme': 'dark', 'caprock-theme-mode': 'dark-warm', 'caprock-dark-tone': 'graphite' }), true)).toBe('dark-warm')
    expect(resolveMode(get({ 'caprock-theme': 'dark', 'caprock-theme-mode': 'dark-cold', 'caprock-dark-tone': 'graphite' }), false)).toBe('dark-cold')
  })

  it('saves a choice under both keys and puts its attributes on <html>', () => {
    prefers(false)
    setThemeMode('light-side')
    const el = document.documentElement
    expect(localStorage.getItem('caprock-theme-mode')).toBe('light-side')
    expect(localStorage.getItem('caprock-theme')).toBe('light')
    expect(el.getAttribute('data-theme')).toBe('light')
    expect(el.getAttribute('data-tone')).toBe('side')
    expect(el.hasAttribute('data-dark')).toBe(false)
    expect(el.hasAttribute('data-glow')).toBe(true)
    setThemeMode('dark-cold')
    expect(el.getAttribute('data-dark')).toBe('slate')
    expect(el.hasAttribute('data-tone')).toBe(false)
    expect(el.hasAttribute('data-glow')).toBe(false)
    expect(modeOfRoot(el)).toBe('dark-cold')
  })

  it('useTheme gives the side and walks the cycle', () => {
    prefers(true)
    seed({ 'caprock-theme': 'dark' })
    const { result } = renderHook(() => useTheme())
    expect(result.current[0]).toBe('dark')
    act(() => result.current[1]()) // Dark Warm
    act(() => result.current[1]()) // Dark Cold
    act(() => result.current[1]()) // Dark Side
    expect(result.current[0]).toBe('dark')
    act(() => result.current[1]()) // Light
    expect(result.current[0]).toBe('light')
    expect(localStorage.getItem('caprock-theme')).toBe('light')
  })
})

describe('theme-color', () => {
  afterEach(reset)

  it('is the header panel colour of each palette', () => {
    expect(themeColor('dark', 'paper')).toBe(THEME_COLORS['dark-pastel'])
    expect(themeColor(null, null)).toBe(THEME_COLORS['dark-pastel'])
    expect(themeColor('dark', null, 'graphite')).toBe('#211f1d')
    expect(themeColor('dark', null, 'side')).toBe('#15111d')
    expect(themeColor('light', 'paper')).toBe(THEME_COLORS.book)
    expect(themeColor('light', null)).toBe(THEME_COLORS.book)
    expect(themeColor('light', 'white')).toBe('#ffffff')
    expect(themeColor('light', 'cold')).toBe(THEME_COLORS['light-cold'])
  })

  it('follows a theme switch, so the status bar matches the header', () => {
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    document.head.appendChild(meta)
    prefers(false)
    renderHook(() => useThemeMode())
    expect(meta.content).toBe(THEME_COLORS['dark-pastel'])
    act(() => setThemeMode('book'))
    expect(meta.content).toBe(THEME_COLORS.book)
  })
})

describe('the pre-paint script in index.html', () => {
  afterEach(reset)

  const html = readFileSync(join(ui, 'index.html'), 'utf8')
  const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'))

  const cases: [string, Record<string, string>, boolean][] = [
    ['nothing kept, dark OS', {}, false],
    ['nothing kept, light OS', {}, true],
    ['old graphite', { 'caprock-theme': 'dark', 'caprock-dark-tone': 'graphite' }, true],
    ['old graphite, side from the OS', { 'caprock-dark-tone': 'graphite' }, false],
    ['old slate', { 'caprock-theme': 'dark', 'caprock-dark-tone': 'slate' }, false],
    ['a picked Dark Warm over an old graphite', { 'caprock-theme': 'dark', 'caprock-theme-mode': 'dark-warm', 'caprock-dark-tone': 'graphite' }, false],
    ['old paper', { 'caprock-theme': 'light', 'caprock-light-tone': 'paper' }, false],
    ['old white', { 'caprock-theme': 'light', 'caprock-light-tone': 'white' }, false],
    ['a script set light over a dark mode', { 'caprock-theme': 'light', 'caprock-theme-mode': 'dark-side' }, false],
    ['an unknown mode', { 'caprock-theme': 'dark', 'caprock-theme-mode': 'gone' }, false],
    ...THEME_MODES.map((m): [string, Record<string, string>, boolean] => [m, { 'caprock-theme': THEMES.find((t) => t.id === m)!.theme, 'caprock-theme-mode': m }, m === 'dark-warm']),
  ]

  it.each(cases)('paints what lib/themes.ts resolves: %s', (_name, kv, light) => {
    prefers(light)
    seed(kv)
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    document.head.appendChild(meta)
    new Function(script)()
    const el = document.documentElement
    const want: ThemeMode = resolveMode((k) => localStorage.getItem(k), light)
    const row = THEMES.find((t) => t.id === want)!
    expect(modeOfRoot(el)).toBe(want)
    expect(el.getAttribute('data-theme')).toBe(row.theme)
    expect(el.getAttribute(row.theme === 'dark' ? 'data-dark' : 'data-tone')).toBe(row.sub)
    expect(el.hasAttribute('data-glow')).toBe(!!row.glow)
    expect(meta.content).toBe(row.panel)
  })
})
