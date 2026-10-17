/**
 * Chats (ADR-071, .ai/04-ui.md § Chats): every chat, stored, counted and
 * searchable apart from the work sessions — a messenger's list (owner,
 * 2026-10-16, translated: "on mobile I don't like that I have no plain
 * chats. I want just chats — stored, accessible to me").
 *
 * Newest first; a row is the chat's title (the user's name for it, else its
 * first message), when it was last active, the model, and what it is doing
 * now. **New chat** starts one at once on the remembered vendor and model;
 * the chip beside it changes that. Search reads every message the user
 * typed. A row's ⋯ ends a live chat (or says why it cannot be ended here;
 * a swipe left opens the same End — components/PhoneEnd), renames, archives
 * (hides it from this list, deleting nothing) or deletes it for good after a
 * second, explicit tap. An ended chat stays listed, *ended*, and can be
 * continued. Archived chats are one link away.
 *
 * **Import** (on the machine, ADR-074) files the conversations of a Claude.ai
 * or ChatGPT export the user downloaded as read-only chats, marked with the
 * service's mark and name. The file is read on this computer; nothing is sent.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, errText, isPairedDevice, type SessionSummary } from '@/lib/api'
import { chatModelLabel, chatTitle, importSummary, startChat } from '@/lib/chats'
import { fmtAgo } from '@/lib/format'
import { href, navigate } from '@/lib/router'
import { useApi } from '@/lib/useApi'
import { useCanControl } from '@/lib/useCanControl'
import { useNarrowScreen } from '@/lib/phone'
import { useNow } from '@/lib/useNow'
import { ModelChip, useChatChoice } from '@/components/ChatStart'
import { AgentGlyph } from '@/components/AgentMarks'
import { ChatIcon, PlusIcon, SearchIcon } from '@/components/AppIcons'
import { EndableRow, ROW_MENU_BASE, ROW_MENU_ITEM as MENU_ITEM, useEndedHere } from '@/components/PhoneEnd'

/** How many chats one page lists; the count says how many there are. */
const PAGE = 100

function dot(s: SessionSummary): string {
  if (s.status === 'ended') return 'bg-fg-faint/50'
  const h = s.activity?.health
  if (h === 'working') return 'bg-ok animate-pulse'
  if (h === 'waiting-on-you') return 'bg-warn'
  if (h === 'looping' || h === 'error') return 'bg-danger'
  return 'bg-ok/70'
}

/** What a chat is doing, when it is doing something: open and idle says nothing. */
function stateWord(s: SessionSummary): string {
  if (s.status === 'ended') return 'ended'
  const h = s.activity?.health
  return h === 'working' ? 'answering…' : h === 'waiting-on-you' ? 'waiting for you' : ''
}

