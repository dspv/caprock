/**
 * The app terminal's palettes (F21). Each is a full xterm theme plus the tone
 * of the slab around it, so the tab in front and the pane headers match the
 * terminal they frame.
 *
 * Licences, checked 2026-10-06 — every palette here is MIT:
 *
 * - **Dark Warm** (id `caprock`) and **Book** (id `paper`) are ours. Dark
 *   Warm is the dashboard terminal's ink (TERMINAL_THEME in
 *   components/Terminal.tsx, asserted equal in termthemes.test.ts) on the
 *   Dark Warm panel, the colour of the tab strip around it, with a warm
 *   16-colour set; Book is the Book palette's cream (tokens.css,
 *   `[data-tone="paper"]`) with ink dark enough to read on it. The ids are
 *   the names from before the rename (2026-10-11), kept so a stored choice
 *   still finds its palette.
 * - **Dark Cold** (id `slate`), **Dark Pastel**, **Light Cold**, **Light
 *   Side** and **Dark Side** are ours too: each app palette's own ground (its
 *   panel, `panel` in lib/themes.ts) with a 16-colour set in its temperature —
 *   cool for the two Colds, low-chroma for Dark Pastel, blue and green on sand
 *   for Light Side, red-leaning on near-black for Dark Side, every colour
 *   still distinct from the others.
 * - **Sunlight** is ours: black on pure white for bright light, every one of
 *   the 16 colours 5.3:1 or more on the ground and the eight normal ones 7:1
 *   or more — the yellow a dark ochre, the cyan a deep teal, "white" and
 *   bright white mid greys — so nothing washes out in glare.
 * - **Match app** is not a palette but a choice: the app palette's own
 *   terminal (`terminal` in lib/themes.ts) on that palette's panel colour, so
 *   the terminal reads as part of the window rather than a window on top of
 *   it (tester, 2026-10-09). It is the default.
 * - **Catppuccin Mocha** — github.com/catppuccin/alacritty (catppuccin-mocha.toml), MIT.
 * - **Tokyo Night** — github.com/enkia/tokyo-night-vscode-theme, MIT. Bright
 *   black is lifted from its #363b54 (the same as black) so dim text shows.
 * - **Solarized Dark** — github.com/altercation/solarized, MIT (Ethan Schoonover).
 */

import { THEMES, modeOfRoot, themeRow, type ThemeMode } from './themes'

const THEME_COLORS = Object.fromEntries(THEMES.map((t) => [t.id, t.panel])) as Record<ThemeMode, string>

