/**
 * One chat (ADR-071, .ai/04-ui.md § Chats): the conversation, never a
 * terminal, its field at the bottom as in a messenger, and the files it
 * produced one tap away.
 *
 * The bar says which chat it is (tap the title to rename it), the vendor and
 * model, and offers Files (with how many) and ⋯ (end — or why it cannot be
 * ended here — rename, archive, delete; components/PhoneEnd). An ended
 * chat can be carried on in place: the same conversation resumed in its own
 * folder, on the phone too. A chat waiting on a permission answers it here.
 */
import { useEffect, useState } from 'react'
import { OPEN_PATH_EVENT, type OpenPathDetail } from '@/lib/mdreader'
import { api, ApiError, errText, type ChatFile, type SessionDetail } from '@/lib/api'
import { chatModelLabel, chatTitle, importedFrom } from '@/lib/chats'
import { href, navigate } from '@/lib/router'
import { useApi } from '@/lib/useApi'
import { useCanControl } from '@/lib/useCanControl'
import { useFillViewport, useNarrowScreen } from '@/lib/phone'
import { useNow } from '@/lib/useNow'
import { ChatView } from '@/components/ChatView'
import { ChatFileViewer, ChatFilesSheet, useChatFiles } from '@/components/ChatFiles'
import { ChatSheet } from '@/components/ChatStart'
import { ChevronIcon, FileIcon, MoreIcon } from '@/components/AppIcons'
import { Empty } from '@/components/ui'
import { EndSheet, endState } from '@/components/PhoneEnd'
import { RenameField } from './Chats'
import { KeyGrid } from '@/components/TerminalKeys'
import { idleEndedText } from '@/lib/idleEnd'

