/**
 * The chat field's `/` and `@` pickers (ADR-053, lib/pickers.ts).
 *
 * `/` at the start of the field lists the session's slash commands — the
 * agent's own, the folder's and the user's (GET /v1/sessions/{id}/commands);
 * `@` at the start of a word lists the files of the session's folder
 * (GET /v1/sessions/{id}/files), filtered as typed. A pick only puts text in
 * the field: nothing is sent until Send.
 *
 * Keyboard: ↑ ↓ move, Enter or Tab picks, Esc closes (the field keeps what
 * was typed). Touch: 44px rows, and a tap keeps the field's focus so a
 * phone's keyboard does not drop.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOnChange } from '@/lib/useOnChange'
import { api, errText, type SlashCommand } from '@/lib/api'
import { applyPick, matchCommands, matchFiles, pickerAt, type PickerQuery } from '@/lib/pickers'

/** How long a session's lists are kept before they are read again. */
const LIST_TTL_MS = 60_000

interface Cached<T> { at: number; value: Promise<T> }
const commandCache = new Map<string, Cached<SlashCommand[]>>()
const fileCache = new Map<string, Cached<{ files: string[]; truncated: boolean }>>()

function cached<T>(cache: Map<string, Cached<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.value
  const value = load()
  cache.set(key, { at: Date.now(), value })
  value.catch(() => cache.delete(key))
  return value
}

/** Forget the cached lists (tests). */
export function resetPickerCache(): void {
  commandCache.clear()
  fileCache.clear()
}

type Row = { key: string; value: string; label: string; hint?: string; detail?: string; source?: string }

export interface ChatPickerState {
  /** Rows to draw; empty when closed. */
  rows: Row[]
  open: boolean
  kind: PickerQuery['kind'] | null
  active: number
  setActive: (n: number) => void
  /** Status under the rows: loading, nothing matches, an error. */
  note: string
  /** Handles ↑ ↓ Enter Tab Esc while open; true when the key was the picker's. */
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
  /** Call after the text or the caret moved. */
  track: (text: string, caret: number) => void
  pick: (n: number) => void
  close: () => void
}

/**
 * The picker over a field. `setText` receives the text after a pick and
 * where the caret goes.
 */
export function useChatPicker(sessionId: string | undefined, enabled: boolean, setText: (text: string, caret: number) => void): ChatPickerState {
  const [q, setQ] = useState<PickerQuery | null>(null)
  const [snapshot, setSnapshot] = useState<{ text: string; caret: number }>({ text: '', caret: 0 })
  // Esc closes the picker for the trigger it was open at; typing on keeps
  // it closed until a new trigger.
  const dismissed = useRef<number | null>(null)
  const [commands, setCommands] = useState<SlashCommand[] | null>(null)
  const [files, setFiles] = useState<{ files: string[]; truncated: boolean } | null>(null)
  const [error, setError] = useState('')
  const [active, setActive] = useState(0)

  const track = useCallback((text: string, caret: number) => {
    if (!enabled || !sessionId) return
    const next = pickerAt(text, caret)
    if (!next || next.start !== dismissed.current) dismissed.current = null
    setQ(next && dismissed.current === null ? next : null)
    setSnapshot({ text, caret })
  }, [enabled, sessionId])

  // The lists, read once the picker first opens.
  useEffect(() => {
    if (!q || !sessionId) return
    let live = true
    if (q.kind === 'slash' && commands === null) {
      cached(commandCache, sessionId, () => api.sessionCommands(sessionId).then((r) => r.commands))
        .then((c) => { if (live) { setCommands(c); setError('') } })
        .catch((e: unknown) => { if (live) setError(errText(e)) })
    }
    if (q.kind === 'file' && files === null) {
      cached(fileCache, sessionId, () => api.sessionFiles(sessionId).then((r) => ({ files: r.files, truncated: !!r.truncated })))
        .then((f) => { if (live) { setFiles(f); setError('') } })
        .catch((e: unknown) => { if (live) setError(errText(e)) })
    }
    return () => { live = false }
  }, [q, sessionId, commands, files])

  useOnChange(sessionId, () => { setCommands(null); setFiles(null); setQ(null) })

  const rows = useMemo<Row[]>(() => {
    if (!q) return []
    if (q.kind === 'slash') {
      return matchCommands(commands ?? [], q.query).map((c) => ({
        key: `c:${c.source}:${c.name}`, value: c.name, label: `/${c.name}`, hint: c.hint, detail: c.description, source: c.source === 'builtin' ? '' : c.source,
      }))
    }
    return matchFiles(files?.files ?? [], q.query).map((f) => {
      const cut = f.lastIndexOf('/') + 1
      return { key: `f:${f}`, value: f, label: f.slice(cut), detail: cut > 0 ? f.slice(0, cut - 1) : '' }
    })
  }, [q, commands, files])

  // A new query starts at the top.
  useEffect(() => { setActive(0) }, [q?.kind, q?.query, q?.start])

  const loading = !!q && (q.kind === 'slash' ? commands === null : files === null) && !error
  const open = !!q
  let note = ''
  if (q) {
    if (error) note = `Could not list ${q.kind === 'slash' ? 'commands' : 'files'}: ${error}`
    else if (loading) note = q.kind === 'slash' ? 'Reading commands…' : 'Reading files…'
    else if (rows.length === 0 && q.kind === 'slash') note = commands?.length ? `No command matches “/${q.query}”` : 'No commands for this agent'
    else if (rows.length === 0) note = files?.files.length ? `No file matches “${q.query}”` : 'No files in this folder'
    else if (q.kind === 'file' && files?.truncated) note = 'Only the first 20,000 files are searched'
  }

  const close = useCallback(() => {
    if (q) dismissed.current = q.start
    setQ(null)
  }, [q])

  const pick = useCallback((n: number) => {
    const row = rows[n]
    if (!q || !row) return
    const next = applyPick(snapshot.text, q, snapshot.caret, row.value)
    dismissed.current = null
    setQ(null)
    setText(next.text, next.caret)
  }, [q, rows, snapshot, setText])

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false
    if (e.key === 'Escape') { e.preventDefault(); close(); return true }
    if (rows.length === 0) return false
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((n) => (n + 1) % rows.length); return true }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((n) => (n - 1 + rows.length) % rows.length); return true }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); pick(active); return true }
    return false
  }, [open, rows.length, close, pick, active])

  return { rows: open ? rows : [], open, kind: q?.kind ?? null, active, setActive, note: open ? note : '', onKeyDown, track, pick, close }
}

