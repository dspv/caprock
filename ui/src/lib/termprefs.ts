/**
 * The app terminal's appearance (F21): palette, font, size, line height and
 * cursor. Kept per viewer in localStorage, like the app theme, and applied to
 * every open pane the moment it changes — a pane subscribes and sets
 * `term.options`, it is never re-created.
 */
import { useEffect, useState } from 'react'
import { appLook, isTerminalChoice, terminalTheme, DEFAULT_TERMINAL_THEME, MATCH_APP_THEME, TERMINAL_MIN_CONTRAST, type TerminalTheme } from './termthemes'

export type CursorStyle = 'bar' | 'block' | 'underline'

/** How strong the highlight where you type is (lib/terminputbox, `.composer-field`). */
export type HighlightStrength = 'subtle' | 'stronger'

export interface TerminalPrefs {
  theme: string
  font: string
  fontSize: number
  lineHeight: number
  cursor: CursorStyle
  /**
   * The highlight where you type: the band on Claude Code's input box and
   * the chat field's resting accent tint. On by default; ⌥⌘G flips it.
   */
  highlightInput: boolean
  highlightStrength: HighlightStrength
}

const KEY = 'caprock.app.terminal'

/**
 * The defaults are the JetBrains IDE terminal's: JetBrains Mono at 13 px,
 * line height 1.2, Regular and Bold (set in xtermOptions), no ligatures (xterm
 * draws one cell at a time and has no ligature addon loaded).
 */
export const DEFAULT_PREFS: TerminalPrefs = { theme: DEFAULT_TERMINAL_THEME, font: 'jetbrains', fontSize: 13, lineHeight: 1.2, cursor: 'bar', highlightInput: true, highlightStrength: 'subtle' }

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
    theme: isTerminalChoice(String(v.theme ?? '')) ? String(v.theme) : DEFAULT_TERMINAL_THEME,
    font: MONO_FONTS.some((f) => f.id === v.font) ? String(v.font) : DEFAULT_PREFS.font,
    fontSize: Math.round(clamp(v.fontSize, FONT_SIZE_RANGE.min, FONT_SIZE_RANGE.max, DEFAULT_PREFS.fontSize)),
    lineHeight: Math.round(clamp(v.lineHeight, LINE_HEIGHT_RANGE.min, LINE_HEIGHT_RANGE.max, DEFAULT_PREFS.lineHeight) * 100) / 100,
    cursor: v.cursor === 'block' || v.cursor === 'underline' || v.cursor === 'bar' ? v.cursor : DEFAULT_PREFS.cursor,
    highlightInput: typeof v.highlightInput === 'boolean' ? v.highlightInput : DEFAULT_PREFS.highlightInput,
    highlightStrength: v.highlightStrength === 'stronger' ? 'stronger' : 'subtle',
  }
}

/**
 * The stored form's version. Before Match app (v1, no field) every save wrote
 * the whole set, so a stored `caprock` was as likely the untouched default as
 * a choice; it reads as Match app, which is Caprock in the dark theme anyway.
 * Anything saved since carries v2 and is taken as chosen.
 */
const STORED_VERSION = 2

/** A stored value as prefs, the pre-Match-app default read as Match app. */
export function readStoredPrefs(raw: unknown): TerminalPrefs {
  const v = (raw && typeof raw === 'object' ? raw : {}) as { theme?: unknown; v?: unknown }
  const p = normalizePrefs(raw)
  return v.v !== STORED_VERSION && v.theme === 'caprock' ? { ...p, theme: MATCH_APP_THEME } : p
}

let current: TerminalPrefs | null = null
const listeners = new Set<(p: TerminalPrefs) => void>()

export function getTerminalPrefs(): TerminalPrefs {
  if (!current) {
    try {
      current = readStoredPrefs(JSON.parse(localStorage.getItem(KEY) ?? '{}'))
    } catch {
      current = { ...DEFAULT_PREFS }
    }
  }
  return current
}

