/**
 * The Inbox on the Mac (03-contracts.md § Inbox): what was saved from the
 * phone — a note, a link, a photo — listed in the Quick chat chooser, newest
 * first, each with **Start a chat** (a quick chat on the agent picked above,
 * the item as its first message, in the item's project when it has one) and
 * **Delete** (two clicks: it takes the photos with it). Nothing is drawn while
 * the Inbox is empty, so the chooser looks as it always did.
 *
 * In the chooser rather than a sidebar item of its own (the sidebar keeps its
 * rows, owner 2026-10-09): starting a chat is what an item is for, and this is
 * where a chat is started. The item stays after its chat starts; deleting is
 * the user's call (lib/inbox).
 */
import { useEffect, useState } from 'react'
import { fmtAgo } from '@/lib/format'
import { inboxStart, inboxWhere, isInboxImage, useInbox, useInboxThumb, type InboxItem } from '@/lib/inbox'
import { useCanControl } from '@/lib/useCanControl'
import { ChatIcon, InboxIcon, TrashIcon } from './AppIcons'

/** How many rows show before "Show all". */
const FIRST = 5

export function InboxList({ onStart }: { onStart: (more: { prompt: string; cwd?: string }) => void }) {
  const inbox = useInbox()
  const canChange = useCanControl()
  const [all, setAll] = useState(false)
  const [error, setError] = useState('')
  if (inbox.items.length === 0) return null
  const shown = all ? inbox.items : inbox.items.slice(0, FIRST)
  const now = Date.now()
  return (
    <section aria-label="Saved" className="grid gap-1.5 border-t border-[var(--app-hairline)] px-5 pb-4 pt-3">
      <div className="flex items-baseline gap-2 text-[12px] text-fg-faint">
        <span className="font-medium uppercase tracking-[0.08em]">Saved</span>
        <span className="num">{inbox.items.length}</span>
        <span className="truncate">· from your phone and here</span>
      </div>
      <ul className="grid gap-0.5">
        {shown.map((item) => (
          <InboxRow
            key={item.id}
            item={item}
            now={now}
            canChange={canChange}
            onStart={() => onStart(inboxStart(item))}
            onDelete={() => { setError(''); inbox.remove(item.id).catch((e: unknown) => setError(`Could not delete it: ${e instanceof Error ? e.message : String(e)}`)) }}
          />
        ))}
      </ul>
      {inbox.items.length > FIRST && (
        <button type="button" onClick={() => setAll((v) => !v)} className="w-fit text-[12px] text-fg-muted hover:text-fg">
          {all ? 'Show fewer' : `Show all ${inbox.items.length}`}
        </button>
      )}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </section>
  )
}

function InboxRow({ item, now, canChange, onStart, onDelete }: { item: InboxItem; now: number; canChange: boolean; onStart: () => void; onDelete: () => void }) {
  const [confirm, setConfirm] = useState(false)
  // The second click must follow the first; a stray one later starts over.
  useEffect(() => {
    if (!confirm) return
    const t = window.setTimeout(() => setConfirm(false), 4000)
    return () => window.clearTimeout(t)
  }, [confirm])
  const image = item.files.findIndex(isInboxImage)
  const others = item.files.length - (image >= 0 ? 1 : 0)
  const text = item.text.trim() || (item.files.length ? `${item.files.length} file${item.files.length === 1 ? '' : 's'}` : '')
  return (
    <li className="group flex items-center gap-2.5 rounded-[7px] px-1.5 py-1.5 hover:bg-[var(--app-row-hover)]">
      {image >= 0 ? <Thumb id={item.id} n={image} /> : (
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[6px] bg-panel-2 text-fg-faint"><InboxIcon size={15} /></span>
      )}
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 whitespace-pre-line break-words text-[13px] leading-[1.35] text-fg">{text}</span>
        <span className="block truncate text-[11.5px] text-fg-faint">
          {inboxWhere(item)}
          {item.from_device ? ` · ${item.from_device}` : ''}
          {others > 0 ? ` · +${others} file${others === 1 ? '' : 's'}` : ''}
          {` · ${fmtAgo(item.created_at, now)}`}
        </span>
      </span>
      {canChange && (
        <>
          <button
            type="button"
            onClick={onStart}
            title={item.project_name ? `Start a chat in ${item.project_name} from this` : 'Start a chat from this'}
            className="inline-flex h-[28px] shrink-0 items-center gap-1.5 rounded-[6px] px-2 text-[12.5px] text-fg-muted hover:bg-panel hover:text-fg"
          >
            <ChatIcon size={13} /> Start a chat
          </button>
          <button
            type="button"
            aria-label={confirm ? 'Delete it and its files' : 'Delete'}
            title={confirm ? 'Click again to delete it and its files' : 'Delete'}
            onClick={() => (confirm ? onDelete() : setConfirm(true))}
            className={`inline-flex h-[28px] shrink-0 items-center gap-1 rounded-[6px] px-1.5 text-[12px] ${confirm ? 'bg-danger/10 text-danger' : 'text-fg-faint hover:bg-panel hover:text-fg'}`}
          >
            <TrashIcon size={13} />{confirm && 'Delete?'}
          </button>
        </>
      )}
    </li>
  )
}

function Thumb({ id, n }: { id: number; n: number }) {
  const src = useInboxThumb(id, n)
  return src
    ? <img src={src} alt="" className="h-9 w-9 shrink-0 rounded-[6px] object-cover" />
    : <span aria-hidden className="h-9 w-9 shrink-0 rounded-[6px] bg-panel-2" />
}