export function ChatScreen({ id }: { id: string }) {
  const phone = useNarrowScreen()
  const canControl = useCanControl()
  const now = useNow(15000)
  const detail = useApi(() => api.session(id), [id], {
    intervalMs: 5000,
    cache: `session:${id}`,
    cacheTrim: (d) => ({ ...(d as SessionDetail), events: [], files: [] }),
  })
  const s = detail.data
  // Files are read again as the chat answers: its newest event moves.
  const { files } = useChatFiles(id, `${s?.last_event_at ?? 0}:${s?.status ?? ''}`)
  const [sheet, setSheet] = useState<null | 'files' | 'more'>(null)
  const [open, setOpen] = useState<ChatFile | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [endSheet, setEndSheet] = useState(false)
  const fill = useFillViewport<HTMLDivElement>(true, phone ? 0 : 12)
  // A file the reply names (`report.md`) opens in the viewer when it is one
  // of the chat's own files (ChatView's links, lib/mdreader).
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<OpenPathDetail>).detail
      if (!d || d.sessionId !== id || !files) return
      const cwd = (s?.cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
      const p = d.path.replace(/\\/g, '/')
      const rel = cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p.replace(/^\.\//, '')
      const hit = files.find((f) => f.path === rel) ?? files.find((f) => f.path.endsWith(`/${rel}`))
      if (hit) setOpen(hit)
    }
    window.addEventListener(OPEN_PATH_EVENT, on)
    return () => window.removeEventListener(OPEN_PATH_EVENT, on)
  }, [id, files, s?.cwd])

  if (detail.error && !s) {
    return <Empty title={detail.error instanceof ApiError && detail.error.status === 404 ? 'Chat not found' : 'Cannot load the chat'}>{detail.error.message}</Empty>
  }
  const ended = !!s && (s.status === 'ended' || !!s.detached)
  const canType = !!s && canControl && s.owned && !ended
  const title = s ? chatTitle(s) : 'Chat'
  // End in the ⋯, or the one line that says why not (components/PhoneEnd).
  const ending = s ? endState(s, canControl) : null
  const n = files?.length ?? 0
  // A conversation imported from Claude.ai or ChatGPT (ADR-074): a copy,
  // read here, with no folder and nothing to continue.
  const source = importedFrom(s)

  const act = async (fn: () => Promise<unknown>, after: () => void) => {
    setBusy(true)
    setError('')
    try { await fn(); after() } catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }
  /** The same conversation, resumed in the chat's own folder. */
  const carryOn = () => s && act(async () => {
    const res = await api.spawn({ cwd: s.cwd, resume: s.session_id, fork: false })
    if (res.session_id !== s.session_id) navigate({ name: 'chat', id: res.session_id })
    else detail.refresh()
  }, () => {})

  const footer = s && !canType ? (
    source ? (
      <>Imported from {source}. A copy to read and search here; carry the conversation on in {source} itself.</>
    ) : !canControl ? (
      <>This device can read Caprock. To write here, open Caprock on your computer: Settings → <b className="font-medium text-fg">Use on your phone</b>, then <b className="font-medium text-fg">Allow control</b>.</>
    ) : ended ? (
      <div className="grid gap-2">
        <span data-chat-ended>{idleEndedText(s) ? `${idleEndedText(s)}. Its conversation and its files are kept.` : 'This chat has ended. Its conversation and its files are kept.'}</span>
        {s.resume?.ok && (
          <button type="button" disabled={busy} onClick={() => void carryOn()} className="min-h-12 rounded-[12px] bg-accent text-[16px] font-semibold text-bg disabled:opacity-60">
            {busy ? 'Opening…' : 'Continue this chat'}
          </button>
        )}
      </div>
    ) : (
      <>Started outside Caprock, so it can be read here but not written into.</>
    )
  ) : undefined

  return (
    <div className="mx-auto grid w-full max-w-[900px] grid-cols-1">
      <div ref={fill} className={`flex min-h-0 flex-col overflow-hidden bg-panel ${phone ? '' : 'rounded-[12px] border border-border'}`}>
        <header data-chat-header className={`flex min-h-12 shrink-0 items-center gap-1 border-b border-border px-1.5 ${phone ? 'pt-[env(safe-area-inset-top)]' : ''}`}>
          <a href={href({ name: 'chats' })} aria-label="All chats" className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-fg-muted no-underline hover:text-fg">
            <span className="rotate-180"><ChevronIcon size={18} /></span>
          </a>
          {renaming && s ? (
            <div className="min-w-0 flex-1 py-1">
              <RenameField initial={s.name ?? ''} placeholder={title} onDone={(name) => {
                setRenaming(false)
                if (name !== null) void act(() => api.renameSession(s.session_id, name), detail.refresh)
              }} />
            </div>
          ) : (
            <button type="button" disabled={!canControl || !s} onClick={() => setRenaming(true)} title={canControl ? 'Rename' : undefined} className="min-w-0 flex-1 px-1 text-left">
              <h1 className="truncate text-[16px] font-semibold leading-tight text-fg">{title}</h1>
              <span className="block truncate text-[12.5px] text-fg-faint">
                {s ? [chatModelLabel(s), ended ? (idleEndedText(s).toLowerCase() || 'ended') : s.activity?.health === 'working' ? 'answering…' : s.activity?.health === 'waiting-on-you' ? 'waiting for you' : ''].filter(Boolean).join(' · ') : ' '}
              </span>
            </button>
          )}
          {!renaming && (
            <>
              {!source && <button type="button" onClick={() => setSheet('files')} aria-label={`Files · ${n}`} className="relative inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3 text-[14px] text-fg-muted hover:text-fg">
                <FileIcon size={16} /> {phone ? '' : 'Files'}
                {n > 0 && <span className="num grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 text-[11px] font-semibold text-bg">{n}</span>}
              </button>}
              {s && (canControl || ending) && (
                <button type="button" aria-label="More" onClick={() => { setSheet('more'); setConfirm(false) }} className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-fg-muted hover:text-fg">
                  <MoreIcon size={18} />
                </button>
              )}
            </>
          )}
        </header>
        {error && <p role="alert" className="shrink-0 px-3 py-1.5 text-[13px] text-danger">{error}</p>}
        <ChatView
          key={id}
          sessionId={id}
          onResent={(next) => navigate({ name: 'chat', id: next })}
          canType={canType}
          ended={ended}
          phone={phone}
          foldKeys
          chat
          agent={s?.agent}
          prompt={!!s && s.owned}
          className="min-h-0 flex-1"
          footer={footer}
        />
      </div>
      {sheet === 'files' && files && (
        <ChatFilesSheet files={files} now={now} onClose={() => setSheet(null)} onOpen={(f) => { setSheet(null); setOpen(f) }} />
      )}
      {sheet === 'more' && s && (
        <ChatSheet title={title} onClose={() => setSheet(null)}>
          <div className="grid gap-2">
            {ending?.can && (
              <button type="button" data-chat-end className={`${SHEET_BASE} font-medium text-danger`} onClick={() => { setSheet(null); setEndSheet(true) }}>End this chat…</button>
            )}
            {ending && !ending.can && <p data-chat-end-why className="text-[14px] leading-snug text-fg-muted"><span className="font-medium text-fg">End</span> · {ending.why}</p>}
            {canControl && <>
            <button type="button" className={SHEET_BTN} onClick={() => { setSheet(null); setRenaming(true) }}>Rename</button>
            <button type="button" className={SHEET_BTN} disabled={busy} onClick={() => void act(() => api.archiveChat(id, !s.archived_at), () => { setSheet(null); navigate({ name: 'chats' }) })}>
              {s.archived_at ? 'Move back to Chats' : 'Archive — hide it from Chats'}
            </button>
            {!confirm ? (
              <button type="button" className={`${SHEET_BASE} text-danger`} onClick={() => setConfirm(true)}>Delete…</button>
            ) : (
              <button type="button" disabled={busy} className={`${SHEET_BASE} border-danger font-semibold text-danger`} onClick={() => void act(() => api.deleteChat(id), () => { setSheet(null); navigate({ name: 'chats' }) })}>
                {busy ? 'Deleting…' : source ? `Delete this copy (it stays in ${source})` : `Delete for good, with its ${n === 1 ? 'file' : `${n} files`}`}
              </button>
            )}
            </>}
            {/* The phone's bar is one row: the raw keys are here (rule 7: canType). */}
            {phone && canType && (
              <div className="grid gap-1.5 pt-1">
                <span className="text-[12px] uppercase tracking-wide text-fg-faint">Keys</span>
                <KeyGrid onKey={(bytes, label) => void api.agentInput(id, bytes).catch((e: unknown) => setError(`${label} not sent — ${errText(e)}`))} />
              </div>
            )}
            {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
          </div>
        </ChatSheet>
      )}
      {endSheet && s && <EndSheet sessionId={s.session_id} title={title} onClose={() => setEndSheet(false)} onEnded={detail.refresh} />}
      {open && <ChatFileViewer sessionId={id} file={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

// The colour is apart: two text colours in one class list leave the winner to the stylesheet's order.
const SHEET_BASE = 'min-h-12 w-full rounded-[12px] border border-border-strong bg-bg px-4 text-left text-[16px] disabled:opacity-60'
const SHEET_BTN = `${SHEET_BASE} text-fg`
