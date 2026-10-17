/**
 * The Settings page's own menu (owner, 2026-10-11: "the settings need a menu"
 * — eighteen sections in one column, found by scrolling). A sticky list of the
 * sections the page drew, in its order, the one in view highlighted; a click
 * scrolls to it. Read from the page itself (`data-settings-section`), so a
 * section that is not shown here (a phone, a paired device) is not listed.
 *
 * The search field sits at its top (SettingsSearch): with a query the list
 * is the sections it finds, best first, each with the line inside that
 * matched; a click jumps to that control.
 */
import { useEffect, useState, type RefObject } from 'react'
import { SectionIcon } from './SettingsIcons'
import { Marked, NothingMatches, SettingsSearchField, type SettingsSearchState } from './SettingsSearch'

/** About how many characters fit the 224px menu before it cuts a title. */
const TITLE_FITS = 26

interface Item { id: string; title: string }

export function SettingsNav({ root, search }: { root: RefObject<HTMLElement | null>; search: SettingsSearchState }) {
  const [items, setItems] = useState<Item[]>([])
  const [active, setActive] = useState('')
  // Held below the dashboard's sticky header where there is one (a
  // browser): at top-4 the search field slid under it once the page scrolled.
  const [top, setTop] = useState(16)
  useEffect(() => {
    const h = document.querySelector<HTMLElement>('[data-shell-header]')
    if (!h || typeof ResizeObserver !== 'function') return
    const on = () => setTop((h.getClientRects().length > 0 ? h.offsetHeight : 0) + 16)
    on()
    const ro = new ResizeObserver(on)
    ro.observe(h)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const el = root.current
    if (!el) return
    const read = () => {
      const next = [...el.querySelectorAll<HTMLElement>('[data-settings-section]')].map((s) => ({ id: s.id, title: s.dataset.settingsSection ?? '' }))
      setItems((prev) => (prev.length === next.length && prev.every((p, i) => p.id === next[i]!.id) ? prev : next))
    }
    read()
    // Sections arrive as their data does: read again when the page changes.
    const mo = new MutationObserver(read)
    mo.observe(el, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [root])

  useEffect(() => {
    const el = root.current
    if (!el || items.length === 0 || typeof IntersectionObserver !== 'function') return
    const seen = new Map<string, boolean>()
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set(e.target.id, e.isIntersecting)
      const first = items.find((i) => seen.get(i.id))
      if (first) setActive(first.id)
    }, { rootMargin: '0px 0px -60% 0px' })
    for (const i of items) {
      const s = document.getElementById(i.id)
      if (s) io.observe(s)
    }
    return () => io.disconnect()
  }, [items, root])

  if (items.length < 4) return null
  const q = search.query.trim()
  // A tooltip only where the menu cuts the title: one on every row covered
  // the row above it while it said nothing new (owner, 2026-10-17).
  return (
    <nav aria-label="Settings sections" style={{ top, maxHeight: `calc(100vh - ${top + 24}px)` }} className="sticky hidden w-[224px] shrink-0 self-start overflow-y-auto xl:block">
      <SettingsSearchField search={search} className="mb-2" />
      {q && search.matches.length === 0 && <NothingMatches query={q} className="px-3 py-1.5" />}
      {q ? (
        <ul className="grid gap-0.5" data-settings-results="">
          {search.matches.map((m) => (
            <li key={m.id}>
              <button type="button" title={m.title.length > TITLE_FITS ? m.title : undefined}
                onClick={() => search.jump(m)}
                className="grid w-full gap-0.5 rounded-[7px] px-3 py-1.5 text-left text-[13.5px] text-fg hover:bg-[var(--app-row-hover,var(--color-panel-2))]">
                <span className="flex min-w-0 items-center gap-2">
                  <SectionIcon title={m.title} size={14} />
                  <span className="min-w-0 truncate"><Marked text={m.title} query={q} /></span>
                </span>
                {m.hit && <span className="truncate pl-[22px] text-[12px] text-fg-muted"><Marked text={m.hit} query={q} /></span>}
              </button>
            </li>
          ))}
        </ul>
      ) : (
      <ul className="grid gap-0.5">
        {items.map((i) => (
          <li key={i.id}>
            <button type="button" title={i.title.length > TITLE_FITS ? i.title : undefined} aria-current={active === i.id ? 'true' : undefined}
              onClick={() => { document.getElementById(i.id)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); setActive(i.id) }}
              className={`flex w-full items-center gap-2 truncate rounded-[7px] px-3 py-1.5 text-left text-[13.5px] ${active === i.id ? 'bg-[var(--app-row-active,var(--color-panel-2))] font-medium text-fg' : 'text-fg-muted hover:bg-[var(--app-row-hover,var(--color-panel-2))] hover:text-fg'}`}>
              <SectionIcon title={i.title} size={14} />
              <span className="min-w-0 truncate">{i.title}</span>
            </button>
          </li>
        ))}
      </ul>
      )}
    </nav>
  )
}
