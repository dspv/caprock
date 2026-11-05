/**
 * The sidebar's Today line (components/TodayLine.tsx), hidden by the viewer
 * (a user, 2026-10-15, translated: "can this be hidden? it's in the way";
 * the owner and a designer, 2026-11-05: "at least closable or shrunk to a
 * minimum"). Hidden, it is gone until Settings → Appearance or the sidebar's
 * ⋯ menu shows it again. Kept in this browser, like the sidebar's folds.
 * Until 2026-11-05 it was a card that also folded to one line; it is that
 * one line now, so the fold key (`caprock.app.today-fold`) is no longer read.
 */
import { useEffect, useState } from 'react'

/** `off` when hidden by hand; `on` or absent, shown. */
export const TODAY_SHOWN_KEY = 'caprock.app.today-shown'
/** Said on window when either changes, so the sidebar and Settings agree at once. */
export const TODAY_CARD_EVENT = 'caprock:today-card'

export interface TodayCard {
  hidden: boolean
}

function read(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

export function loadTodayCard(): TodayCard {
  return { hidden: read(TODAY_SHOWN_KEY) === 'off' }
}

export function saveTodayCard(next: Partial<TodayCard>) {
  try {
    if (next.hidden !== undefined) localStorage.setItem(TODAY_SHOWN_KEY, next.hidden ? 'off' : 'on')
  } catch { /* private window: for this page only */ }
  window.dispatchEvent(new CustomEvent(TODAY_CARD_EVENT, { detail: next }))
}

export function useTodayCard(): [TodayCard, (next: Partial<TodayCard>) => void] {
  const [card, setCard] = useState<TodayCard>(loadTodayCard)
  useEffect(() => {
    const onEvent = (e: Event) => {
      const d = (e as CustomEvent<Partial<TodayCard>>).detail ?? {}
      setCard((cur) => ({ ...cur, ...d }))
    }
    const onStorage = (e: StorageEvent) => { if (e.key === TODAY_SHOWN_KEY) setCard(loadTodayCard()) }
    window.addEventListener(TODAY_CARD_EVENT, onEvent)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(TODAY_CARD_EVENT, onEvent)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return [card, (next) => { setCard((cur) => ({ ...cur, ...next })); saveTodayCard(next) }]
}
