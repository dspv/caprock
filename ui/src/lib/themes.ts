/**
 * The app's palettes as data: one row each, so the picker, the cycle, the
 * pre-paint script in index.html, the phone's status bar and the terminal
 * all read the same table instead of special-casing names (owner,
 * 2026-10-11: plain names, and more of them).
 *
 * A palette is two attributes on <html>: `data-theme` (light or dark, which
 * every light/dark rule in the CSS keys on) and its own sub-attribute —
 * `data-dark` for a dark palette, `data-tone` for a light one — which
 * design/tokens.css keys the palette's colours on. `data-glow` marks the two
 * palettes whose accent glows. No React here, so termthemes.ts and the tests
 * can import it freely.
 */

export type ThemeMode = 'dark-pastel' | 'dark-warm' | 'dark-cold' | 'dark-side' | 'light' | 'light-cold' | 'book' | 'light-side' | 'sunlight'

export interface ThemeRow {
  id: ThemeMode
  /** What the picker and the theme button call it. */
  name: string
  theme: 'dark' | 'light'
  /** The value of `data-dark` (dark) or `data-tone` (light) in tokens.css. */
  sub: string
  /**
   * The header's panel colour (`--color-panel`): `<meta name="theme-color">`
   * for the phone's status bar, and the ground the app terminal sits on.
   */
  panel: string
  /** The picker's swatch: page, panel, ink, faint ink, accent, and a second accent where the palette has one. */
  swatch: { bg: string; panel: string; fg: string; muted: string; accent: string; accent2?: string }
  /** The app terminal's palette under Match app (termthemes.ts), drawn on `panel`. */
  terminal: string
  /** The dashboard and phone terminal: always dark (Terminal.tsx), in this palette's temperature. */
  dashTerminal: 'caprock' | 'slate' | 'dark-pastel' | 'dark-side'
  /** A soft neon glow on the focused field, the primary button and the active tab's top edge. */
  glow?: boolean
}

export const THEMES: readonly ThemeRow[] = [
  {
    // Neutral graphite, a dusty blue accent and low-chroma status colours,
    // for whoever finds the other dark palettes loud (testers, 2026-10-12).
    // The default dark palette since 2026-10-13 (owner), so listed first.
    id: 'dark-pastel', name: 'Dark Pastel', theme: 'dark', sub: 'pastel', panel: '#212221',
    swatch: { bg: '#1c1d1c', panel: '#292a29', fg: '#e3e1db', muted: '#97958e', accent: '#a3b6c9', accent2: '#8fbc98' },
    terminal: 'dark-pastel', dashTerminal: 'dark-pastel',
  },
  {
    id: 'dark-warm', name: 'Dark Warm', theme: 'dark', sub: 'graphite', panel: '#211f1d',
    swatch: { bg: '#1b1b1a', panel: '#262422', fg: '#e8e6e2', muted: '#8f8b84', accent: '#feb157' },
    terminal: 'caprock', dashTerminal: 'caprock',
  },
  {
    id: 'dark-cold', name: 'Dark Cold', theme: 'dark', sub: 'slate', panel: '#1f2023',
    swatch: { bg: '#1a1b1e', panel: '#26272b', fg: '#e6e7ea', muted: '#8b8e96', accent: '#86a9dc' },
    terminal: 'slate', dashTerminal: 'slate',
  },
  {
    id: 'dark-side', name: 'Dark Side', theme: 'dark', sub: 'side', panel: '#15111d',
    swatch: { bg: '#0d0b14', panel: '#1d1727', fg: '#ece8f5', muted: '#9087a6', accent: '#b45cff' },
    terminal: 'dark-side', dashTerminal: 'dark-side', glow: true,
  },
  {
    id: 'light', name: 'Light', theme: 'light', sub: 'white', panel: '#ffffff',
    swatch: { bg: '#faf9f7', panel: '#ffffff', fg: '#24211c', muted: '#6c675e', accent: '#99600a' },
    terminal: 'paper', dashTerminal: 'caprock',
  },
  {
    id: 'light-cold', name: 'Light Cold', theme: 'light', sub: 'cold', panel: '#f5f8fc',
    swatch: { bg: '#edf1f7', panel: '#f5f8fc', fg: '#121b2a', muted: '#56647b', accent: '#0057e0' },
    terminal: 'light-cold', dashTerminal: 'slate',
  },
  {
    id: 'book', name: 'Book', theme: 'light', sub: 'paper', panel: '#f4ecdd',
    swatch: { bg: '#efe7d6', panel: '#f4ecdd', fg: '#2b251c', muted: '#665d4f', accent: '#eb9a3e' },
    terminal: 'paper', dashTerminal: 'caprock',
  },
  {
    id: 'light-side', name: 'Light Side', theme: 'light', sub: 'side', panel: '#f9f6ef',
    swatch: { bg: '#f2eee5', panel: '#f9f6ef', fg: '#1d2127', muted: '#5e636b', accent: '#1763cc', accent2: '#137a3f' },
    terminal: 'light-side', dashTerminal: 'slate', glow: true,
  },
  {
    // For bright light (owner, 2026-10-15, translated: "a screen mode for
    // when you sit in the sun"): black on pure white, no faint greys, every
    // text colour 7:1 or more, dark hairlines, heavier text (tokens.css).
    id: 'sunlight', name: 'Sunlight', theme: 'light', sub: 'sun', panel: '#ffffff',
    swatch: { bg: '#ffffff', panel: '#f0f0f0', fg: '#000000', muted: '#3b3b3b', accent: '#0038b8' },
    terminal: 'sunlight', dashTerminal: 'slate',
  },
]

