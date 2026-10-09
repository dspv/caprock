import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})

const load = () => import('./termprefs')

describe('terminal preferences', () => {
  it('start on Match app, in the font and size the app terminal always had', async () => {
    const m = await load()
    expect(m.getTerminalPrefs()).toEqual({ theme: 'match', font: 'jetbrains', fontSize: 13, lineHeight: 1.2, cursor: 'bar' })
  })

  it('read a pre-Match-app Caprock as the untouched default, and a choice saved since as a choice', async () => {
    localStorage.setItem('caprock.app.terminal', JSON.stringify({ theme: 'caprock', font: 'menlo', fontSize: 15 }))
    let m = await load()
    expect(m.getTerminalPrefs()).toMatchObject({ theme: 'match', font: 'menlo', fontSize: 15 })
    // Any other palette was picked by hand: it stays.
    vi.resetModules()
    localStorage.setItem('caprock.app.terminal', JSON.stringify({ theme: 'tokyo-night' }))
    m = await load()
    expect(m.getTerminalPrefs().theme).toBe('tokyo-night')
    // Caprock chosen now is saved as chosen and kept.
    m.setTerminalPrefs({ theme: 'caprock' })
    vi.resetModules()
    m = await load()
    expect(m.getTerminalPrefs().theme).toBe('caprock')
  })

  it('tell subscribers when the app’s theme moves Match app, and only then', async () => {
    const m = await load()
    const heard: string[] = []
    const off = m.subscribeTerminalPrefs((p) => heard.push(m.xtermOptions(p, 'monospace').theme.background))
    document.documentElement.setAttribute('data-theme', 'light')
    document.documentElement.setAttribute('data-tone', 'paper')
    await new Promise((r) => setTimeout(r, 0))
    expect(heard).toEqual(['#f4ecdd'])
    m.setTerminalPrefs({ theme: 'solarized-dark' })
    document.documentElement.setAttribute('data-theme', 'dark')
    await new Promise((r) => setTimeout(r, 0))
    expect(heard).toEqual(['#f4ecdd', '#002b36'])
    off()
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-tone')
  })

  it('repair stored values one by one instead of dropping them all', async () => {
    const m = await load()
    expect(m.normalizePrefs({ theme: 'tokyo-night', font: 'comic', fontSize: 99, lineHeight: 'x', cursor: 'block' }))
      .toEqual({ theme: 'tokyo-night', font: 'jetbrains', fontSize: 20, lineHeight: 1.2, cursor: 'block' })
    expect(m.normalizePrefs(null)).toEqual(m.DEFAULT_PREFS)
    expect(m.normalizePrefs({ fontSize: 3, lineHeight: 0.2 })).toMatchObject({ fontSize: 10, lineHeight: 1 })
  })

  it('persist per browser and tell every subscriber at once', async () => {
    const m = await load()
    const heard: string[] = []
    const off = m.subscribeTerminalPrefs((p) => heard.push(p.theme))
    m.setTerminalPrefs({ theme: 'paper', fontSize: 15 })
    expect(heard).toEqual(['paper'])
    expect(JSON.parse(localStorage.getItem('caprock.app.terminal')!)).toMatchObject({ theme: 'paper', fontSize: 15 })
    off()
    m.setTerminalPrefs({ theme: 'caprock' })
    expect(heard).toEqual(['paper'])
    vi.resetModules()
    const again = await load()
    expect(again.getTerminalPrefs()).toMatchObject({ theme: 'caprock', fontSize: 15 })
  })

  it('build xterm options with a resolved font stack and a contrast floor on light grounds', async () => {
    const m = await load()
    const stack = '"JetBrains Mono Variable", ui-monospace, monospace'
    const dark = m.xtermOptions(m.DEFAULT_PREFS, stack)
    expect(dark.fontFamily).toBe(stack)
    expect(dark.minimumContrastRatio).toBe(1)
    expect(dark.cursorStyle).toBe('bar')
    const light = m.xtermOptions({ ...m.DEFAULT_PREFS, theme: 'paper', font: 'fira-code' }, stack)
    expect(light.fontFamily).toBe(`"Fira Code", ${stack}`)
    expect(light.fontFamily).not.toMatch(/var\(/)
    expect(light.minimumContrastRatio).toBeGreaterThanOrEqual(4.5)
    expect(light.theme.background).toBe('#efe7d6')
  })

  it('offer the bundled face always and others only when they measure as installed', async () => {
    const m = await load()
    // "Menlo" measures differently from every generic family; nothing else does.
    const measure = (font: string) => (font.includes('Menlo') ? 99 : font.length % 2)
    const ids = m.detectMonoFonts((f) => (f.includes('Menlo') ? 99 : f.endsWith('monospace') ? 1 : f.endsWith('sans-serif') ? 3 : 2)).map((f) => f.id)
    expect(ids).toEqual(['jetbrains', 'menlo'])
    expect(m.detectMonoFonts(measure).map((f) => f.id)).toContain('jetbrains')
  })

  it('paint the slab in the palette’s ground and tone', async () => {
    const m = await load()
    const root = document.createElement('div')
    m.applyTerminalChrome({ ...m.DEFAULT_PREFS, theme: 'paper' }, root)
    expect(root.style.getPropertyValue('--app-term-bg')).toBe('#efe7d6')
    expect(root.getAttribute('data-term-tone')).toBe('light')
  })
})
