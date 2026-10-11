import { useEffect, useState } from 'react'

export type Theme = 'dark' | 'light'

/**
 * Which light palette: `paper`, the warm ground caprock.dev uses, or `white`,
 * the original. Paper is new (2026-10-03), so white stays a full palette
 * rather than being deleted: a user who dislikes paper picks White in
 * Settings, and if most do, flipping DEFAULT_TONE restores it for everyone
 * who never chose.
 */
export type LightTone = 'paper' | 'white'
export const DEFAULT_TONE: LightTone = 'paper'

const KEY = 'caprock-theme'
const TONE_KEY = 'caprock-light-tone'

// Resolve the initial theme: an explicit saved choice wins; otherwise follow the
// OS preference. Runs against document so the first paint is already correct
// (see the inline script in index.html that mirrors this before React mounts).
function initial(): Theme {
  const saved = localStorage.getItem(KEY)
  if (saved === 'dark' || saved === 'light') return saved
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function apply(t: Theme) {
  document.documentElement.setAttribute('data-theme', t)
  document.documentElement.style.colorScheme = t
  syncThemeColor()
}

/**
 * The header's panel colour per palette (`--color-panel` in design/tokens.css),
 * for `<meta name="theme-color">`: the phone's status bar and Android's
 * toolbar take it, so a home-screen Caprock has no stripe of another colour
 * above its header. Mirrored in the inline script in index.html.
 */
export const THEME_COLORS = { dark: '#211f1d', slate: '#1f2023', white: '#ffffff', paper: '#f4ecdd' } as const

/** The theme-color for what <html> currently shows. */
export function themeColor(theme: string | null, tone: string | null, dark?: string | null): string {
  if (theme !== 'light') return dark === 'slate' ? THEME_COLORS.slate : THEME_COLORS.dark
  return tone === 'white' ? THEME_COLORS.white : THEME_COLORS.paper
}

function syncThemeColor() {
  const el = document.documentElement
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', themeColor(el.getAttribute('data-theme'), el.getAttribute('data-tone'), el.getAttribute('data-dark')))
}

// Every useTheme on the page hears a change made by any other — the header's
// toggle and the Settings screen's choice are two views of one setting, and a
// sun icon that disagreed with the page would be read as a bug.
const THEME_EVENT = 'caprock-theme-change'

// useTheme returns the current theme, a toggle, and a setter. The choice is
// persisted, so it sticks across reloads; with nothing saved the OS preference
// is followed.
export function useTheme(): [Theme, () => void, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(initial)
  useEffect(() => {
    apply(theme)
    localStorage.setItem(KEY, theme)
  }, [theme])
  useEffect(() => {
    const on = (e: Event) => setTheme((e as CustomEvent<Theme>).detail)
    window.addEventListener(THEME_EVENT, on)
    return () => window.removeEventListener(THEME_EVENT, on)
  }, [])
  const set = (t: Theme) => {
    setTheme(t)
    window.dispatchEvent(new CustomEvent<Theme>(THEME_EVENT, { detail: t }))
  }
  // The palette's Switch theme walks all four: Graphite → Slate → Paper →
  // White. The buttons open a picker instead (ThemePicker).
  const cycle = () => setThemeMode(nextMode(currentMode()))
  return [theme, cycle, set]
}

const TONE_EVENT = 'caprock-tone-change'

function currentTone(): LightTone {
  return document.documentElement.getAttribute('data-tone') === 'white' ? 'white' : 'paper'
}

/** Chooses the light palette and tells every useLightTone on the page. */
export function setLightTone(t: LightTone): void {
  localStorage.setItem(TONE_KEY, t)
  document.documentElement.setAttribute('data-tone', t)
  syncThemeColor()
  window.dispatchEvent(new CustomEvent<LightTone>(TONE_EVENT, { detail: t }))
}

/**
 * Which dark palette: `graphite`, the warm charcoal of caprock.dev, or
 * `slate`, a neutral dark with a soft blue accent (owner, 2026-10-11: a
 * comfortable theme for someone who finds Orca's cooler look easier).
 * `data-dark` on <html>; only `slate` is styled, graphite is the default.
 */
export type DarkTone = 'graphite' | 'slate'
const DARK_KEY = 'caprock-dark-tone'

function initialDark(): DarkTone {
  try { return localStorage.getItem(DARK_KEY) === 'slate' ? 'slate' : 'graphite' } catch { return 'graphite' }
}

const DARK_EVENT = 'caprock-dark-change'

/** Chooses the dark palette and tells every useThemeMode on the page. */
export function setDarkTone(t: DarkTone): void {
  try { localStorage.setItem(DARK_KEY, t) } catch { /* private window */ }
  document.documentElement.setAttribute('data-dark', t)
  syncThemeColor()
  window.dispatchEvent(new CustomEvent<DarkTone>(DARK_EVENT, { detail: t }))
}

/** The four palettes, as the picker lists them. `dark` is Graphite. */
export type ThemeMode = 'dark' | 'slate' | LightTone
export const THEME_MODES: ThemeMode[] = ['dark', 'slate', 'paper', 'white']
export const THEME_MODE_NAME: Record<ThemeMode, string> = { dark: 'Graphite', slate: 'Slate', paper: 'Paper', white: 'White' }

/** What each palette looks like, for the picker's swatches (design/tokens.css). */
export const THEME_SWATCH: Record<ThemeMode, { bg: string; panel: string; fg: string; muted: string; accent: string }> = {
  dark: { bg: '#1b1b1a', panel: '#262422', fg: '#e8e6e2', muted: '#837f78', accent: '#feb157' },
  slate: { bg: '#1a1b1e', panel: '#26272b', fg: '#e6e7ea', muted: '#7d8088', accent: '#6ea8fe' },
  paper: { bg: '#efe7d6', panel: '#f4ecdd', fg: '#2b251c', muted: '#665d4f', accent: '#eb9a3e' },
  white: { bg: '#faf9f7', panel: '#ffffff', fg: '#24211c', muted: '#8a8479', accent: '#b8730d' },
}

function currentMode(): ThemeMode {
  const el = document.documentElement
  if (el.getAttribute('data-theme') !== 'light') return el.getAttribute('data-dark') === 'slate' ? 'slate' : 'dark'
  return currentTone()
}

function nextMode(m: ThemeMode): ThemeMode {
  return THEME_MODES[(THEME_MODES.indexOf(m) + 1) % THEME_MODES.length]!
}

/** Shows a palette without keeping it: the picker's hover. */
export function previewThemeMode(m: ThemeMode): void {
  const el = document.documentElement
  const dark = m === 'dark' || m === 'slate'
  el.setAttribute('data-theme', dark ? 'dark' : 'light')
  el.style.colorScheme = dark ? 'dark' : 'light'
  if (dark) el.setAttribute('data-dark', m === 'slate' ? 'slate' : 'graphite')
  else el.setAttribute('data-tone', m)
  syncThemeColor()
}

/** Puts back what is saved, after a preview. */
export function endThemePreview(): void {
  previewThemeMode(savedMode())
}

function savedMode(): ThemeMode {
  const t = initial()
  if (t === 'dark') return initialDark() === 'slate' ? 'slate' : 'dark'
  return initialTone()
}

/** Chooses one of the four palettes and keeps it. */
export function setThemeMode(m: ThemeMode): void {
  const dark = m === 'dark' || m === 'slate'
  if (dark) setDarkTone(m === 'slate' ? 'slate' : 'graphite')
  else setLightTone(m)
  const t: Theme = dark ? 'dark' : 'light'
  try { localStorage.setItem(KEY, t) } catch { /* private window */ }
  apply(t)
  window.dispatchEvent(new CustomEvent<Theme>(THEME_EVENT, { detail: t }))
}

/** What the page shows, as the picker names it, and the next one for the palette's cycle. */
export function useThemeMode(): { mode: ThemeMode; next: ThemeMode; cycle: () => void; set: (m: ThemeMode) => void } {
  const [theme, cycle] = useTheme()
  const [tone] = useLightTone()
  const [dark, setDark] = useState<DarkTone>(initialDark)
  useEffect(() => {
    document.documentElement.setAttribute('data-dark', dark)
    syncThemeColor()
  }, [dark])
  useEffect(() => {
    const on = (e: Event) => setDark((e as CustomEvent<DarkTone>).detail)
    window.addEventListener(DARK_EVENT, on)
    return () => window.removeEventListener(DARK_EVENT, on)
  }, [])
  const mode: ThemeMode = theme === 'dark' ? (dark === 'slate' ? 'slate' : 'dark') : tone
  return { mode, next: nextMode(mode), cycle, set: setThemeMode }
}

function initialTone(): LightTone {
  const saved = localStorage.getItem(TONE_KEY)
  return saved === 'paper' || saved === 'white' ? saved : DEFAULT_TONE
}

// useLightTone returns the light palette and a setter. Only a choice the user
// made is persisted, so DEFAULT_TONE still decides for everyone else.
export function useLightTone(): [LightTone, (t: LightTone) => void] {
  const [tone, setTone] = useState<LightTone>(initialTone)
  useEffect(() => {
    document.documentElement.setAttribute('data-tone', tone)
    syncThemeColor()
  }, [tone])
  useEffect(() => {
    const on = (e: Event) => setTone((e as CustomEvent<LightTone>).detail)
    window.addEventListener(TONE_EVENT, on)
    return () => window.removeEventListener(TONE_EVENT, on)
  }, [])
  return [tone, (t) => { setLightTone(t); setTone(t) }]
}
