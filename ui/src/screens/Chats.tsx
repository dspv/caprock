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
 * typed. A row's ⋯ renames, archives (hides it from this list, deleting
 * nothing) or deletes it for good after a second, explicit tap. Archived
 * chats are one link away.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, errText, type SessionSummary } from '@/lib/api'
import { chatModelLabel, chatTitle, startChat } from '@/lib/chats'
import { fmtAgo } from '@/lib/format'
import { href, navigate } from '@/lib/router'
import { useApi } from '@/lib/useApi'
import { useCanControl } from '@/lib/useCanControl'
import { useNarrowScreen } from '@/lib/phone'
import { useNow } from '@/lib/useNow'
import { ModelChip, useChatChoice } from '@/components/ChatStart'
import { AgentGlyph } from '@/components/AgentMarks'
import { ChatIcon, MoreIcon, PlusIcon, SearchIcon } from '@/components/AppIcons'

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
  if (s.status === 'ended') return ''
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
  const items = (list.data?.items ?? []).filter((s) => !gone.includes(s.session_id))
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
            <ChatRow key={s.session_id} s={s} now={now} canControl={canControl} onGone={() => setGone((g) => [...g, s.session_id])} onChanged={list.refresh} />
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

function ChatRow({ s, now, canControl, onGone, onChanged }: { s: SessionSummary; now: number; canControl: boolean; onGone: () => void; onChanged: () => void }) {
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState('')
  const title = chatTitle(s)
  const when = s.worked_at || s.last_event_at
  const word = stateWord(s)
  const box = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (!menu) return
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) { setMenu(false); setConfirm(false) } }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [menu])
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
  return (
    <li ref={box} className="relative border-b border-border last:border-b-0">
      <div className="flex items-center">
        <a href={href({ name: 'chat', id: s.session_id })} className={`flex min-h-[64px] min-w-0 flex-1 items-center gap-3 px-3 py-2 text-fg no-underline hover:no-underline active:bg-panel-2 ${s.status === 'ended' ? '' : ''}`}>
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
        {canControl && (
          <button type="button" aria-label={`More for ${title}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => { setMenu((v) => !v); setConfirm(false) }} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-fg-faint hover:text-fg">
            <MoreIcon size={18} />
          </button>
        )}
      </div>
      {error && <p role="alert" className="px-3 pb-2 text-[13px] text-danger">{error}</p>}
      {menu && (
        <div role="menu" aria-label={`More for ${title}`} className="absolute right-2 top-[calc(100%-6px)] z-20 w-[240px] overflow-hidden rounded-[12px] border border-border-strong bg-panel py-1 shadow-[0_16px_40px_-16px_rgba(0,0,0,0.6)]">
          <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => { setMenu(false); setRenaming(true) }}>Rename</button>
          <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => { setMenu(false); void act(() => api.archiveChat(s.session_id, !s.archived_at), onGone) }}>
            {s.archived_at ? 'Move back to Chats' : 'Archive'}
          </button>
          {!confirm ? (
            <button type="button" role="menuitem" className={`${MENU_ITEM} text-danger`} onClick={() => setConfirm(true)}>Delete…</button>
          ) : (
            <button type="button" role="menuitem" className={`${MENU_ITEM} font-semibold text-danger`} onClick={() => { setMenu(false); void act(() => api.deleteChat(s.session_id), onGone) }}>
              Delete for good — and its files
            </button>
          )}
        </div>
      )}
    </li>
  )
}

const MENU_ITEM = 'flex min-h-11 w-full items-center px-4 text-left text-[15px] text-fg active:bg-panel-2 hover:bg-panel-2'

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
