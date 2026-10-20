/**
 * The sidebar's *Recently closed* (owner, 2026-10-20): the last tabs closed,
 * newest first, at most five, each its title and a quiet age ("2 min",
 * "1 h"). A click brings the conversation back in a tab — its own tab again
 * while its process runs, continued with --resume once it ended — as ⇧⌘T
 * does for the newest (lib/recentlyClosed.ts). The last row opens History,
 * where every session is. Nothing is drawn while the list is empty.
 */
import { closedAgo, type ClosedTab } from '@/lib/recentlyClosed'
import { keys, REOPEN_TAB_KEY } from '@/lib/appkeys'
import { isMacPlatform } from '@/lib/appmode'

export function RecentlyClosed({ items, now, flat, onReopen, onShowAll }: {
  items: readonly ClosedTab[]
  now: number
  /** The Flat list's left edge; under Tree the rows sit in from the chevron, as More… does. */
  flat: boolean
  onReopen: (entry: ClosedTab) => void
  /** Opens History; absent, no last row. */
  onShowAll?: () => void
}) {
  if (items.length === 0) return null
  const pad = flat ? 'pl-[10px]' : 'pl-[22px]'
  return (
    <section data-recently-closed aria-label="Recently closed" className="pb-1">
      <h3 className={`${pad} pb-0.5 pr-2 pt-2.5 text-[10.5px] font-medium uppercase tracking-[0.06em] text-fg-faint`}>Recently closed</h3>
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
    </section>
  )
}
