/**
 * The app terminal's palettes (F21). Each is a full xterm theme plus the tone
 * of the slab around it, so the tab in front and the pane headers match the
 * terminal they frame.
 *
 * Licences, checked 2026-10-06 — every palette here is MIT:
 *
 * - **Caprock** and **Paper** are ours. Caprock is the dashboard terminal's
 *   ink (TERMINAL_THEME in components/Terminal.tsx, asserted equal in
 *   termthemes.test.ts) on the dark theme's panel, the colour of the tab
 *   strip around it, with a warm 16-colour set; Paper is the light theme's
 *   cream (tokens.css, `[data-tone="paper"]`) with ink dark enough to read on
 *   it.
 * - **Match app** is not a palette but a choice between the two: Caprock in
 *   the dark theme, Paper on the light theme's panel colour in the light one,
 *   so the terminal reads as part of the window rather than a window on top
 *   of it (tester, 2026-10-09). It is the default.
 * - **Catppuccin Mocha** — github.com/catppuccin/alacritty (catppuccin-mocha.toml), MIT.
 * - **Tokyo Night** — github.com/enkia/tokyo-night-vscode-theme, MIT. Bright
 *   black is lifted from its #363b54 (the same as black) so dim text shows.
 * - **Solarized Dark** — github.com/altercation/solarized, MIT (Ethan Schoonover).
 */

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
 * The panel colour of each app palette (`--color-panel` in design/tokens.css,
 * THEME_COLORS in lib/theme.ts): the tab strip's ground, so a terminal on it
 * has no edge.
 */
export const APP_PANEL = { dark: '#211f1d', paper: '#f4ecdd', white: '#ffffff' } as const

/** The app terminal's dark palette since WP-04; what Match app shows in the dark theme. */
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

/** The choice that follows the app's theme rather than naming a palette. */
export const MATCH_APP_THEME = 'match'

/** What a viewer who never chose sees. */
export const DEFAULT_TERMINAL_THEME = MATCH_APP_THEME

export const TERMINAL_THEMES: readonly TerminalTheme[] = [
  { id: 'caprock', name: 'Caprock', tone: 'dark', colors: APP_TERMINAL_THEME },
  {
    id: 'paper',
    name: 'Paper',
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

/** What the app shows: its theme and, when light, which light palette. */
export interface AppLook {
  theme: 'dark' | 'light'
  tone: 'paper' | 'white'
}

/** The app's look, read off <html> (lib/theme.ts sets data-theme and data-tone). */
export function appLook(root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement): AppLook {
  return {
    theme: root?.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
    tone: root?.getAttribute('data-tone') === 'white' ? 'white' : 'paper',
  }
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
 * the app: Caprock when it is dark, Paper on the light panel when it is light.
 */
export function terminalTheme(id: string, look: AppLook = appLook()): TerminalTheme {
  const named = TERMINAL_THEMES.find((t) => t.id === id)
  if (named) return named
  if (look.theme === 'dark') return TERMINAL_THEMES[0]!
  const paper = TERMINAL_THEMES.find((t) => t.id === 'paper')!
  const ground = APP_PANEL[look.tone]
  return { id: `${MATCH_APP_THEME}-${look.tone}`, name: 'Match app', tone: 'light', colors: { ...paper.colors, background: ground, cursorAccent: ground } }
}

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
