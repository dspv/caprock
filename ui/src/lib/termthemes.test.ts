import { describe, expect, it } from 'vitest'
import { TERMINAL_THEME, dashTerminalTheme } from '@/components/Terminal'
import { THEME_COLORS } from './theme'
import { THEMES } from './themes'
import {
  APP_TERMINAL_THEME,
  DASH_GROUND,
  DEFAULT_TERMINAL_THEME,
  MATCH_APP_THEME,
  TERMINAL_CHOICES,
  TERMINAL_THEMES,
  appLook,
  mixHex,
  searchColors,
  terminalTheme,
} from './termthemes'

const HEX = /^#[0-9a-f]{6}$/

describe('terminal palettes', () => {
  it('keeps Dark Warm on the dashboard terminal’s ink and the dark panel’s ground', () => {
    for (const k of ['foreground', 'cursor'] as const) {
      expect(APP_TERMINAL_THEME[k]).toBe(TERMINAL_THEME[k])
    }
    // The strip's colour, so the terminal is no window on top of the window.
    expect(APP_TERMINAL_THEME.background).toBe(THEME_COLORS['dark-warm'])
    expect(TERMINAL_THEMES[0]!.colors).toBe(APP_TERMINAL_THEME)
  })

  it('Match app is each palette’s own terminal on that palette’s panel', () => {
    expect(DEFAULT_TERMINAL_THEME).toBe(MATCH_APP_THEME)
    expect(terminalTheme(MATCH_APP_THEME, { mode: 'dark-warm' }).id).toBe('caprock')
    expect(terminalTheme(MATCH_APP_THEME, { mode: 'dark-cold' }).id).toBe('slate')
    expect(terminalTheme(MATCH_APP_THEME, { mode: 'dark-side' }).id).toBe('dark-side')
    expect(terminalTheme(MATCH_APP_THEME, { mode: 'light-cold' }).id).toBe('light-cold')
    expect(terminalTheme(MATCH_APP_THEME, { mode: 'light-side' }).id).toBe('light-side')
    const book = terminalTheme(MATCH_APP_THEME, { mode: 'book' })
    expect(book.tone).toBe('light')
    expect(book.colors.background).toBe(THEME_COLORS.book)
    expect(book.colors.foreground).toBe(terminalTheme('paper').colors.foreground)
    expect(terminalTheme(MATCH_APP_THEME, { mode: 'light' }).colors.background).toBe(THEME_COLORS.light)
    for (const t of THEMES) {
      const own = terminalTheme(MATCH_APP_THEME, { mode: t.id })
      expect(own.colors.background, t.id).toBe(t.panel)
      expect(own.tone, t.id).toBe(t.theme)
    }
    // A named palette stays itself whatever the app shows.
    expect(terminalTheme('caprock', { mode: 'book' }).id).toBe('caprock')
    expect(TERMINAL_CHOICES[0]).toEqual({ id: MATCH_APP_THEME, name: 'Match app' })
  })

  it('offers the new palettes by name in Settings → Terminal', () => {
    const names = TERMINAL_CHOICES.map((c) => c.name)
    for (const n of ['Dark Warm', 'Dark Cold', 'Dark Side', 'Book', 'Light Cold', 'Light Side']) expect(names).toContain(n)
  })

  it('reads the app’s look off <html>', () => {
    const root = document.createElement('html')
    expect(appLook(root)).toEqual({ mode: 'dark-warm' })
    root.setAttribute('data-theme', 'light')
    root.setAttribute('data-tone', 'white')
    expect(appLook(root)).toEqual({ mode: 'light' })
    root.setAttribute('data-tone', 'cold')
    expect(appLook(root)).toEqual({ mode: 'light-cold' })
    root.setAttribute('data-theme', 'dark')
    root.setAttribute('data-dark', 'side')
    expect(appLook(root)).toEqual({ mode: 'dark-side' })
  })

  it('gives the dashboard terminal a dark palette in each app palette’s temperature', () => {
    const root = document.createElement('html')
    expect(dashTerminalTheme(root)).toEqual({ ...TERMINAL_THEME })
    root.setAttribute('data-dark', 'slate')
    expect(dashTerminalTheme(root).background).toBe(DASH_GROUND.slate)
    root.setAttribute('data-dark', 'side')
    expect(dashTerminalTheme(root).cursor).toBe('#ff4040')
    root.setAttribute('data-theme', 'light')
    root.setAttribute('data-tone', 'cold')
    expect(dashTerminalTheme(root).background).toBe(DASH_GROUND.slate)
    root.setAttribute('data-tone', 'paper')
    expect(dashTerminalTheme(root)).toEqual({ ...TERMINAL_THEME })
  })

  it('keeps the 16 ANSI colours of every palette distinct', () => {
    const ansi = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const
    for (const id of ['slate', 'dark-side', 'light-cold', 'light-side']) {
      const c = terminalTheme(id).colors
      const all = [...ansi.map((k) => c[k]), ...ansi.map((k) => c[`bright${k[0]!.toUpperCase()}${k.slice(1)}` as keyof typeof c])]
      expect(new Set(all).size, id).toBe(16)
    }
  })

  it('gives every palette all 21 colours as #rrggbb, with unique ids', () => {
    expect(new Set(TERMINAL_THEMES.map((t) => t.id)).size).toBe(TERMINAL_THEMES.length)
    for (const t of TERMINAL_THEMES) {
      const values = Object.values(t.colors)
      expect(values).toHaveLength(21)
      for (const v of values) expect(v, `${t.id}`).toMatch(HEX)
    }
    expect(TERMINAL_THEMES.some((t) => t.tone === 'light')).toBe(true)
  })

  it('falls back to the default for an id no longer offered', () => {
    expect(terminalTheme('gone', { mode: 'dark-warm' }).id).toBe('caprock')
    expect(terminalTheme('paper').tone).toBe('light')
  })

  it('mixes colours into the #rrggbb xterm decorations require', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mixHex('#102030', '#102030', 0.7)).toBe('#102030')
    for (const t of TERMINAL_THEMES) {
      const c = searchColors(t)
      expect(c.matchBackground).toMatch(HEX)
      expect(c.activeMatchBackground).toMatch(HEX)
      expect(c.activeMatchBackground).not.toBe(c.matchBackground)
    }
  })
})
