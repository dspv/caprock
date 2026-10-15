import { useEffect, useRef, useState } from 'react'
import type { Folder, Message, Settings } from './mailApi'
import { api, partURL, whoText } from './mailApi'
import type { Row } from './MailScreen'
import { MailBody } from './MailBody'
import { bytes, firstName, hue, initials, longDate, people, sender, shortDate } from './format'
import { Icon } from './icons'
import { K } from './keymap'
import { isSpam, spamWhy } from './junk'
import { isTauri } from '@/lib/appmode'
import { openExternal } from '@/lib/nudges'

export function Reader({ row, view, aiOn, settings, who = '', onAiSettings, onNotSpam, folders, onThread, onAct, onReply, onForward, onMailto, moveKick = 0, sumKick = 0, onSettings }: {
  row: Row
  view: string
  aiOn: boolean
  settings: Settings
  /** Who does the AI work ("Claude Code · haiku"), shown under a summary. */
  who?: string
  /** Opens Settings on its AI section. */
  onAiSettings?: () => void
  /** Not spam (n): back to the inbox from Spam, or the AI's spam label taken back. */
  onNotSpam?: () => void
  /** When the v and i keys were last pressed (ms): open Move, summarise. */
  moveKick?: number
  sumKick?: number
  onSettings?: (s: Settings) => void
  folders: Folder[]
  onThread: (t: Message[]) => void
  onAct: (action: string, folder?: number) => void
  onReply: (m: Message, all: boolean) => void
  onForward: (m: Message) => void
  onMailto?: (addr: string) => void
}) {
  const [thread, setThread] = useState<Message[] | null>(null)
  const [open, setOpen] = useState<Set<number>>(new Set())
  const [err, setErr] = useState('')
  const [summary, setSummary] = useState<string | null>(null)
  const [sumBusy, setSumBusy] = useState(false)
  const [sumBy, setSumBy] = useState('')
  const [remote, setRemote] = useState<Set<number>>(new Set())
  const [moveOpen, setMoveOpen] = useState(false)
  const [moveAt, setMoveAt] = useState(0)
  // AI off: Summarise still shows, and the first press asks once, in place.
  const [askAi, setAskAi] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api.thread(row.m.id).then((t) => {
      if (!live) return
      if (t.length === 0) t = [row.m]
      setThread(t)
      onThread(t)
      // Unread messages and the newest one start expanded.
      const o = new Set<number>(t.filter((m) => !m.seen || row.ids.includes(m.id) && m.id === row.m.id).map((m) => m.id))
      o.add(t[t.length - 1]!.id)
      setOpen(o)
    }).catch((e) => live && setErr(e.message))
    return () => { live = false }
  }, [row.m.id])

  const summarize = async () => {
    if (!aiOn) {
      // Name who would answer and where the thread would go before anything is sent.
      const st = await api.aiStatus().catch(() => null)
      setAskAi(st?.available ? `${st.label}: this conversation goes to ${st.sends_to ?? st.label}.` : 'No AI is set up on this computer yet. Settings › AI picks one.')
      return
    }
    setSumBusy(true)
    try {
      const r = await api.summarize(row.m.id)
      setSummary(r.text)
      setSumBy(whoText(r))
    } catch (e) {
      setSummary('Could not summarise: ' + (e as Error).message)
      setSumBy('')
    } finally {
      setSumBusy(false)
    }
  }

  // v and i, pressed in the list (MailScreen bumps the counters).
  // The kicks are the time the key was pressed. The reader can be remounted
  // between the key and its effect (a refreshed row), so a press under a
  // second old still counts on mount; an older one does not.
  const kicks = useRef({ move: Date.now() - moveKick < 1000 ? 0 : moveKick, sum: Date.now() - sumKick < 1000 ? 0 : sumKick })
  useEffect(() => {
    if (moveKick !== kicks.current.move) { kicks.current.move = moveKick; setMoveOpen(true); setMoveAt(0) }
  }, [moveKick])
  useEffect(() => {
    if (sumKick !== kicks.current.sum) { kicks.current.sum = sumKick; summarize().catch(() => {}) }
  }, [sumKick])

  const turnOnAi = async () => {
    setAskAi(null)
    const next = await api.putSettings({ ...settings, ai_enabled: '1' })
    onSettings?.(next)
    setSumBusy(true)
    try {
      const r = await api.summarize(row.m.id)
      setSummary(r.text)
      setSumBy(whoText(r))
    } catch (e) {
      setSummary('Could not summarise: ' + (e as Error).message)
    } finally {
      setSumBusy(false)
    }
  }

  const m0 = row.m
  const targets = folders.filter((f) => f.id !== m0.folder_id && !['all', 'flagged', 'important'].includes(f.role))

  // While Move or the AI question is open, keys act on them and nothing else:
  // j/k or arrows pick, Enter moves, a digit picks directly, Esc closes.
  useEffect(() => {
    if (!moveOpen && askAi === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      let used = true
      if (askAi !== null) {
        if (e.key === 'Enter') turnOnAi().catch(() => {})
        else if (e.key === 'Escape') setAskAi(null)
        else used = false
      } else if (e.key === 'Escape' || e.key === 'v') setMoveOpen(false)
      else if (e.key === 'j' || e.key === 'ArrowDown') setMoveAt((i) => Math.min(i + 1, targets.length - 1))
      else if (e.key === 'k' || e.key === 'ArrowUp') setMoveAt((i) => Math.max(i - 1, 0))
      else if (e.key === 'Enter' || /^[1-9]$/.test(e.key)) {
        const f = targets[e.key === 'Enter' ? moveAt : Number(e.key) - 1]
        if (f) { setMoveOpen(false); onAct('move', f.id) }
      } else used = false
      if (used) { e.preventDefault(); e.stopImmediatePropagation() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })
  const last = thread?.[thread.length - 1] ?? m0
  const allowAll = settings.remote_images === 'always'

  return (
    <div className="readwrap">
      <div className="toolbar">
        {view === 'junk'
          ? <button className="btn" onClick={() => (onNotSpam ? onNotSpam() : onAct('inbox'))}>Not spam <K k="notSpam" /></button>
          : view !== 'archive' && <button className="icon withkey" title="Archive" onClick={() => onAct('archive')}><Icon name="archive" /> <K k="archive" /></button>}
        {view !== 'junk' && isSpam(row.m) && <button className="btn" onClick={() => (onNotSpam ? onNotSpam() : onAct('notjunk'))}>Not spam <K k="notSpam" /></button>}
        <button className="icon withkey" title="Delete" onClick={() => onAct('trash')}><Icon name="trash" /> <K k="trash" /></button>
        {view !== 'junk' && !isSpam(row.m) && <button className="icon withkey" title="Spam" onClick={() => onAct('spam')}><Icon name="spam" /> <K k="spam" /></button>}
        <div className="movewrap">
          <button className="icon withkey" title="Move to folder" onClick={() => { setMoveOpen(!moveOpen); setMoveAt(0) }}><Icon name="folder" /> <K k="move" /></button>
          {moveOpen && (
            <div className="menu" onMouseLeave={() => setMoveOpen(false)}>
              {targets.map((f, i) => (
                <div key={f.id} className={i === moveAt ? 'on' : ''} onMouseEnter={() => setMoveAt(i)}
                  onClick={() => { setMoveOpen(false); onAct('move', f.id) }}>
                  {i < 9 && <kbd className="k">{i + 1}</kbd>} {f.name}
                </div>
              ))}
            </div>
          )}
        </div>
        <span className="sep" />
        <button className="icon withkey" title={row.unread ? 'Mark read' : 'Mark unread'} onClick={() => onAct(row.unread ? 'read' : 'unread')}><Icon name="unread" /> <K k="unread" /></button>
        <button className={'icon withkey' + (row.flagged ? ' starred' : '')} title="Star" onClick={() => onAct(row.flagged ? 'unflag' : 'flag')}><Icon name="star" /> <K k="star" /></button>
        <span className="grow" />
        <button className="btn" disabled={sumBusy} onClick={() => summarize().catch(() => {})}><Icon name="sparkle" size={14} /> {sumBusy ? 'Reading…' : 'Summarise'} <K k="summarise" /></button>
        <button className="icon withkey" title="Reply" onClick={() => onReply(last, false)}><Icon name="reply" /> <K k="reply" /></button>
        <button className="icon withkey" title="Reply all" onClick={() => onReply(last, true)}><Icon name="replyAll" /> <K k="replyAll" /></button>
        <button className="icon withkey" title="Forward" onClick={() => onForward(last)}><Icon name="forward" /> <K k="forward" /></button>
      </div>
      {askAi !== null && (
        <div className="askai">
          <Icon name="sparkle" size={14} /> <span>{askAi}</span> <span className="grow" />
          {!askAi.startsWith('No AI') && <button className="btn primary" onClick={() => turnOnAi().catch(() => {})}>Turn on and summarise <kbd className="k">↩</kbd></button>}
          <button className="btn" onClick={() => setAskAi(null)}>Not now <K k="close" /></button>
        </div>
      )}
      <div className="readscroll">
        <h1 className="subj">{m0.subject || '(no subject)'}</h1>
        {isSpam(m0) && (
          <div className="junknote" role="note">
            <Icon name="spam" size={14} />
            <span>{spamWhy(m0)} It is hidden from the Inbox; nothing was moved on the server.</span>
            <span className="grow" />
            <button className="btn small" onClick={() => (onNotSpam ? onNotSpam() : onAct('notjunk'))}>Not spam <K k="notSpam" /></button>
          </div>
        )}
        {summary ? (
          <div className="summary">
            <div className="sumhead"><Icon name="sparkle" size={14} /> Summary
              <button className="icon tiny" onClick={() => setSummary(null)}><Icon name="close" size={12} /></button></div>
            <div className="sumtext">{summary}</div>
            <SumFoot by={sumBy || who} onAiSettings={onAiSettings} />
          </div>
        ) : row.m.ai?.summary && !sumBusy && (
          // The one line triage stored: shown at once; i writes the full summary.
          <div className="summary short">
            <div className="shortline"><Icon name="sparkle" size={13} /><span>{row.m.ai.summary}</span></div>
            <SumFoot by={row.m.ai.user ? '' : who} onAiSettings={onAiSettings} more={() => summarize().catch(() => {})} />
          </div>
        )}
        {err && <div className="error">{err}</div>}
        {!thread && !err && <div className="muted pad">Loading…</div>}
        {thread?.map((m) => {
          const isOpen = open.has(m.id)
          const attachments = (m.structure.parts ?? []).filter((p) => p.attachment)
          return (
            <article key={m.id} className={'msg' + (isOpen ? ' open' : '')}>
              <header onClick={() => setOpen((o) => { const n = new Set(o); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n })}>
                <div className="avatar big" style={{ background: `hsl(${hue(m.from_addr)} 45% 55%)` }}>{initials(m.from_name || m.from_addr)}</div>
                <div className="who">
                  <div><b>{sender(m)}</b> <span className="muted small">{m.from_addr}</span></div>
                  {isOpen
                    ? <div className="muted small">to {(m.to ?? []).map(firstName).join(', ') || 'undisclosed recipients'}{(m.cc?.length ?? 0) > 0 && `, cc ${m.cc.map(firstName).join(', ')}`}</div>
                    : <div className="muted small clip">{m.snippet}</div>}
                </div>
                <div className="when muted small" title={longDate(m.date)}>{isOpen ? longDate(m.date) : shortDate(m.date)}</div>
              </header>
              {isOpen && (
                <>
                  {(m.to?.length ?? 0) + (m.cc?.length ?? 0) > 3 && <div className="muted small recips">To: {people(m.to)}{m.cc?.length ? ` · Cc: ${people(m.cc)}` : ''}</div>}
                  <div className="body">
                    <MailBody m={m} allowRemote={allowAll || remote.has(m.id)} onAllowRemote={() => setRemote((r) => new Set(r).add(m.id))} onMailto={onMailto} />
                  </div>
                  {attachments.length > 0 && (
                    <div className="chips">
                      {attachments.map((p) => (
                        <a key={p.path} className="chip" href={partURL(m.id, p.path, true)} download={p.filename}
                          onClick={(e) => {
                            // The app's webview does not download; the system browser does, from this same loopback daemon.
                            if (isTauri()) { e.preventDefault(); openExternal(location.origin + partURL(m.id, p.path, true)) }
                          }}>
                          <Icon name={p.type.startsWith('image/') ? 'image' : 'clip'} size={13} /> {p.filename} <span className="muted">{bytes(p.size)}</span>
                        </a>
                      ))}
                    </div>
                  )}
                </>
              )}
            </article>
          )
        })}
        {thread && (
          <div className="replybox" onClick={() => onReply(last, false)}>
            Reply to {firstName({ name: last.from_name, addr: last.from_addr })}…
          </div>
        )}
      </div>
    </div>
  )
}

/** Under a summary: who wrote it, the way to change that, and the full summary for a short one. */
function SumFoot({ by, onAiSettings, more }: { by: string; onAiSettings?: () => void; more?: () => void }) {
  return (
    <div className="sumfoot muted small">
      {by && <span>by {by}</span>}
      {by && onAiSettings && <> · <button className="link" onClick={onAiSettings}>change</button></>}
      {more && <>{by && ' · '}<button className="link" onClick={more}>Full summary</button> <K k="summarise" /></>}
    </div>
  )
}
