/**
 * The sidebar's *Recently closed* (owner, 2026-10-20): the last tabs closed,
 * newest first, at most five, each its title and a quiet age ("2 min",
 * "1 h"). A click brings the conversation back in a tab — its own tab again
 * while its process runs, continued with --resume once it ended — as ⇧⌘T
 * does for the newest (lib/recentlyClosed.ts). The last row opens History,
 * where every session is. Nothing is drawn while the list is empty.
 *
 * Folded to one line by default — "› Recently closed  N" — and unfolded by
 * a click on it (owner and a designer, 2026-11-05, translated: "Recently
 * closed should fold"; mockup V1). The viewer's choice is kept in this
 * browser (`RECENTLY_CLOSED_OPEN_KEY`). ⇧⌘T reopens the newest either way.
 */
import { useState } from 'react'
import { closedAgo, type ClosedTab } from '@/lib/recentlyClosed'
import { keys, REOPEN_TAB_KEY } from '@/lib/appkeys'
import { isMacPlatform } from '@/lib/appmode'

/** `open` when unfolded by hand; absent or anything else, folded to its one line. */
export const RECENTLY_CLOSED_OPEN_KEY = 'caprock.app.recently-closed-open'

function loadOpen(): boolean {
  try { return localStorage.getItem(RECENTLY_CLOSED_OPEN_KEY) === 'open' } catch { return false }
}

function saveOpen(open: boolean) {
  try { localStorage.setItem(RECENTLY_CLOSED_OPEN_KEY, open ? 'open' : 'closed') } catch { /* private window: for this page only */ }
}

export function RecentlyClosed({ items, now, flat, onReopen, onShowAll }: {
  items: readonly ClosedTab[]
  now: number
  /** The Flat list's left edge; under Tree the rows sit in from the chevron, as More… does. */
  flat: boolean
  onReopen: (entry: ClosedTab) => void
  /** Opens History; absent, no last row. */
  onShowAll?: () => void
}) {
  const [open, setOpen] = useState(loadOpen)
  if (items.length === 0) return null
  const pad = flat ? 'pl-[10px]' : 'pl-[22px]'
  const toggle = () => { setOpen(!open); saveOpen(!open) }
  return (
    <section data-recently-closed aria-label="Recently closed" className="pb-1">
      <button
        type="button"
        data-nav-row
        data-closed-toggle
        aria-expanded={open}
        title={open ? 'Fold Recently closed to one line' : `Show the ${items.length} tabs closed last. ${keys(REOPEN_TAB_KEY)} reopens the newest.`}
        onClick={toggle}
        className="mt-1 flex h-[28px] w-full min-w-0 items-center gap-1.5 rounded-[6px] pl-[6px] pr-2 text-left text-[12.5px] text-fg-faint hover:bg-[var(--app-row-hover)] hover:text-fg-muted"
      >
        <svg width="11" height="11" viewBox="0 0 10 10" aria-hidden className={`shrink-0 transition-transform duration-100 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}>
          <path d="M3.5 2 7 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="min-w-0 flex-1 truncate">Recently closed</span>
        <span data-closed-count className="num shrink-0 text-[11.5px]">{items.length}</span>
      </button>
      {open && (
      <ul className="grid grid-cols-1">
        {items.map((e, i) => {
          const ago = closedAgo(e.closedAt, now)
          const hint = i === 0 ? ` (${keys(REOPEN_TAB_KEY)})` : ''
          return (
            <li key={e.sessionId}>
              <button
                type="button"
                data-nav-row
                data-closed-row={e.sessionId}
                aria-keyshortcuts={i === 0 ? (isMacPlatform() ? 'Shift+Meta+T' : 'Control+Alt+Shift+T') : undefined}
                title={`${e.title}: closed ${ago === 'now' ? 'just now' : `${ago} ago`}. Reopen it in a tab${hint}`}
                onClick={() => onReopen(e)}
                className={`app-row flex h-[28px] w-full min-w-0 items-center gap-2 rounded-[7px] ${pad} pr-2 text-left`}
              >
                <span data-closed-title className="min-w-0 flex-1 truncate text-[13px] text-fg-muted">{e.title}</span>
                <span data-closed-ago className="mono shrink-0 text-[11px] text-fg-faint">{ago}</span>
              </button>
            </li>
          )
        })}
        {onShowAll && (
          <li>
            <button
              type="button"
              data-nav-row
              data-closed-all
              onClick={onShowAll}
              className={`flex h-[26px] w-full items-center rounded-[6px] ${pad} pr-2 text-left text-[12px] text-fg-faint hover:bg-[var(--app-row-hover)] hover:text-fg-muted`}
            >
              Show all in History
            </button>
          </li>
        )}
      </ul>
      )}
    </section>
  )
}
