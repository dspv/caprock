/**
 * The sidebar's Today card (components/TodayStrip.tsx), folded or hidden by
 * the viewer (a user, 2026-10-15, translated: "can this be hidden? it's in
 * the way" — the same figures are on the right panel). Folded, it is one
 * line; hidden, it is gone until Settings → Appearance shows it again, and
 * what waits on you is counted on the list's heading instead. Both are this
 * browser's, kept like the sidebar's other folds.
 */
import { useEffect, useState } from 'react'

/** `closed` when folded to one line; `open` or absent, the whole card. */
export const TODAY_FOLD_KEY = 'caprock.app.today-fold'
/** `off` when hidden by hand; `on` or absent, shown. */
export const TODAY_SHOWN_KEY = 'caprock.app.today-shown'
/** Said on window when either changes, so the sidebar and Settings agree at once. */
export const TODAY_CARD_EVENT = 'caprock:today-card'

export interface TodayCard {
  folded: boolean
  hidden: boolean
}

function read(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

export function loadTodayCard(): TodayCard {
  return { folded: read(TODAY_FOLD_KEY) === 'closed', hidden: read(TODAY_SHOWN_KEY) === 'off' }
}

export function saveTodayCard(next: Partial<TodayCard>) {
  try {
    if (next.folded !== undefined) localStorage.setItem(TODAY_FOLD_KEY, next.folded ? 'closed' : 'open')
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
    const onStorage = (e: StorageEvent) => { if (e.key === TODAY_FOLD_KEY || e.key === TODAY_SHOWN_KEY) setCard(loadTodayCard()) }
    window.addEventListener(TODAY_CARD_EVENT, onEvent)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(TODAY_CARD_EVENT, onEvent)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return [card, (next) => { setCard((cur) => ({ ...cur, ...next })); saveTodayCard(next) }]
}
