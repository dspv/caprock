/**
 * The Settings page's own menu (owner, 2026-10-11: "the settings need a menu"
 * — eighteen sections in one column, found by scrolling). A sticky list of the
 * sections the page drew, in its order, the one in view highlighted; a click
 * scrolls to it. Read from the page itself (`data-settings-section`), so a
 * section that is not shown here (a phone, a paired device) is not listed.
 */
import { useEffect, useState, type RefObject } from 'react'
import { SectionIcon } from './SettingsIcons'

interface Item { id: string; title: string }

export function SettingsNav({ root }: { root: RefObject<HTMLElement | null> }) {
  const [items, setItems] = useState<Item[]>([])
  const [active, setActive] = useState('')

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
  return (
    <nav aria-label="Settings sections" className="sticky top-4 hidden max-h-[calc(100vh-6rem)] w-[224px] shrink-0 self-start overflow-y-auto xl:block">
      <ul className="grid gap-0.5">
        {items.map((i) => (
          <li key={i.id}>
            <button type="button" title={i.title} aria-current={active === i.id ? 'true' : undefined}
              onClick={() => { document.getElementById(i.id)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); setActive(i.id) }}
              className={`flex w-full items-center gap-2 truncate rounded-[7px] px-3 py-1.5 text-left text-[13.5px] ${active === i.id ? 'bg-[var(--app-row-active,var(--color-panel-2))] font-medium text-fg' : 'text-fg-muted hover:bg-[var(--app-row-hover,var(--color-panel-2))] hover:text-fg'}`}>
              <SectionIcon title={i.title} size={14} />
              <span className="min-w-0 truncate">{i.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
