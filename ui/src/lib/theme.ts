import { useEffect, useState } from 'react'

export type Theme = 'dark' | 'light'

const KEY = 'caprock-theme'

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

// useTheme returns the current theme and a toggle. The choice is persisted, so it
// sticks across reloads; with nothing saved the OS preference is followed.
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(initial)
  useEffect(() => {
    apply(theme)
    localStorage.setItem(KEY, theme)
  }, [theme])
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))]
}