/** Starts a chat at once and opens it; the error for the caller to show. */
export function useNewChat() {
  const chat = useChatChoice()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const start = async (prompt = '') => {
    setBusy(true)
    setError('')
    try {
      const id = await startChat(chat.choice, prompt)
      navigate({ name: 'chat', id })
      return true
    } catch (e) {
      setError(errText(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { chat, busy, error, start }
}

export function ChatsScreen({ archived = false }: { archived?: boolean }) {
  const phone = useNarrowScreen()
  const canControl = useCanControl()
  const now = useNow(15000)
  const [query, setQuery] = useState('')
  const [q, setQ] = useState('')
  // Searching asks the daemon a moment after the typing stops.
  useEffect(() => {
    const t = window.setTimeout(() => setQ(query), 250)
    return () => window.clearTimeout(t)
  }, [query])
  const list = useApi(() => api.chats({ q, archived, limit: PAGE }), [q, archived], { intervalMs: 5000, cache: q ? undefined : `chats:${archived ? 'archived' : 'open'}` })
  const [gone, setGone] = useState<string[]>([])
  const endedHere = useEndedHere()
  const items = (list.data?.items ?? []).filter((s) => !gone.includes(s.session_id)).map(endedHere.view)
  const fresh = useNewChat()
  const counts = list.data

  const header = (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h1 className={`${phone ? 'text-[24px]' : 'text-[20px]'} font-semibold tracking-tight`}>
        {archived ? 'Archived chats' : 'Chats'}
        {counts && <span className="ml-2 align-middle text-[14px] font-normal text-fg-faint num" aria-label={`${archived ? counts.archived : counts.chats} chats`}>{archived ? counts.archived : counts.chats}</span>}
      </h1>
      <span className="ml-auto text-[13px]">
        {archived
          ? <a href={href({ name: 'chats' })} className="text-accent">← All chats</a>
          : counts && counts.archived > 0 && <a href={href({ name: 'chats', archived: true })} className="text-fg-muted hover:text-fg">Archived · {counts.archived}</a>}
      </span>
    </div>
  )

  const search = (
    <label className="flex min-h-11 items-center gap-2 rounded-[12px] border border-border-strong bg-bg px-3 text-fg-muted focus-within:border-accent">
      <SearchIcon size={16} />
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search chats"
        aria-label="Search chats"
        className="min-w-0 flex-1 bg-transparent text-[16px] text-fg outline-none placeholder:text-fg-faint"
      />
    </label>
  )

  const starter = canControl && !archived && (
    <div className={phone ? 'fixed inset-x-0 bottom-0 z-30 border-t border-border bg-panel/95 px-3 pt-2.5 pb-[max(10px,env(safe-area-inset-bottom))] backdrop-blur' : 'flex items-center gap-2'}>
      {fresh.error && <p role="alert" className="mb-1.5 text-[13px] text-danger">{fresh.error}</p>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={fresh.busy}
          onClick={() => void fresh.start()}
          className={`inline-flex items-center justify-center gap-2 rounded-[12px] bg-accent font-semibold text-bg disabled:opacity-60 ${phone ? 'min-h-12 flex-1 text-[17px]' : 'h-9 px-4 text-[14px]'}`}
        >
          <PlusIcon size={phone ? 18 : 14} /> {fresh.busy ? 'Starting…' : 'New chat'}
        </button>
        <ModelChip chat={fresh.chat} big={phone} />
      </div>
    </div>
  )

  return (
    <div className={`mx-auto grid w-full max-w-[760px] gap-3 ${phone && starter ? 'pb-[96px]' : ''}`}>
      {header}
      {!phone && starter}
      {!archived && !isPairedDevice() && <ImportChats onDone={list.refresh} />}
      {search}
      {list.error && !list.data && <p role="alert" className="text-[14px] text-danger">{errText(list.error)}</p>}
      {!list.data && !list.error ? (
        <div className="rounded-[12px] border border-border bg-panel px-3 py-4 text-[14px] text-fg-muted">Reading your chats…</div>
      ) : items.length === 0 ? (
        <div className="grid justify-items-center gap-2 rounded-[12px] border border-border bg-panel px-4 py-8 text-center">
          <ChatIcon size={22} className="text-fg-faint" />
          <p className="text-[15px] text-fg">{q ? 'No chat matches that.' : archived ? 'No archived chats.' : 'No chats yet.'}</p>
          {!q && !archived && <p className="max-w-[40ch] text-[13.5px] text-fg-muted">A chat is a conversation with an agent that needs no project: ask, look something up, have it write a page or a report. They are kept here.</p>}
        </div>
      ) : (
        <ul aria-label="Chats" className="overflow-hidden rounded-[12px] border border-border bg-panel">
          {items.map((s) => (
            <ChatRow key={s.session_id} s={s} now={now} canControl={canControl} onGone={() => setGone((g) => [...g, s.session_id])} onChanged={list.refresh} onEnded={() => { endedHere.mark(s.session_id); list.refresh() }} />
          ))}
        </ul>
      )}
      {counts && counts.total > items.length + gone.length && (
        <p className="text-center text-[12.5px] text-fg-faint">Showing the newest {items.length} of {counts.total}. Search to find an older one.</p>
      )}
      {phone && starter}
    </div>
  )
}

function ChatRow({ s, now, canControl, onGone, onChanged, onEnded }: { s: SessionSummary; now: number; canControl: boolean; onGone: () => void; onChanged: () => void; onEnded: () => void }) {
  const [renaming, setRenaming] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState('')
  const title = chatTitle(s)
  const when = s.worked_at || s.last_event_at
  const word = stateWord(s)
  const act = async (fn: () => Promise<unknown>, after: () => void) => {
    setError('')
    try { await fn(); after() } catch (e) { setError(errText(e)) }
  }
  const sub = useMemo(() => [chatModelLabel(s), word].filter(Boolean).join(' · '), [s, word])

  if (renaming) {
    return (
      <li className="border-b border-border px-3 py-2 last:border-b-0">
        <RenameField initial={s.name ?? ''} placeholder={title} onDone={(name) => {
          setRenaming(false)
          if (name !== null) void act(() => api.renameSession(s.session_id, name), onChanged)
        }} />
      </li>
    )
  }
  // End comes first in the ⋯ (components/PhoneEnd): for a live chat Caprock
  // holds, or the line that says why not. An ended chat stays listed and can
  // be continued.
  const items = canControl ? (close: () => void) => (
    <>
      <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => { close(); setRenaming(true) }}>Rename</button>
      <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => { close(); void act(() => api.archiveChat(s.session_id, !s.archived_at), onGone) }}>
        {s.archived_at ? 'Move back to Chats' : 'Archive'}
      </button>
      {!confirm ? (
        <button type="button" role="menuitem" className={`${ROW_MENU_BASE} text-danger`} onClick={() => setConfirm(true)}>Delete…</button>
      ) : (
        <button type="button" role="menuitem" className={`${ROW_MENU_BASE} font-semibold text-danger`} onClick={() => { close(); void act(() => api.deleteChat(s.session_id), onGone) }}>
          Delete for good — and its files
        </button>
      )}
    </>
  ) : undefined
  return (
    <EndableRow
      s={s}
      title={title}
      canControl={canControl}
      onEnded={onEnded}
      items={items}
      onMenu={() => setConfirm(false)}
      after={error && <p role="alert" className="px-3 pb-2 text-[13px] text-danger">{error}</p>}
    >
      <a href={href({ name: 'chat', id: s.session_id })} className="flex min-h-[64px] min-w-0 items-center gap-3 px-3 py-2 text-fg no-underline hover:no-underline active:bg-panel-2">
        <span className="relative grid h-10 w-10 shrink-0 place-items-center rounded-full bg-panel-2 text-fg-muted">
          <AgentGlyph agent={s.agent} size={16} />
          <span className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full ring-2 ring-panel ${dot(s)}`} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[15.5px] font-medium">{title}</span>
            <span className="ml-auto shrink-0 text-[12px] text-fg-faint">{fmtAgo(when, now)}</span>
          </span>
          <span className="block truncate text-[13px] text-fg-muted">{sub}</span>
        </span>
      </a>
    </EndableRow>
  )
}

/**
 * Import chats from an export (ADR-074). Neither Claude.ai nor ChatGPT lets
 * another program read an account's conversations, so the user asks the
 * service for their data and opens the archive it emails them here. Read on
 * this computer, nothing sent; importing the same export again adds only what
 * is new. On the machine only: an export holds every conversation of an
 * account, and the daemon refuses a paired device.
 */
export function ImportChats({ onDone }: { onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [help, setHelp] = useState(false)
  const pick = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setNote('')
    setError('')
    try {
      setNote(importSummary(await api.importChats(file)))
      onDone()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }
  return (
    <div className="grid gap-1.5 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => input.current?.click()}
          className="inline-flex h-8 items-center rounded-[10px] border border-border-strong bg-bg px-3 text-[13.5px] text-fg hover:border-accent disabled:opacity-60"
        >
          {busy ? 'Importing…' : 'Import from Claude.ai or ChatGPT…'}
        </button>
        <button type="button" aria-expanded={help} onClick={() => setHelp((h) => !h)} className="text-fg-muted hover:text-fg">
          How do I get the file?
        </button>
        <input
          ref={input}
          type="file"
          accept=".zip,.json,application/zip,application/json"
          aria-label="Export file"
          className="hidden"
          onChange={(e) => void pick(e.target.files?.[0])}
        />
      </div>
      {help && (
        <ul className="grid list-disc gap-1 pl-5 text-fg-muted">
          <li><b className="font-medium text-fg">Claude.ai:</b> Settings → Privacy → Export data. The link arrives by email.</li>
          <li><b className="font-medium text-fg">ChatGPT:</b> Settings → Data controls → Export data. The link arrives by email.</li>
          <li>Choose the .zip they send, or the conversations.json inside it. It is read on this computer and nothing is sent anywhere. The chats are a copy you can read and search here; they are carried on in Claude.ai or ChatGPT. Importing a newer export adds only what is new.</li>
        </ul>
      )}
      {note && <p role="status" className="text-fg-muted">{note}</p>}
      {error && <p role="alert" className="text-danger">{error}</p>}
    </div>
  )
}

/** A one-line name field: Enter keeps it, Esc leaves it; '' clears the name. */
export function RenameField({ initial, placeholder, onDone }: { initial: string; placeholder: string; onDone: (name: string | null) => void }) {
  const [v, setV] = useState(initial)
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => { field.current?.focus(); field.current?.select() }, [])
  return (
    <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); onDone(v.trim()) }}>
      <input
        ref={field}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onDone(null) } }}
        placeholder={placeholder}
        aria-label="Chat name"
        maxLength={120}
        className="min-h-10 min-w-0 flex-1 rounded-[10px] border border-accent bg-bg px-3 text-[16px] text-fg outline-none"
      />
      <button type="submit" className="min-h-10 shrink-0 rounded-[10px] bg-accent px-3 text-[14px] font-semibold text-bg">Save</button>
      <button type="button" onClick={() => onDone(null)} className="min-h-10 shrink-0 px-2 text-[14px] text-fg-muted">Cancel</button>
    </form>
  )
}