/** The xterm.js theme fields the app sets. */
export interface TerminalColors {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface TerminalTheme {
  id: string
  name: string
  /** Light grounds get light chrome around them and a contrast floor. */
  tone: 'dark' | 'light'
  colors: TerminalColors
}

/**
 * The panel colour of the app palettes these terminals sit on
 * (`--color-panel` in design/tokens.css, `panel` in lib/themes.ts): the tab
 * strip's ground, so a terminal on it has no edge.
 */
const APP_PANEL = { dark: THEME_COLORS['dark-warm'], slate: THEME_COLORS['dark-cold'] } as const

/** The app terminal's dark palette since WP-04; what Match app shows in Dark Warm. */
export const APP_TERMINAL_THEME: TerminalColors = {
  // The dark panel, not the page's #1b1b1a: one shade darker than the strip
  // above it, the terminal read as a window laid over the app.
  background: APP_PANEL.dark,
  foreground: '#e8e6e2',
  cursor: '#feb157',
  cursorAccent: APP_PANEL.dark,
  selectionBackground: '#4a4640',
  black: '#2b2926',
  red: '#e8786d',
  green: '#a3c77e',
  yellow: '#e7bb63',
  blue: '#82a9d9',
  magenta: '#c99ad0',
  cyan: '#7fc4b9',
  white: '#d8d3ca',
  brightBlack: '#6b665e',
  brightRed: '#f3958b',
  brightGreen: '#bad99a',
  brightYellow: '#f2cf86',
  brightBlue: '#a0c0e8',
  brightMagenta: '#dcb5e2',
  brightCyan: '#9dd8ce',
  brightWhite: '#f4f0e8',
}

/**
 * Dark Cold's terminal: its panel with neutral ink, a blue cursor and a
 * cool 16-colour set (owner, 2026-10-11: the terminal should be as cool as the
 * rest of the palette). What Match app shows in Dark Cold.
 */
export const SLATE_TERMINAL_THEME: TerminalColors = {
  background: APP_PANEL.slate,
  foreground: '#e6e7ea',
  cursor: '#86a9dc',
  cursorAccent: APP_PANEL.slate,
  selectionBackground: '#33415a',
  black: '#2a2c31',
  red: '#f07178',
  green: '#8fd18f',
  yellow: '#e6d47a',
  blue: '#6ea8fe',
  magenta: '#b99cf5',
  cyan: '#6cd0e0',
  white: '#cfd2d8',
  brightBlack: '#6a6e78',
  brightRed: '#ff9198',
  brightGreen: '#a9e2a9',
  brightYellow: '#f0e19a',
  brightBlue: '#9cc4ff',
  brightMagenta: '#cfb8fa',
  brightCyan: '#93e0ec',
  brightWhite: '#f2f3f5',
}

/**
 * Dark Pastel's terminal: its graphite panel, a dusty blue cursor and a
 * low-chroma 16-colour set — every hue still apart from the others, so a
 * diff or a test run reads, but nothing shouts (testers, 2026-10-12).
 */
export const PASTEL_TERMINAL_THEME: TerminalColors = {
  background: THEME_COLORS['dark-pastel'],
  foreground: '#e3e1db',
  cursor: '#a3b6c9',
  cursorAccent: THEME_COLORS['dark-pastel'],
  selectionBackground: '#3a4048',
  black: '#2c2d2c',
  red: '#d99a9a',
  green: '#a3c4a0',
  yellow: '#d8c38f',
  blue: '#9db3cc',
  magenta: '#bfa9d4',
  cyan: '#98c3c0',
  white: '#cfccc4',
  brightBlack: '#7a7872',
  brightRed: '#e6b2b2',
  brightGreen: '#b9d5b6',
  brightYellow: '#e6d4a8',
  brightBlue: '#b7c8db',
  brightMagenta: '#d1c0e1',
  brightCyan: '#b2d4d1',
  brightWhite: '#ecebe6',
}

/**
 * Dark Side's terminal: the near-black violet panel, a neon purple cursor
 * and a violet-leaning 16-colour set, green, blue, cyan and red kept clear
 * of each other so a diff or a test run still reads.
 */
export const DARK_SIDE_TERMINAL_THEME: TerminalColors = {
  background: '#15111d',
  foreground: '#ece8f5',
  cursor: '#b45cff',
  cursorAccent: '#15111d',
  selectionBackground: '#3d2a5c',
  black: '#241d31',
  red: '#ff5a5a',
  green: '#93cf86',
  yellow: '#f0c27a',
  blue: '#86a8e6',
  magenta: '#c88cff',
  cyan: '#79c6c4',
  white: '#d6d0e3',
  brightBlack: '#8a80a3',
  brightRed: '#ff8a85',
  brightGreen: '#b0e2a4',
  brightYellow: '#f6d7a0',
  brightBlue: '#a9c3f0',
  brightMagenta: '#dcb5ff',
  brightCyan: '#9ddad8',
  brightWhite: '#f5f2fb',
}

/**
 * Sunlight's terminal: black on white, a deep blue cursor, and a 16-colour
 * set that holds in glare — every colour 5.3:1 or more on the ground, the
 * normal eight 7:1 or more (termthemes.test.ts measures them). On a light
 * ground "white" and bright white are text colours too, so they are greys
 * dark enough to read rather than near-white.
 */
export const SUNLIGHT_TERMINAL_THEME: TerminalColors = {
  background: '#ffffff',
  foreground: '#000000',
  cursor: '#0038b8',
  cursorAccent: '#ffffff',
  selectionBackground: '#c2d3f5',
  black: '#000000',
  red: '#b3000f',
  green: '#00661c',
  yellow: '#755000',
  blue: '#0038b8',
  magenta: '#8f0f8f',
  cyan: '#00616b',
  white: '#545454',
  brightBlack: '#3b3b3b',
  brightRed: '#d10014',
  brightGreen: '#007a24',
  brightYellow: '#8a5d00',
  brightBlue: '#1452d6',
  brightMagenta: '#a3179f',
  brightCyan: '#00737d',
  brightWhite: '#6b6b6b',
}

/**
 * The contrast every terminal cell keeps against its own background, in every
 * palette (WCAG AA for body text): the ground, a colour a program paints
 * behind text, and the selection.
 */
export const TERMINAL_MIN_CONTRAST = 4.5

/** The choice that follows the app's theme rather than naming a palette. */
export const MATCH_APP_THEME = 'match'

/** What a viewer who never chose sees. */
export const DEFAULT_TERMINAL_THEME = MATCH_APP_THEME

export const TERMINAL_THEMES: readonly TerminalTheme[] = [
  { id: 'caprock', name: 'Dark Warm', tone: 'dark', colors: APP_TERMINAL_THEME },
  { id: 'slate', name: 'Dark Cold', tone: 'dark', colors: SLATE_TERMINAL_THEME },
  { id: 'dark-pastel', name: 'Dark Pastel', tone: 'dark', colors: PASTEL_TERMINAL_THEME },
  {
    id: 'paper',
    name: 'Book',
    tone: 'light',
    colors: {
      background: '#efe7d6',
      foreground: '#24211c',
      cursor: '#b8730d',
      cursorAccent: '#efe7d6',
      selectionBackground: '#d9c9a8',
      black: '#24211c',
      red: '#b3372b',
      green: '#4f7a28',
      yellow: '#8f6208',
      blue: '#2f5f9e',
      magenta: '#8a4a9b',
      cyan: '#2a7a72',
      white: '#bdb2a0',
      brightBlack: '#6f695f',
      brightRed: '#c9493c',
      brightGreen: '#5f8f33',
      brightYellow: '#a67812',
      brightBlue: '#3f73b8',
      brightMagenta: '#9d5cae',
      brightCyan: '#348f86',
      brightWhite: '#e6dcc8',
    },
  },
  {
    id: 'light-cold',
    name: 'Light Cold',
    tone: 'light',
    colors: {
      background: '#f5f8fc',
      foreground: '#121b2a',
      cursor: '#0057e0',
      cursorAccent: '#f5f8fc',
      selectionBackground: '#cbdaf0',
      black: '#121b2a',
      red: '#c0273d',
      green: '#167a45',
      yellow: '#766400',
      blue: '#0a55cc',
      magenta: '#8a3cbc',
      cyan: '#00727f',
      white: '#a3b0c3',
      brightBlack: '#56647b',
      brightRed: '#d6384f',
      brightGreen: '#1f8c52',
      brightYellow: '#8a7500',
      brightBlue: '#2b6fe6',
      brightMagenta: '#9d52d0',
      brightCyan: '#078698',
      brightWhite: '#dce4ef',
    },
  },
  {
    id: 'light-side',
    name: 'Light Side',
    tone: 'light',
    colors: {
      background: '#f9f6ef',
      foreground: '#1d2127',
      cursor: '#1763cc',
      cursorAccent: '#f9f6ef',
      selectionBackground: '#d3def0',
      black: '#1d2127',
      red: '#b4302d',
      green: '#137a3f',
      yellow: '#806000',
      blue: '#1a5cbf',
      magenta: '#86449f',
      cyan: '#0f767c',
      white: '#b6ae9e',
      brightBlack: '#5e636b',
      brightRed: '#c8423e',
      brightGreen: '#1a8f4c',
      brightYellow: '#967000',
      brightBlue: '#2b74d9',
      brightMagenta: '#9a58b6',
      brightCyan: '#178a91',
      brightWhite: '#e5dfd1',
    },
  },
  { id: 'sunlight', name: 'Sunlight', tone: 'light', colors: SUNLIGHT_TERMINAL_THEME },
  { id: 'dark-side', name: 'Dark Side', tone: 'dark', colors: DARK_SIDE_TERMINAL_THEME },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    tone: 'dark',
    colors: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      cursorAccent: '#1e1e2e',
      selectionBackground: '#585b70',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f38ba8',
      brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue: '#89b4fa',
      brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5',
      brightWhite: '#a6adc8',
    },
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    tone: 'dark',
    // The theme's editor ground, ink and cursor with its terminal ANSI set
    // (themes/tokyo-night-color-theme.json); its selection is #515c7e at 30%
    // alpha, written here flattened onto the ground.
    colors: {
      background: '#1a1b26',
      foreground: '#a9b1d6',
      cursor: '#c0caf5',
      cursorAccent: '#1a1b26',
      selectionBackground: '#2b2e40',
      black: '#363b54',
      red: '#f7768e',
      green: '#73daca',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#787c99',
      brightBlack: '#4e5575',
      brightRed: '#f7768e',
      brightGreen: '#73daca',
      brightYellow: '#e0af68',
      brightBlue: '#7aa2f7',
      brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff',
      brightWhite: '#acb0d0',
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    tone: 'dark',
    colors: {
      background: '#002b36',
      foreground: '#839496',
      cursor: '#93a1a1',
      cursorAccent: '#002b36',
      selectionBackground: '#073642',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#002b36',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3',
    },
  },
]