/** The order the picker lists them and the cycle walks them: the dark ones, then the light ones. */
export const THEME_MODES: readonly ThemeMode[] = THEMES.map((t) => t.id)

/**
 * What a viewer who never chose sees, by the OS preference. Dark Pastel
 * replaced Dark Warm as the dark default on 2026-10-13 (owner); tokens.css
 * paints it for a dark <html> with no or an unknown `data-dark` too.
 */
export const DEFAULT_DARK: ThemeMode = 'dark-pastel'
export const DEFAULT_LIGHT: ThemeMode = 'book'

export function themeRow(id: string | null | undefined): ThemeRow | undefined {
  return THEMES.find((t) => t.id === id)
}

/** The palette <html> shows, read off its attributes; an unknown sub falls to the default of its side. */
export function modeOf(theme: string | null, tone: string | null, dark: string | null): ThemeMode {
  const side = theme === 'light' ? 'light' : 'dark'
  const sub = side === 'light' ? tone : dark
  return THEMES.find((t) => t.theme === side && t.sub === sub)?.id ?? (side === 'light' ? DEFAULT_LIGHT : DEFAULT_DARK)
}

/** The mode <html> shows now. */
export function modeOfRoot(root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement): ThemeMode {
  return modeOf(root?.getAttribute('data-theme') ?? null, root?.getAttribute('data-tone') ?? null, root?.getAttribute('data-dark') ?? null)
}

/** Where the choice is kept. `caprock-theme` (light or dark) is still written: the tray window and the screenshot scripts read it. */
export const MODE_KEY = 'caprock-theme-mode'
export const THEME_KEY = 'caprock-theme'
/** Before 2026-10-11 the palette within a side was kept on its own. */
export const LEGACY_DARK_KEY = 'caprock-dark-tone'
export const LEGACY_LIGHT_KEY = 'caprock-light-tone'

/**
 * The kept palette. The mode key wins while it agrees with `caprock-theme`;
 * otherwise (nothing kept yet, an install from before the rename, or a script
 * that set only `caprock-theme`) the old keys decide: Slate is Dark Cold,
 * White Light, Paper Book, and anything else the default of its side.
 *
 * Only `caprock-theme-mode` is a choice. The old `caprock-dark-tone` key held
 * `graphite` whether or not anyone picked it (it was the default), so it goes
 * to the default — Dark Pastel since 2026-10-13 — and not to Dark Warm; Slate
 * was always picked, so it stays Dark Cold. Whoever chose Dark Warm in the
 * picker since 2026-10-11 has the mode key and keeps it. Mirrored in
 * index.html's pre-paint script; theme.test.ts runs that script against this.
 */
export function resolveMode(get: (k: string) => string | null, prefersLight: boolean): ThemeMode {
  const t = get(THEME_KEY)
  const kept = themeRow(get(MODE_KEY))
  if (kept && (t === kept.theme || (t !== 'dark' && t !== 'light'))) return kept.id
  const side = t === 'dark' || t === 'light' ? t : prefersLight ? 'light' : 'dark'
  if (side === 'dark') return get(LEGACY_DARK_KEY) === 'slate' ? 'dark-cold' : DEFAULT_DARK
  return get(LEGACY_LIGHT_KEY) === 'white' ? 'light' : DEFAULT_LIGHT
}