export function setTerminalPrefs(patch: Partial<TerminalPrefs>): void {
  current = normalizePrefs({ ...getTerminalPrefs(), ...patch })
  try { localStorage.setItem(KEY, JSON.stringify({ ...current, v: STORED_VERSION })) } catch { /* kept for this page only */ }
  if (typeof document !== 'undefined') applyInputHighlight(current)
  for (const f of listeners) f(current)
}

/** ⌥⌘G: the highlight where you type, flipped in every pane and window. Returns whether it is now on. */
export function toggleInputHighlight(): boolean {
  const on = !getTerminalPrefs().highlightInput
  setTerminalPrefs({ highlightInput: on })
  return on
}

/**
 * Match app follows the app's theme: a change of data-theme, data-tone or data-dark on
 * <html> is a new palette for every pane, told as a change of prefs (a fresh
 * object, so React state sees it). Watched only while someone listens.
 */
let watcher: MutationObserver | null = null
let lastLook = ''
function watchLook(): void {
  if (watcher || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return
  lastLook = JSON.stringify(appLook())
  watcher = new MutationObserver(() => {
    const look = JSON.stringify(appLook())
    if (look === lastLook) return
    lastLook = look
    const p = getTerminalPrefs()
    if (p.theme !== MATCH_APP_THEME) return
    current = { ...p }
    for (const f of listeners) f(current)
  })
  watcher.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-tone', 'data-dark'] })
}

/** Called with the new prefs on every change, from this page or another window, and when Match app's palette moves with the app. */
export function subscribeTerminalPrefs(f: (p: TerminalPrefs) => void): () => void {
  listeners.add(f)
  watchLook()
  return () => {
    listeners.delete(f)
    if (listeners.size === 0 && watcher) { watcher.disconnect(); watcher = null }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return
    current = null
    const p = getTerminalPrefs()
    applyInputHighlight(p)
    for (const f of listeners) f(p)
  })
  // Every page that shows a chat field, the phone's included, not only the app's shell.
  applyInputHighlight(getTerminalPrefs())
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
    // xterm lifts any colour below this contrast against the cell it is drawn
    // on. On a light ground Claude Code's dim text and status line — drawn for
    // a dark one — were grey on cream (Terminal.tsx, 2026-10-04). On a dark
    // one it was 1 until Claude Code's own text selection (fullscreen mode)
    // painted its highlight in ANSI blue, which a dark palette keeps light for
    // text: Dark Pastel's #9db3cc under its #e3e1db ink is 1.6:1 (owner,
    // 2026-10-14, translated: "can't read a thing"). The floor darkens the ink.
    minimumContrastRatio: TERMINAL_MIN_CONTRAST,
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
 * The chat field's resting tint follows the same switch (`.composer-field`,
 * tokens.css): `data-input-hl` on <html> is `off` or `stronger`, absent for
 * the default.
 */
export function applyInputHighlight(p: TerminalPrefs, root: HTMLElement = document.documentElement): void {
  if (!p.highlightInput) root.setAttribute('data-input-hl', 'off')
  else if (p.highlightStrength === 'stronger') root.setAttribute('data-input-hl', 'stronger')
  else root.removeAttribute('data-input-hl')
}

/**
 * The slab around the terminal follows its palette: the tab in front, the pane
 * headers, the padding. Set on <html> for the app's `.app-slab` (tokens.css).
 */
export function applyTerminalChrome(p: TerminalPrefs, root: HTMLElement = document.documentElement): void {
  const t = terminalTheme(p.theme, appLook(document.documentElement))
  root.style.setProperty('--app-term-bg', t.colors.background)
  root.style.setProperty('--app-term-border', t.colors.selectionBackground)
  root.setAttribute('data-term-tone', t.tone)
  // Match app is the app palette's own terminal on its own panel: the slab
  // keeps that palette's ink instead of a generic dark or light one.
  if (p.theme === MATCH_APP_THEME) root.setAttribute('data-term-match', '')
  else root.removeAttribute('data-term-match')
}