/** What the app shows: which of its palettes (lib/themes.ts). */
export interface AppLook {
  mode: ThemeMode
}

/** The app's look, read off <html> (lib/theme.ts sets data-theme with data-tone or data-dark). */
export function appLook(root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement): AppLook {
  return { mode: modeOfRoot(root) }
}

/** Every choice Settings → Terminal offers: Match app, then the palettes. */
export const TERMINAL_CHOICES: readonly { id: string; name: string }[] = [
  { id: MATCH_APP_THEME, name: 'Match app' },
  ...TERMINAL_THEMES.map((t) => ({ id: t.id, name: t.name })),
]

/** Whether an id is something a viewer can choose. */
export function isTerminalChoice(id: string): boolean {
  return TERMINAL_CHOICES.some((c) => c.id === id)
}

/**
 * The palette a choice shows. Match app, and an id no longer offered, follow
 * the app: its palette's own terminal (`terminal` in lib/themes.ts) on its
 * panel colour — Caprock in Dark Warm, Paper's ink on white in Light.
 */
export function terminalTheme(id: string, look: AppLook = appLook()): TerminalTheme {
  const named = TERMINAL_THEMES.find((t) => t.id === id)
  if (named) return named
  const row = themeRow(look.mode)!
  const own = TERMINAL_THEMES.find((t) => t.id === row.terminal) ?? TERMINAL_THEMES[0]!
  if (own.colors.background === row.panel) return own
  return { id: `${MATCH_APP_THEME}-${row.id}`, name: 'Match app', tone: own.tone, colors: { ...own.colors, background: row.panel, cursorAccent: row.panel } }
}

