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
import { useEffect, useState, type RefObject, type SyntheticEvent } from 'react'
import { SectionIcon } from './SettingsIcons'
import { Marked, NothingMatches, SettingsSearchField, type SettingsSearchState } from './SettingsSearch'

/**
 * A row's full name as its tooltip, only while the menu cuts it: one on every
 * row covered the row above it while it said nothing new (owner, 2026-10-17).
 * Asked of the row as the pointer or the focus arrives, not guessed from the
 * title's length: twenty-six characters was the guess, and "Saved prompts
 * and commands", exactly that long, was cut with no tooltip; a scrollbar that
 * takes room (Windows, Linux) cuts sooner still.
 */
function titleIfCut(e: SyntheticEvent<HTMLElement>, title: string) {
  const row = e.currentTarget
  const label = row.querySelector<HTMLElement>('[data-settings-nav-label]')
  const cut = !!label && label.scrollWidth > label.clientWidth
  if (cut) row.title = title
  else row.removeAttribute('title')
}

interface Item { id: string; title: string }

/** Where the Settings page starts under the sticky header, and how tall the box it scrolls in is. */
export interface SettingsFrame {
  /** The header's height plus a 16px gap; 16 with no header drawn. */
  top: number
  /** The scrolling box's height; absent where the window itself scrolls (a browser). */
  room?: number
}

/**
 * The box the page scrolls in, if it is not the window: the app's dashboard
 * view. The nearest ancestor whose overflow is not `visible`, which is the
 * box `position: sticky` holds the header and the menu to.
 */
function scrollBox(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    // '' is jsdom's answer for a box with no overflow set.
    if (!/^(|visible|clip)$/.test(getComputedStyle(p).overflowY)) return p
  }
  return null
}

/**
 * The dashboard's sticky header, measured: the menu is held below it (at
 * top-4 the search field slid under it once the page scrolled), and a section
 * scrolled to lands below it. The header is not one fixed row: in the app,
 * under about 1440px, its screens and its buttons wrap to two and three rows
 * (68, 96, 124px), and a section brought into view by the menu or by
 * #/settings/phone had its heading under them (2026-11-20). In the app the
 * page scrolls in a box shorter than the window (the tab strip above, the
 * status strip below), so the menu's height is counted from that box: counted
 * from the window, its last rows were under the status strip, out of reach.
 */
export function useSettingsFrame(): SettingsFrame {
  const [frame, setFrame] = useState<SettingsFrame>({ top: 16 })
  useEffect(() => {
    const h = document.querySelector<HTMLElement>('[data-shell-header]')
    if (!h || typeof ResizeObserver !== 'function') return
    const box = scrollBox(h)
    const on = () => {
      const top = (h.getClientRects().length > 0 ? h.offsetHeight : 0) + 16
      const room = box ? box.clientHeight : undefined
      setFrame((f) => (f.top === top && f.room === room ? f : { top, room }))
    }
    on()
    const ro = new ResizeObserver(on)
    ro.observe(h)
    if (box) ro.observe(box)
    return () => ro.disconnect()
  }, [])
  return frame
}

/** A section's scroll margin under the header: never less than the 64px it was. */
export function sectionScrollMargin(f: SettingsFrame): number {
  return Math.max(64, f.top)
}

export function SettingsNav({ root, search, frame }: { root: RefObject<HTMLElement | null>; search: SettingsSearchState; frame: SettingsFrame }) {
  const [items, setItems] = useState<Item[]>([])
  const [active, setActive] = useState('')
  const { top, room } = frame
  const maxHeight = room === undefined ? `calc(100vh - ${top + 24}px)` : `${Math.max(120, room - top - 24)}px`

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
    // In view means below the sticky header: the tail of the section above,
    // which the header covers, counted as in view, so a click on a row
    // scrolled to its section and then marked the one before it. The band
    // ends 60% up from the bottom, or lower where a short window and a
    // wrapped header would leave no band at all.
    const box = scrollBox(el)
    const h = box ? box.clientHeight : window.innerHeight
    const bottom = h * 0.4 - top >= 120 ? '-60%' : `-${Math.max(0, Math.round(h - top - 120))}px`
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set(e.target.id, e.isIntersecting)
      const first = items.find((i) => seen.get(i.id))
      if (first) setActive(first.id)
    }, { root: box, rootMargin: `-${top}px 0px ${bottom} 0px` })
    for (const i of items) {
      const s = document.getElementById(i.id)
      if (s) io.observe(s)
    }
    return () => io.disconnect()
  }, [items, root, top, room])

  if (items.length < 4) return null
  const q = search.query.trim()
  // The lists are one column that may shrink (`grid-cols-1`, minmax(0, 1fr)):
  // a bare `grid` sizes its column to the longest title, so every row grew
  // past the menu and the titles were cut at its edge mid-letter, with no
  // ellipsis (seen in Chromium, the Windows app's engine, 2026-11-20).
  return (
    <nav aria-label="Settings sections" style={{ top, maxHeight }} className="sticky hidden w-[224px] shrink-0 self-start overflow-y-auto xl:block">
      <SettingsSearchField search={search} className="mb-2" />
      {q && search.matches.length === 0 && <NothingMatches query={q} className="px-3 py-1.5" />}
      {q ? (
        <ul className="grid grid-cols-1 gap-0.5" data-settings-results="">
          {search.matches.map((m) => (
            <li key={m.id}>
              <button type="button"
                onPointerEnter={(e) => titleIfCut(e, m.title)} onFocus={(e) => titleIfCut(e, m.title)}
                onClick={() => search.jump(m)}
                className="grid w-full grid-cols-1 gap-0.5 rounded-[7px] px-3 py-1.5 text-left text-[13.5px] text-fg hover:bg-[var(--app-row-hover,var(--color-panel-2))]">
                <span className="flex min-w-0 items-center gap-2">
                  <SectionIcon title={m.title} size={14} />
                  <span data-settings-nav-label="" className="min-w-0 truncate"><Marked text={m.title} query={q} /></span>
                </span>
                {m.hit && <span className="min-w-0 truncate pl-[22px] text-[12px] text-fg-muted"><Marked text={m.hit} query={q} /></span>}
              </button>
            </li>
          ))}
        </ul>
      ) : (
      <ul className="grid grid-cols-1 gap-0.5">
        {items.map((i) => (
          <li key={i.id}>
            <button type="button" aria-current={active === i.id ? 'true' : undefined}
              onPointerEnter={(e) => titleIfCut(e, i.title)} onFocus={(e) => titleIfCut(e, i.title)}
              onClick={() => { document.getElementById(i.id)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); setActive(i.id) }}
              className={`flex w-full items-center gap-2 truncate rounded-[7px] px-3 py-1.5 text-left text-[13.5px] ${active === i.id ? 'bg-[var(--app-row-active,var(--color-panel-2))] font-medium text-fg' : 'text-fg-muted hover:bg-[var(--app-row-hover,var(--color-panel-2))] hover:text-fg'}`}>
              <SectionIcon title={i.title} size={14} />
              <span data-settings-nav-label="" className="min-w-0 truncate">{i.title}</span>
            </button>
          </li>
        ))}
      </ul>
      )}
    </nav>
  )
}
