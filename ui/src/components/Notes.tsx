/**
 * Notes — what Claude actually said, in its own words.
 *
 * For a large share of sessions the deliverable is not the diff but the
 * conclusion: "this is done, but I could not verify X — check with the team and
 * then we finish it." Caprock has always stored that paragraph and never showed
 * it; the timeline rendered a 200-character slice of it on one line, which is
 * how people ended up copying it into a notepad or losing it to scrollback.
 *
 * Two rules the daemon enforces in SQL, mirrored in how this reads:
 *  - subagent sidechains are excluded (about half of all assistant turns), so
 *    a subagent's words are never presented as the main thread's;
 *  - a short mid-thought aside is flagged, so an interrupted session does not
 *    look like it concluded with "Let me check that".
 */
import { useState } from 'react'
import { api, type AssistantNote } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtAgo, shortId } from '@/lib/format'
import { Empty, Skeleton } from '@/components/ui'
import { href } from '@/lib/router'
import { Prose } from './Prose'

export function SessionNotes({ id, now }: { id: string; now: number }) {
  const q = useApi(() => api.notes(id), [id], { intervalMs: 10000 })
  const notes = q.data ?? []
  // Substantive first: the point of this tab is the conclusion, and short
  // asides ("Let me check that") would otherwise bury it.
  const [showAll, setShowAll] = useState(false)
  const substantive = notes.filter((n) => !n.fragment)
  const shown = showAll ? notes : substantive

  if (q.error && !q.data) {
    return <Empty title="Cannot load notes">{q.error.message}</Empty>
  }
  if (!q.data) return <Skeleton rows={4} />
  if (notes.length === 0) {
    return (
      <Empty title="Nothing said yet">
        Claude&apos;s written answers appear here — the reasoning and the
        &ldquo;what changed, what I still need from you&rdquo; that otherwise
        lives only in your terminal scrollback.
      </Empty>
    )
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-3 text-[11px] text-fg-faint px-0.5">
        <span>
          {substantive.length} {substantive.length === 1 ? 'answer' : 'answers'}
          {notes.length > substantive.length && ` · ${notes.length - substantive.length} short remarks`}
        </span>
        {notes.length > substantive.length && (
          <button
            className="text-fg-muted hover:text-fg border border-border px-1.5 rounded-sm"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? 'hide short remarks' : 'show everything'}
          </button>
        )}
        <span className="ml-auto">subagent chatter excluded · newest first</span>
      </div>
      {shown.map((n) => (
        <NoteCard key={n.event_id} note={n} now={now} />
      ))}
    </div>
  )
}

/** How much of a long note to show before asking. */
const PREVIEW_RUNES = 600

export function NoteCard({ note, now, showSession = false }: {
  note: AssistantNote
  now: number
  /** Search results span sessions, so they need to say which one. */
  showSession?: boolean
}) {
  const [open, setOpen] = useState(false)
  const text = typeof note.text === 'string' ? note.text : ''
  const chars = [...text]
  const long = chars.length > PREVIEW_RUNES
  const body = open || !long ? text : chars.slice(0, PREVIEW_RUNES).join('') + '…'

  return (
    <div className="border border-border bg-panel rounded-[var(--radius-panel)]">
      <div className="flex items-baseline gap-2 px-3 pt-2 text-[11px] text-fg-faint">
        {/* Links to the moment, not the session. Opening a thousand-event
          * timeline at the top and leaving the reader to find the answer they
          * just clicked is the same as not linking at all — a reporter said
          * exactly that: the answers "did not feel connected to the session". */}
        {showSession && (
          <a
            href={href({ name: 'session', id: note.session_id, at: note.ts })}
            className="link"
            title="Open the session at this moment"
          >
            <span className="text-fg-muted">{note.project || shortId(note.session_id)}</span>
          </a>
        )}
        <span className="mono">{note.model || 'assistant'}</span>
        {note.fragment && <span className="text-fg-faint">· mid-thought</span>}
        <span className="num ml-auto">{fmtAgo(note.ts, now)}</span>
      </div>
      {/* Rendered, not preserved. The comment here used to say the structure
        * of a summary is most of its readability — true, and the code then
        * kept only the line breaks, so a reader got `**bold**` with its
        * asterisks and a Markdown table collapsed into `| | |`. Claude writes
        * lists, headings and tables; showing them as the markup they are made
        * of is showing the reader the wrong half. */}
      <div className="px-3 py-2 break-words">
        <Prose text={body} />
      </div>
      {long && (
        <button
          className="text-[11px] text-fg-muted hover:text-fg px-3 pb-2"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'show less' : `show all ${chars.length.toLocaleString()} characters`}
        </button>
      )}
    </div>
  )
}
