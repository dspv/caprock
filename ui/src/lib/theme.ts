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
  return [theme, () => set(theme === 'dark' ? 'light' : 'dark'), set]
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
  }, [tone])
  return [
    tone,
    (t) => {
      localStorage.setItem(TONE_KEY, t)
      setTone(t)
    },
  ]
}