/** The list, drawn above the field. */
export function ChatPickerList({ p, listId }: { p: ChatPickerState; listId: string }) {
  const box = useRef<HTMLUListElement>(null)
  // The active row stays in view while ↑ ↓ move through a long list.
  useEffect(() => {
    box.current?.querySelector<HTMLElement>(`[data-row="${p.active}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [p.active])
  if (!p.open) return null
  const label = p.kind === 'slash' ? 'Slash commands' : 'Files'
  return (
    <div className="absolute inset-x-0 bottom-full z-20 mb-1.5 rounded-sm border border-border-strong bg-panel shadow-[0_8px_24px_rgba(0,0,0,0.18)]" data-chat-picker={p.kind ?? ''}>
      {p.rows.length > 0 && (
        <ul ref={box} id={listId} role="listbox" aria-label={label} className="max-h-[min(264px,38vh)] overflow-y-auto overscroll-contain p-1">
          {p.rows.map((r, n) => (
            <li
              key={r.key}
              id={`${listId}-${n}`}
              data-row={n}
              role="option"
              aria-selected={n === p.active}
              // Keep the field's focus (and a phone's keyboard) where it was.
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => { if (n !== p.active) p.setActive(n) }}
              onClick={() => p.pick(n)}
              className={`flex min-h-[44px] sm:min-h-[36px] cursor-pointer items-center gap-2 rounded-[6px] px-2.5 py-1 text-[14px] sm:text-[13px] ${n === p.active ? 'bg-accent/15 text-fg' : 'text-fg'}`}
            >
              <span className="min-w-0 shrink-0 max-w-[60%] truncate mono">{r.label}</span>
              {r.hint && <span className="hidden shrink-0 truncate mono text-[12px] text-fg-faint sm:inline">{r.hint}</span>}
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-muted">{r.detail}</span>
              {r.source && <span className="shrink-0 rounded-full border border-border px-1.5 text-[10.5px] text-fg-faint">{r.source}</span>}
            </li>
          ))}
        </ul>
      )}
      {(p.note || p.rows.length > 0) && (
        <div className={`${p.note ? 'flex' : 'hidden sm:flex'} items-center gap-3 border-t border-border px-2.5 py-1 text-[11.5px] text-fg-faint first:border-t-0`}>
          <span className="min-w-0 flex-1 truncate">{p.note}</span>
          {p.rows.length > 0 && <span className="hidden shrink-0 sm:inline">↑↓ move · ↵ pick · Esc close</span>}
        </div>
      )}
    </div>
  )
}
