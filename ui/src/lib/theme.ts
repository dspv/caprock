import { useEffect, useState } from 'react'
import {
  MODE_KEY, THEME_KEY, THEMES, THEME_MODES, modeOf, modeOfRoot, resolveMode, themeRow,
  type ThemeMode, type ThemeRow,
} from './themes'

export { THEME_MODES, type ThemeMode } from './themes'

export type Theme = 'dark' | 'light'

/** Each palette's name, as the picker and the theme button show it. */
export const THEME_MODE_NAME = Object.fromEntries(THEMES.map((t) => [t.id, t.name])) as Record<ThemeMode, string>

/** What each palette looks like, for the picker's swatches (design/tokens.css). */
export const THEME_SWATCH = Object.fromEntries(THEMES.map((t) => [t.id, t.swatch])) as Record<ThemeMode, ThemeRow['swatch']>

/**
 * The header's panel colour per palette (`--color-panel` in design/tokens.css),
 * for `<meta name="theme-color">`: the phone's status bar and Android's
 * toolbar take it, so a home-screen Caprock has no stripe of another colour
 * above its header. Mirrored in the inline script in index.html.
 */
export const THEME_COLORS = Object.fromEntries(THEMES.map((t) => [t.id, t.panel])) as Record<ThemeMode, string>

/** The theme-color for what <html> shows: its data-theme, data-tone and data-dark. */
export function themeColor(theme: string | null, tone: string | null, dark?: string | null): string {
  return THEME_COLORS[modeOf(theme, tone, dark ?? null)]
}

function store(): (k: string) => string | null {
  return (k) => {
    try { return localStorage.getItem(k) } catch { return null }
  }
}

function prefersLight(): boolean {
  return !!window.matchMedia?.('(prefers-color-scheme: light)').matches
}

/** The kept palette: the saved choice, else the OS preference (see resolveMode). */
function savedMode(): ThemeMode {
  return resolveMode(store(), prefersLight())
}

/**
 * Puts a palette on <html>: data-theme, the palette's own sub-attribute, the
 * glow mark, color-scheme and the status-bar colour. The other side's
 * sub-attribute is removed, so nothing stale is left to match.
 */
function apply(m: ThemeMode): void {
  const row = themeRow(m)!
  const el = document.documentElement
  el.setAttribute('data-theme', row.theme)
  el.style.colorScheme = row.theme
  el.setAttribute(row.theme === 'dark' ? 'data-dark' : 'data-tone', row.sub)
  el.removeAttribute(row.theme === 'dark' ? 'data-tone' : 'data-dark')
  if (row.glow) el.setAttribute('data-glow', '')
  else el.removeAttribute('data-glow')
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', row.panel)
}

// Every hook on the page hears a change made by any other — the header's
// button and the Settings screen's cards are two views of one setting.
const MODE_EVENT = 'caprock-theme-mode-change'

/** Chooses a palette and keeps it. */
export function setThemeMode(m: ThemeMode): void {
  const row = themeRow(m)
  if (!row) return
  try {
    localStorage.setItem(MODE_KEY, m)
    localStorage.setItem(THEME_KEY, row.theme)
  } catch { /* private window: kept for this page only */ }
  apply(m)
  window.dispatchEvent(new CustomEvent<ThemeMode>(MODE_EVENT, { detail: m }))
}

/** Shows a palette without keeping it: the picker's hover. */
export function previewThemeMode(m: ThemeMode): void {
  apply(m)
}

/** Puts the kept palette on the page: after a preview, and in a window another one changed (the tray). */
export function applySavedThemeMode(): void {
  apply(savedMode())
}

/** Puts back what is kept, after a preview. */
export const endThemePreview = applySavedThemeMode

function nextMode(m: ThemeMode): ThemeMode {
  return THEME_MODES[(THEME_MODES.indexOf(m) + 1) % THEME_MODES.length]!
}

/** The palette's Switch theme: walks all seven, dark ones first. */
export function cycleThemeMode(): void {
  setThemeMode(nextMode(modeOfRoot()))
}

/** What the page shows, as the picker names it, and the next one for the palette's cycle. */
export function useThemeMode(): { mode: ThemeMode; next: ThemeMode; cycle: () => void; set: (m: ThemeMode) => void } {
  const [mode, setMode] = useState<ThemeMode>(savedMode)
  useEffect(() => { apply(mode) }, [mode])
  useEffect(() => {
    const on = (e: Event) => setMode((e as CustomEvent<ThemeMode>).detail)
    window.addEventListener(MODE_EVENT, on)
    return () => window.removeEventListener(MODE_EVENT, on)
  }, [])
  return { mode, next: nextMode(mode), cycle: cycleThemeMode, set: setThemeMode }
}

/**
 * Light or dark, and the cycle: what a caller that only cares about the side
 * needs (the command palette's Switch theme). With nothing saved the OS
 * preference is followed.
 */
export function useTheme(): [Theme, () => void] {
  const { mode, cycle } = useThemeMode()
  return [themeRow(mode)!.theme, cycle]
}
