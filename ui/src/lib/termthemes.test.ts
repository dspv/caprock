import { describe, expect, it } from 'vitest'
import { TERMINAL_THEME } from '@/components/Terminal'
import { APP_TERMINAL_THEME, TERMINAL_THEMES, mixHex, searchColors, terminalTheme } from './termthemes'

const HEX = /^#[0-9a-f]{6}$/

describe('terminal palettes', () => {
  it('keeps the default on the dashboard terminal’s ground and ink', () => {
    for (const k of ['background', 'foreground', 'cursor', 'cursorAccent'] as const) {
      expect(APP_TERMINAL_THEME[k]).toBe(TERMINAL_THEME[k])
    }
    expect(TERMINAL_THEMES[0]!.colors).toBe(APP_TERMINAL_THEME)
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
