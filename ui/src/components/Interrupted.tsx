import { useEffect, useState } from 'react'
import { api, type SessionDetail } from '@/lib/api'
import { fmtAgo, fmtWhen, shortId } from '@/lib/format'
import { href } from '@/lib/router'
import { ContinueSession } from '@/components/ContinueSession'

const KEY = 'caprock.interrupted.dismissed'

/**
 * The sessions a restart cut off, named together, each with continue.
 *
 * After an OS update they were four ended cards among a hundred, all stamped
 * with the moment of the restart, and finding the one that mattered meant
 * opening each (FB-038). The daemon knows which were running when it stopped;
 * this says so once, and is dismissed per stop rather than forever.
 */
export function InterruptedBanner({ info, now }: { info?: { stopped_at: number; ids: string[] }; now: number }) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [items, setItems] = useState<SessionDetail[]>([])
  const ids = info?.ids.join(',') ?? ''
  useEffect(() => {
    if (!ids) return
    let stale = false
    Promise.all(ids.split(',').map((id) => api.session(id).catch(() => null))).then((got) => {
      if (!stale) setItems(got.filter((s): s is SessionDetail => !!s && s.status === 'ended'))
    })
    return () => {
      stale = true
    }
  }, [ids])
  if (!info || dismissed === String(info.stopped_at) || items.length === 0) return null
  const dismiss = () => {
    try {
      localStorage.setItem(KEY, String(info.stopped_at))
    } catch {
      /* dismissed for this visit only */
    }
    setDismissed(String(info.stopped_at))
  }
  return (
    <div className="border border-accent/50 bg-accent/10 px-3 py-2 text-[12px] rounded-[var(--radius-panel)] grid gap-1.5">
      <div className="flex items-center gap-3">
        <span className="text-accent font-medium">
          {items.length === 1 ? 'A session was' : `${items.length} sessions were`} still running when Caprock last stopped
        </span>
        <span className="text-fg-muted num" title={fmtWhen(info.stopped_at)}>{fmtAgo(info.stopped_at, now)}</span>
        <button type="button" onClick={dismiss} className="ml-auto text-[11px] text-fg-faint hover:text-fg">dismiss</button>
      </div>
      <ul className="grid gap-1">
        {items.map((s) => (
          <li key={s.session_id} className="flex items-center gap-3 min-w-0">
            <a href={href({ name: 'session', id: s.session_id })} className="link truncate min-w-0">
              <span className="text-fg">{s.project || 'unknown project'}</span>
              <span className="text-fg-muted"> · {s.description || shortId(s.session_id)}</span>
            </a>
            {s.resume && (
              <span className="ml-auto shrink-0">
                <ContinueSession sessionID={s.session_id} cwd={s.cwd} live={false} resume={s.resume} compact />
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