/**
 * The dashboard and phone terminal's ground per dark palette: the page's own
 * `--color-bg` in that palette (`--color-term-bg` in design/tokens.css). The
 * terminal there is dark in every theme (components/Terminal.tsx); the app
 * palette picks which dark (`dashTerminal` in lib/themes.ts).
 */
export const DASH_GROUND = { caprock: '#1b1b1a', slate: '#1a1b1e', 'dark-pastel': '#1c1d1c', 'dark-side': '#0d0b14' } as const

/** `a` mixed toward `b` by t (0–1), as #rrggbb — what xterm's decorations accept. */
export function mixHex(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const [x, y] = [p(a), p(b)]
  return `#${x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, '0')).join('')}`
}

/** Search highlights drawn from the theme's own yellow, so they read on any ground. */
export function searchColors(t: TerminalTheme) {
  const { background, yellow, cursor } = t.colors
  return {
    matchBackground: mixHex(background, yellow, t.tone === 'light' ? 0.3 : 0.28),
    matchBorder: mixHex(background, yellow, 0.6),
    matchOverviewRuler: yellow,
    activeMatchBackground: mixHex(background, yellow, t.tone === 'light' ? 0.55 : 0.5),
    activeMatchBorder: cursor,
    activeMatchColorOverviewRuler: cursor,
  }
}
