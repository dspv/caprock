import { useEffect, useState } from 'react'
import type { Folder, Message, Settings } from './mailApi'
import { api, partURL } from './mailApi'
import type { Row } from './MailScreen'
import { MailBody } from './MailBody'
import { bytes, firstName, hue, initials, longDate, people, sender, shortDate } from './format'
import { Icon } from './icons'

export function Reader({ row, view, aiOn, settings, folders, onThread, onAct, onReply, onForward }: {
  row: Row
  view: string
  aiOn: boolean
  settings: Settings
  folders: Folder[]
  onThread: (t: Message[]) => void
  onAct: (action: string, folder?: number) => void
  onReply: (m: Message, all: boolean) => void
  onForward: (m: Message) => void
}) {
  const [thread, setThread] = useState<Message[] | null>(null)
  const [open, setOpen] = useState<Set<number>>(new Set())
  const [err, setErr] = useState('')
  const [summary, setSummary] = useState<string | null>(null)
  const [sumBusy, setSumBusy] = useState(false)
  const [remote, setRemote] = useState<Set<number>>(new Set())
  const [moveOpen, setMoveOpen] = useState(false)

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
    setSumBusy(true)
    try {
      setSummary((await api.summarize(row.m.id)).text)
    } catch (e) {
      setSummary('Could not summarise: ' + (e as Error).message)
    } finally {
      setSumBusy(false)
    }
  }

  const m0 = row.m
  const last = thread?.[thread.length - 1] ?? m0
  const allowAll = settings.remote_images === 'always'

  return (
    <div className="readwrap">
      <div className="toolbar">
        {view === 'junk'
          ? <button className="btn" onClick={() => onAct('inbox')}>Not spam</button>
          : view !== 'archive' && <button className="icon" title="Archive (e)" onClick={() => onAct('archive')}><Icon name="archive" /></button>}
        <button className="icon" title="Delete (#)" onClick={() => onAct('trash')}><Icon name="trash" /></button>
        {view !== 'junk' && <button className="icon" title="Spam (!)" onClick={() => onAct('spam')}><Icon name="spam" /></button>}
        <div className="movewrap">
          <button className="icon" title="Move to folder" onClick={() => setMoveOpen(!moveOpen)}><Icon name="folder" /></button>
          {moveOpen && (
            <div className="menu" onMouseLeave={() => setMoveOpen(false)}>
              {folders.filter((f) => f.id !== m0.folder_id && !['all', 'flagged', 'important'].includes(f.role)).map((f) => (
                <div key={f.id} onClick={() => { setMoveOpen(false); onAct('move', f.id) }}>{f.name}</div>
              ))}
            </div>
          )}
        </div>
        <span className="sep" />
        <button className="icon" title={row.unread ? 'Mark read' : 'Mark unread (u)'} onClick={() => onAct(row.unread ? 'read' : 'unread')}><Icon name="unread" /></button>
        <button className={'icon' + (row.flagged ? ' starred' : '')} title="Star (s)" onClick={() => onAct(row.flagged ? 'unflag' : 'flag')}><Icon name="star" /></button>
        <span className="grow" />
        {aiOn && <button className="btn" disabled={sumBusy} onClick={summarize}><Icon name="sparkle" size={14} /> {sumBusy ? 'Reading…' : 'Summarise'}</button>}
        <button className="icon" title="Reply (r)" onClick={() => onReply(last, false)}><Icon name="reply" /></button>
        <button className="icon" title="Reply all (a)" onClick={() => onReply(last, true)}><Icon name="replyAll" /></button>
        <button className="icon" title="Forward (f)" onClick={() => onForward(last)}><Icon name="forward" /></button>
      </div>
      <div className="readscroll">
        <h1 className="subj">{m0.subject || '(no subject)'}</h1>
        {summary && (
          <div className="summary">
            <div className="sumhead"><Icon name="sparkle" size={14} /> Summary <span className="muted small">by your local model</span>
              <button className="icon tiny" onClick={() => setSummary(null)}><Icon name="close" size={12} /></button></div>
            <div className="sumtext">{summary}</div>
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
                    <MailBody m={m} allowRemote={allowAll || remote.has(m.id)} onAllowRemote={() => setRemote((r) => new Set(r).add(m.id))} />
                  </div>
                  {attachments.length > 0 && (
                    <div className="chips">
                      {attachments.map((p) => (
                        <a key={p.path} className="chip" href={partURL(m.id, p.path, true)} download={p.filename}>
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
