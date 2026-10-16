/**
 * Where you are on the dashboard, in words (owner, 2026-10-16, translated:
 * "when you walk through the dashboard's pages … sometimes it's unclear where
 * you went and where you ended up"). The header says the page's name beside
 * the wordmark, the browser tab says it too, and every page but Home carries
 * a way back to Home (components/WhereAmI.tsx; .ai/04-ui.md § Where am I).
 */
import { useContext, useEffect } from 'react'
import type { Route } from './router'
import { screenName } from './feedback'
import { ScreenShown } from './refresh'

/** Whether a route is the dashboard's home: #/, #/home and the older #/now. */
export function isHome(r: Route): boolean {
  return r.name === 'now'
}

/** The last part of a folder path, either separator (a Windows path too). */
function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

/**
 * The page's name as the header shows it: the screen, then what it is
 * showing when the address says (the Pipeline's repository, a part of
 * Settings).
 */
export function pageTitle(r: Route): string {
  switch (r.name) {
    case 'session': return 'Session'
    case 'pipeline': return r.repo ? `Pipeline · ${folderName(r.repo)}` : 'Pipeline'
    case 'settings': return r.section === 'phone' ? 'Settings · Phone' : r.section === 'telegram' ? 'Settings · Telegram' : 'Settings'
    case 'tasks': return r.view === 'queue' ? 'Tasks · Queue' : 'Tasks'
    default: return screenName(r)
  }
}

/** The browser tab's title: the page, then the product ("Pipeline · caprock"); Home is the product alone. */
export function documentTitle(r: Route): string {
  return isHome(r) ? 'caprock' : `${pageTitle(r)} · caprock`
}

/** Sets the tab's title while the page is the one in front (a kept, hidden screen leaves it alone). */
export function useDocumentTitle(title: string, on = true): void {
  const shown = useContext(ScreenShown)
  useEffect(() => {
    if (on && shown) document.title = title
  }, [title, on, shown])
}
