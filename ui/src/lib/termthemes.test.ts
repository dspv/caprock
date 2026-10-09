import { describe, expect, it } from 'vitest'
import { TERMINAL_THEME } from '@/components/Terminal'
import { THEME_COLORS } from './theme'
import {
  APP_TERMINAL_THEME,
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
  it('keeps Caprock on the dashboard terminal’s ink and the dark panel’s ground', () => {
    for (const k of ['foreground', 'cursor'] as const) {
      expect(APP_TERMINAL_THEME[k]).toBe(TERMINAL_THEME[k])
    }
    // The strip's colour, so the terminal is no window on top of the window.
    expect(APP_TERMINAL_THEME.background).toBe(THEME_COLORS.dark)
    expect(TERMINAL_THEMES[0]!.colors).toBe(APP_TERMINAL_THEME)
  })

  it('Match app is Caprock in the dark theme and Paper on the light panel in the light one', () => {
    expect(DEFAULT_TERMINAL_THEME).toBe(MATCH_APP_THEME)
    expect(terminalTheme(MATCH_APP_THEME, { theme: 'dark', tone: 'paper' }).id).toBe('caprock')
    const paper = terminalTheme(MATCH_APP_THEME, { theme: 'light', tone: 'paper' })
    expect(paper.tone).toBe('light')
    expect(paper.colors.background).toBe(THEME_COLORS.paper)
    expect(paper.colors.foreground).toBe(terminalTheme('paper').colors.foreground)
    expect(terminalTheme(MATCH_APP_THEME, { theme: 'light', tone: 'white' }).colors.background).toBe(THEME_COLORS.white)
    // A named palette stays itself whatever the app shows.
    expect(terminalTheme('caprock', { theme: 'light', tone: 'paper' }).id).toBe('caprock')
    expect(TERMINAL_CHOICES[0]).toEqual({ id: MATCH_APP_THEME, name: 'Match app' })
  })

  it('reads the app’s look off <html>', () => {
    const root = document.createElement('html')
    expect(appLook(root)).toEqual({ theme: 'dark', tone: 'paper' })
    root.setAttribute('data-theme', 'light')
    root.setAttribute('data-tone', 'white')
    expect(appLook(root)).toEqual({ theme: 'light', tone: 'white' })
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
    expect(terminalTheme('gone').id).toBe('caprock')
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
