/**
 * Settings → Terminal → Quick replies: the one-click replies under a session
 * Caprock started (lib/quickReplies.ts). Add, remove, reorder, rename; each
 * change is saved to the daemon at once (a text when its field loses focus),
 * so the app, a browser tab and a paired phone show the same row. A row with
 * an empty label or text waits here until it is filled in.
 */
import { useEffect, useRef, useState } from 'react'
import { errText } from '@/lib/api'
import { QUICK_LABEL_MAX, QUICK_MAX, QUICK_TEXT_MAX, saveQuickReplies, useQuickReplies, type QuickReply } from '@/lib/quickReplies'

const complete = (q: QuickReply) => q.label.trim() !== '' && q.text.trim() !== ''

export function QuickRepliesSetting() {
  const stored = useQuickReplies()
  const [draft, setDraft] = useState<QuickReply[] | null>(null)
  const [error, setError] = useState('')
  const loaded = useRef(false)
  // The first answer seeds the form; after that the form is the source.
  useEffect(() => {
    if (loaded.current || stored.length === 0) return
    loaded.current = true
    setDraft(stored)
  }, [stored])
  const rows = draft ?? stored

  const commit = async (next: QuickReply[]) => {
    setDraft(next)
    setError('')
    try {
      await saveQuickReplies(next.filter(complete).map((q) => ({ label: q.label.trim(), text: q.text.trim() })))
    } catch (e) {
      setError(`Not saved: ${errText(e)}`)
    }
  }
  const edit = (i: number, patch: Partial<QuickReply>) => setDraft(rows.map((q, j) => (j === i ? { ...q, ...patch } : q)))
  const move = (i: number, by: -1 | 1) => {
    const j = i + by
    if (j < 0 || j >= rows.length) return
    const next = rows.slice()
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    void commit(next)
  }

  return (
    <div data-quick-replies-setting className="grid gap-2">
      <div>
        <span className="block text-[14.5px] text-fg">Quick replies</span>
        <span data-help className="block text-[12.5px] leading-relaxed text-fg-muted">
          One click under an agent Caprock started sends the text, as the composer would — at once when the agent is at its
          prompt, after its turn otherwise. Never in a session Caprock only watches. Saved in Caprock, for every window and
          your phone.
        </span>
      </div>
      <ol className="grid gap-1.5">
        {rows.map((q, i) => (
          <li key={i} data-quick-row={i} className="grid grid-cols-[minmax(84px,120px)_minmax(0,1fr)_auto] items-center gap-1.5">
            <input
              aria-label={`Reply ${i + 1}: label`}
              className="input text-[13px]"
              value={q.label}
              maxLength={QUICK_LABEL_MAX}
              placeholder="Label"
              onChange={(e) => edit(i, { label: e.target.value })}
              onBlur={() => void commit(rows)}
            />
            <input
              aria-label={`Reply ${i + 1}: text`}
              className="input text-[13px]"
              value={q.text}
              maxLength={QUICK_TEXT_MAX}
              placeholder="What it sends"
              onChange={(e) => edit(i, { text: e.target.value })}
              onBlur={() => void commit(rows)}
            />
            <span className="flex items-center">
              <IconButton label={`Move ${q.label || 'reply'} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</IconButton>
              <IconButton label={`Move ${q.label || 'reply'} down`} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>↓</IconButton>
              <IconButton label={`Remove ${q.label || 'reply'}`} onClick={() => void commit(rows.filter((_, j) => j !== i))}>×</IconButton>
            </span>
          </li>
        ))}
      </ol>
      {/* Controls, not an explanation: kept when the section's help is folded. */}
      <p data-keep className="flex flex-wrap items-center gap-x-3 text-[12px] text-fg-muted">
        <button type="button" disabled={rows.length >= QUICK_MAX} onClick={() => setDraft([...rows, { label: '', text: '' }])}
          className="text-accent underline-offset-2 hover:underline disabled:opacity-50">
          Add a reply
        </button>
        {rows.length === 0 && <span>No replies: the row is not drawn.</span>}
        {rows.length >= QUICK_MAX && <span>{QUICK_MAX} at most.</span>}
      </p>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </div>
  )
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}
      className="flex h-[26px] w-[26px] items-center justify-center rounded-[6px] text-[13px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg disabled:opacity-30">
      {children}
    </button>
  )
}
