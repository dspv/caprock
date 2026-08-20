/**
 * Notes — search everything Claude has ever told you, across every session.
 *
 * The question people actually have is "which session was it where Claude
 * explained the SSO thing?", not "show me session 17". Without this the answer
 * lived in terminal scrollback, so people kept a notepad beside the terminal or
 * re-derived the same conclusion in a fresh session.
 *
 * Everything stays on the machine: this searches the local SQLite file.
 */
import { useState } from 'react'
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { useNow } from '@/screens/Now'
import { NoteCard } from '@/components/Notes'
import { Empty, Skeleton } from '@/components/ui'

export function NotesScreen() {
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const now = useNow(30000)
  const [includeShort, setIncludeShort] = useState(false)
  const q = useApi(() => api.searchNotes(query, query ? 100 : 500), [query], { live: false, intervalMs: 0 })
  const all = q.data ?? []
  // Default to the substantive answers. Browsing without a query, most rows are
  // one-line asides ("Let me check that") — they bury the conclusions this
  // screen exists to surface. A search is different: then the user asked for
  // those words, so nothing is filtered away.
  const notes = includeShort || query ? all : all.filter((n) => !n.fragment)
  const hidden = all.length - notes.length

  return (
    <div className="grid gap-3">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          setQuery(input.trim())
        }}
      >
        <input
          className="input max-w-[520px]"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search what Claude told you — a name, an error, a decision…"
          aria-label="Search Claude's answers"
        />
        <button
          type="submit"
          className="text-[12px] border border-accent/50 text-accent bg-accent/10 px-2 py-1 rounded-sm hover:bg-accent/20"
        >
          search
        </button>
        {query && (
          <button
            type="button"
            className="text-[11px] text-fg-muted hover:text-fg border border-border px-1.5 py-1 rounded-sm"
            onClick={() => { setInput(''); setQuery('') }}
          >
            clear
          </button>
        )}
        {hidden > 0 && (
          <button
            type="button"
            className="text-[11px] text-fg-muted hover:text-fg border border-border px-1.5 py-1 rounded-sm"
            onClick={() => setIncludeShort((v) => !v)}
          >
            {includeShort ? 'hide short remarks' : `+${hidden} short remarks`}
          </button>
        )}
        <span className="ml-auto text-[11px] text-fg-faint">
          Claude&apos;s written answers, across every session. Local only.
        </span>
      </form>

      {q.error && !q.data && <Empty title="Cannot search">{q.error.message}</Empty>}

      {!q.data && !q.error && <Skeleton rows={5} className="border border-border rounded-[var(--radius-panel)] bg-panel" />}

      {q.data && notes.length === 0 && (
        <Empty title={query ? `Nothing found for "${query}"` : 'No answers captured yet'}>
          {query
            ? 'Try a shorter phrase — this matches the words Claude wrote, not what you asked.'
            : 'Run a session and Claude’s written answers will be searchable here.'}
        </Empty>
      )}

      {notes.length > 0 && (
        <>
          <div className="text-[11px] text-fg-faint px-0.5">
            {notes.length} {notes.length === 1 ? 'answer' : 'answers'}
            {query ? ` matching "${query}"` : ' · most recent'} · subagent chatter excluded
          </div>
          <div className="grid gap-2">
            {notes.map((n) => (
              <NoteCard key={n.event_id} note={n} now={now} showSession />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
