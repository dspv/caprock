/**
 * The search over Settings (lib/settingsSearch.ts): a field at the top of the
 * Settings menu, and above the sections where the menu is not drawn (under
 * the `xl` breakpoint). Typing filters the sections live — by title and by
 * every text inside them — and marks the words; Enter, or a click on a
 * result in the menu, scrolls to the control that matched and lights it for
 * a moment. Esc clears. ⌘F (Ctrl+Shift+F off macOS, the app's Find; plain
 * Ctrl+F too, which nothing on this page holds) puts the cursor in it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { REVEAL_EVENT } from './SettingsParts'
import { SETTINGS_FIND_EVENT, findTarget, flash, highlight, indexPage, searchSections, type SectionMatch } from '@/lib/settingsSearch'
import { keys, matchAppShortcut } from '@/lib/appkeys'
import { isMacPlatform } from '@/lib/appmode'

export interface SettingsSearchState {
  query: string
  setQuery: (q: string) => void
  /** The sections the query finds, best first; empty for an empty query. */
  matches: SectionMatch[]
  jump: (m: SectionMatch) => void
}

/** The ids of the sections shown while a query is typed; null shows every one. */
export const SettingsFilterContext = createContext<Set<string> | null>(null)

/** Whether a section is hidden by the search (SettingsParts' Section). */
export function useFilteredOut(id: string): boolean {
  const shown = useContext(SettingsFilterContext)
  return !!shown && !shown.has(id)
}

export function useSettingsSearch(page: RefObject<HTMLElement | null>): SettingsSearchState {
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<SectionMatch[]>([])

  // Read the page again as it changes: sections arrive with their data, and
  // one unfolded shows the texts it had hidden.
  useEffect(() => {
    const el = page.current
    if (!el) return
    let t = 0
    const read = () => {
      const next = searchSections(indexPage(el), query)
      setMatches((prev) => (prev.length === next.length && prev.every((p, i) => p.id === next[i]!.id && p.hit === next[i]!.hit) ? prev : next))
    }
    read()
    const mo = new MutationObserver(() => { window.clearTimeout(t); t = window.setTimeout(read, 120) })
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    return () => { mo.disconnect(); window.clearTimeout(t) }
  }, [page, query])

  // Mark the words once the filter has drawn.
  useEffect(() => {
    highlight(page.current, query)
  }, [page, query, matches])
  useEffect(() => () => highlight(null, ''), [])

  const jump = useCallback((m: SectionMatch) => {
    const land = (tries: number) => {
      const s = document.getElementById(m.id)
      if (!s) return
      // A folded section unfolds first; its body draws a beat later.
      if (s.querySelector('header [aria-expanded="false"]')) {
        window.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: m.id }))
        if (tries < 10) { window.setTimeout(() => land(tries + 1), 30); return }
      }
      flash(findTarget(s, m.hit))
    }
    land(0)
  }, [])

  return { query, setQuery, matches, jump }
}

/** The ids a search shows, for SettingsFilterContext; null with no query. */
export function useShownIds(search: SettingsSearchState): Set<string> | null {
  const { query, matches } = search
  return useMemo(() => (query.trim() ? new Set(matches.map((m) => m.id)) : null), [query, matches])
}

/**
 * ⌘F on the Settings page: the visible search field gets the cursor. In the
 * desktop app the shell holds the key and says so with SETTINGS_FIND_EVENT;
 * in a browser the page hears it itself.
 */
export function useFindKey(focus: () => void) {
  const ref = useRef(focus)
  useEffect(() => { ref.current = focus })
  useEffect(() => {
    const mac = isMacPlatform()
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const plainCtrlF = !mac && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'f'
      if (matchAppShortcut(e, mac)?.kind !== 'find' && !plainCtrlF) return
      e.preventDefault()
      ref.current()
    }
    const onFind = () => ref.current()
    window.addEventListener('keydown', onKey)
    window.addEventListener(SETTINGS_FIND_EVENT, onFind)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(SETTINGS_FIND_EVENT, onFind)
    }
  }, [])
}

function SearchIcon() {
  return (
    <svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none absolute left-2.5 text-fg-muted">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  )
}

export function SettingsSearchField({ search, className = '' }: { search: SettingsSearchState; className?: string }) {
  const { query, setQuery, matches, jump } = search
  const key = keys('⌘F')
  return (
    <div data-settings-keep="" className={`relative flex items-center ${className}`}>
      <SearchIcon />
      <input
        type="search"
        data-settings-search=""
        aria-label="Search settings"
        placeholder="Search settings"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // Esc clears; on an empty field it lets go of the cursor, and the
            // next Esc leaves Settings as from anywhere else on the page.
            e.preventDefault()
            e.stopPropagation()
            if (query) setQuery('')
            else e.currentTarget.blur()
          } else if (e.key === 'Enter' && matches[0]) {
            e.preventDefault()
            jump(matches[0])
          }
        }}
        className="h-9 w-full min-w-0 rounded-[8px] border border-[var(--app-hairline-strong)] bg-panel pl-8 pr-14 text-[14px] text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {query ? (
        <button type="button" aria-label="Clear the search" title="Clear (Esc)" onClick={() => setQuery('')}
          className="absolute right-1.5 inline-flex h-6 items-center rounded-[5px] px-1.5 text-[12px] text-fg-muted hover:text-fg">
          Esc
        </button>
      ) : (
        <kbd className="pointer-events-none absolute right-2 rounded-[4px] border border-[var(--app-hairline-strong)] px-1 text-[11px] text-fg-faint">{key}</kbd>
      )}
    </div>
  )
}

/** "Nothing matches “x”": the one line a search that finds nothing leaves. */
export function NothingMatches({ query, className = '' }: { query: string; className?: string }) {
  return <p role="status" data-settings-keep="" className={`text-[13.5px] text-fg-muted ${className}`}>Nothing matches “{query.trim()}”</p>
}

/** A title with the query's words marked, for the menu's results. */
export function Marked({ text, query }: { text: string; query: string }) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return <>{text}</>
  const lower = text.toLowerCase()
  const marks: [number, number][] = []
  for (const t of terms) {
    for (let i = lower.indexOf(t); i >= 0; i = lower.indexOf(t, i + t.length)) marks.push([i, i + t.length])
  }
  if (marks.length === 0) return <>{text}</>
  marks.sort((a, b) => a[0] - b[0])
  const out: ReactNode[] = []
  let at = 0
  for (const [a, b] of marks) {
    if (a < at) continue
    if (a > at) out.push(text.slice(at, a))
    out.push(<mark key={a} className="rounded-[2px] bg-accent/25 text-inherit">{text.slice(a, b)}</mark>)
    at = b
  }
  out.push(text.slice(at))
  return <>{out}</>
}
