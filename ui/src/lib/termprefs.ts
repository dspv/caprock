/**
 * The app terminal's appearance (F21): palette, font, size, line height and
 * cursor. Kept per viewer in localStorage, like the app theme, and applied to
 * every open pane the moment it changes — a pane subscribes and sets
 * `term.options`, it is never re-created.
 */
import { useEffect, useState } from 'react'
import { terminalTheme, DEFAULT_TERMINAL_THEME, type TerminalTheme } from './termthemes'

export type CursorStyle = 'bar' | 'block' | 'underline'

export interface TerminalPrefs {
  theme: string
  font: string
  fontSize: number
  lineHeight: number
  cursor: CursorStyle
}

const KEY = 'caprock.app.terminal'

/**
 * The defaults are the JetBrains IDE terminal's: JetBrains Mono at 13 px,
 * line height 1.2, Regular and Bold (set in xtermOptions), no ligatures (xterm
 * draws one cell at a time and has no ligature addon loaded).
 */
export const DEFAULT_PREFS: TerminalPrefs = { theme: DEFAULT_TERMINAL_THEME, font: 'jetbrains', fontSize: 13, lineHeight: 1.2, cursor: 'bar' }

export const FONT_SIZE_RANGE = { min: 10, max: 20 } as const
export const LINE_HEIGHT_RANGE = { min: 1, max: 1.6 } as const

/** A monospace face the terminal can use. `family` is the CSS list, without the fallback stack. */
export interface MonoFont {
  id: string
  name: string
  family: string
  /** Shipped with the UI, so always offered. */
  bundled?: boolean
}

export const MONO_FONTS: readonly MonoFont[] = [
  { id: 'jetbrains', name: 'JetBrains Mono', family: '"JetBrains Mono Variable", "JetBrains Mono"', bundled: true },
  { id: 'sf-mono', name: 'SF Mono', family: '"SF Mono", SFMono-Regular, ui-monospace' },
  { id: 'menlo', name: 'Menlo', family: 'Menlo' },
  { id: 'fira-code', name: 'Fira Code', family: '"Fira Code"' },
  { id: 'cascadia', name: 'Cascadia Code', family: '"Cascadia Code"' },
  { id: 'hack', name: 'Hack', family: 'Hack' },
  { id: 'monaco', name: 'Monaco', family: 'Monaco' },
  { id: 'consolas', name: 'Consolas', family: 'Consolas' },
  { id: 'dejavu', name: 'DejaVu Sans Mono', family: '"DejaVu Sans Mono"' },
  { id: 'ubuntu-mono', name: 'Ubuntu Mono', family: '"Ubuntu Mono"' },
]

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
}

/** Whatever was stored, made valid: unknown or out-of-range values fall back one by one. */
export function normalizePrefs(raw: unknown): TerminalPrefs {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof TerminalPrefs, unknown>>
  return {
    theme: terminalTheme(String(v.theme ?? '')).id,
    font: MONO_FONTS.some((f) => f.id === v.font) ? String(v.font) : DEFAULT_PREFS.font,
    fontSize: Math.round(clamp(v.fontSize, FONT_SIZE_RANGE.min, FONT_SIZE_RANGE.max, DEFAULT_PREFS.fontSize)),
    lineHeight: Math.round(clamp(v.lineHeight, LINE_HEIGHT_RANGE.min, LINE_HEIGHT_RANGE.max, DEFAULT_PREFS.lineHeight) * 100) / 100,
    cursor: v.cursor === 'block' || v.cursor === 'underline' || v.cursor === 'bar' ? v.cursor : DEFAULT_PREFS.cursor,
  }
}

let current: TerminalPrefs | null = null
const listeners = new Set<(p: TerminalPrefs) => void>()

export function getTerminalPrefs(): TerminalPrefs {
  if (!current) {
    try {
      current = normalizePrefs(JSON.parse(localStorage.getItem(KEY) ?? '{}'))
    } catch {
      current = { ...DEFAULT_PREFS }
    }
  }
  return current
}

export function setTerminalPrefs(patch: Partial<TerminalPrefs>): void {
  current = normalizePrefs({ ...getTerminalPrefs(), ...patch })
  try { localStorage.setItem(KEY, JSON.stringify(current)) } catch { /* kept for this page only */ }
  for (const f of listeners) f(current)
}

/** Called with the new prefs on every change, from this page or another window. */
export function subscribeTerminalPrefs(f: (p: TerminalPrefs) => void): () => void {
  listeners.add(f)
  return () => { listeners.delete(f) }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return
    current = null
    const p = getTerminalPrefs()
    for (const f of listeners) f(p)
  })
}

export function useTerminalPrefs(): [TerminalPrefs, (patch: Partial<TerminalPrefs>) => void] {
  const [p, setP] = useState(getTerminalPrefs)
  useEffect(() => subscribeTerminalPrefs(setP), [])
  return [p, setTerminalPrefs]
}

/** The CSS font list for a font id, ending in the app's own fallback stack. */
export function fontStack(fontId: string, fallback: string): string {
  const f = MONO_FONTS.find((x) => x.id === fontId)
  // JetBrains Mono is the head of --font-mono already: the stack as it is.
  if (!f || f.bundled) return fallback
  return `${f.family}, ${fallback}`
}

/** The xterm options these prefs set. `fallback` is the resolved --font-mono. */
export function xtermOptions(p: TerminalPrefs, fallback: string) {
  const t: TerminalTheme = terminalTheme(p.theme)
  return {
    theme: { ...t.colors },
    fontFamily: fontStack(p.font, fallback),
    fontSize: p.fontSize,
    lineHeight: p.lineHeight,
    // Regular and Bold by number: the bundled face is variable (wght 100-800),
    // and these are the two instances JetBrains' own terminal uses.
    fontWeight: 400 as const,
    fontWeightBold: 700 as const,
    letterSpacing: 0,
    cursorStyle: p.cursor,
    // On a light ground, Claude Code's dim text and status line — drawn for a
    // dark one — were grey on cream (Terminal.tsx, 2026-10-04). xterm lifts any
    // colour below this contrast against the ground it is drawn on.
    minimumContrastRatio: t.tone === 'light' ? 4.5 : 1,
  }
}

/**
 * Which of the fonts are installed, measured on a canvas — the same way xterm
 * meets them. A face is there when text in it measures differently from the
 * generic families it would otherwise fall back to. The bundled face is always
 * offered.
 */
export function detectMonoFonts(measure: (font: string) => number = canvasMeasure()): MonoFont[] {
  const bases = ['monospace', 'serif', 'sans-serif']
  const base = bases.map((b) => measure(`72px ${b}`))
  return MONO_FONTS.filter((f) => f.bundled || bases.some((b, i) => measure(`72px ${f.family}, ${b}`) !== base[i]))
}

function canvasMeasure(): (font: string) => number {
  const ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  return (font) => {
    if (!ctx) return 0
    ctx.font = font
    return ctx.measureText('mmmmmmmmmmlli10OO@#WwQq').width
  }
}

/**
 * The slab around the terminal follows its palette: the tab in front, the pane
 * headers, the padding. Set on <html> for the app's `.app-slab` (tokens.css).
 */
export function applyTerminalChrome(p: TerminalPrefs, root: HTMLElement = document.documentElement): void {
  const t = terminalTheme(p.theme)
  root.style.setProperty('--app-term-bg', t.colors.background)
  root.style.setProperty('--app-term-border', t.colors.selectionBackground)
  root.setAttribute('data-term-tone', t.tone)
}
