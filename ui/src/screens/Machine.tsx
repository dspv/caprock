/**
 * Another computer (ADR-067), at #/m/<id>: its sessions, and one of them at
 * #/m/<id>/session/<sid>.
 *
 * The list is read through this daemon's `/v1/m/<id>/…` proxy: running ones
 * first, then the recent ones. A session opens in a frame of this same
 * dashboard pointed at that computer (screens/MachinePage, lib/machinepage):
 * the Session view and its terminal as they are on the other computer's own
 * screen, typed into as this machine's paired device there.
 *
 * States say what to do: offline (and why), waiting for Allow there, removed
 * there, refused. A terminal that drops with the channel reopens by itself
 * and resumes where it was (terminal protocol v2).
 */
import { useState } from 'react'
import { ApiError, type SessionSummary } from '@/lib/api'
import { machineLook, machinePageURL, offlineWhy, machinesApi, useMachines, type Machine } from '@/lib/machines'
import { href, navigate } from '@/lib/router'
import { useApi } from '@/lib/useApi'
import { useNow } from '@/lib/useNow'
import { basename, fmtAgo } from '@/lib/format'
import { Empty, Skeleton } from '@/components/ui'

export function MachineScreen({ id, session, tab }: { id: string; session?: string; tab?: string }) {
  const list = useMachines()
  const m = list.data?.find((x) => x.id === id)
  if (!list.data) return list.error ? <Empty title="Cannot reach the daemon">{list.error.message}</Empty> : <Skeleton rows={4} />
  if (!m) {
    return (
      <Empty title="No such computer">
        This computer is not linked here, or was forgotten. <a href={href({ name: 'settings', section: 'computers' })} className="text-accent hover:underline">Settings → Computers</a>
      </Empty>
    )
  }
  return session ? <MachineSession m={m} session={session} tab={tab} /> : <MachineSessions m={m} />
}

/** The computer's name and how it stands, above its list or its session. */
function MachineHead({ m, back, children }: { m: Machine; back?: boolean; children?: React.ReactNode }) {
  const look = machineLook(m)
  const tone = { ok: 'text-ok', muted: 'text-fg-muted', warn: 'text-warn', bad: 'text-danger' }[look.tone]
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {back && <a href={href({ name: 'machine', id: m.id })} className="text-[13px] text-fg-muted hover:text-fg">← {m.name}</a>}
      {!back && <h1 className="text-[18px] font-semibold text-fg">{m.name}</h1>}
      <span data-machine-state={m.status} className={`text-[12.5px] ${tone}`}>{look.label}</span>
      {m.version && <span className="text-[12px] text-fg-faint">Caprock {m.version}</span>}
      <span className="flex-1" />
      {children}
    </div>
  )
}

function MachineSessions({ m }: { m: Machine }) {
  const now = useNow(30_000)
  const look = machineLook(m)
  const sessions = useApi(() => machinesApi.sessions(m.id, false), [m.id], { live: false, intervalMs: 15_000, active: look.reachable })
  const failure = sessions.error instanceof ApiError ? (sessions.error.body as { error?: string; status?: string } | undefined) : undefined
  const all = sessions.data ?? []
  const running = all.filter((s) => s.status !== 'ended')
  const recent = all.filter((s) => s.status === 'ended').slice(0, 20)
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-4" data-machine={m.id}>
      <MachineHead m={m}>
        <a href={href({ name: 'settings', section: 'computers' })} className="text-[12.5px] text-fg-muted hover:text-fg">Settings → Computers</a>
      </MachineHead>
      {!failure?.status && look.detail && look.tone !== 'ok' && look.tone !== 'muted' && <p className="text-[13px] text-fg-muted">{look.detail}</p>}
      {failure?.status && (
        <p role="alert" className="text-[13px] text-danger" data-machine-error={failure.status} title={failure.error}>
          {failure.status === 'offline' ? `${m.name} is offline. ${offlineWhy(failure.error ?? '')}` : failure.status === 'revoked' ? machineLook({ ...m, status: 'revoked' }).detail : failure.error ?? sessions.error?.message}
          {' '}
          <button type="button" onClick={sessions.refresh} className="text-accent hover:underline">Try again</button>
        </p>
      )}
      {sessions.error && !failure?.status && <p role="alert" className="text-[13px] text-danger">{sessions.error.message}</p>}
      {look.reachable && !sessions.data && !sessions.error && <Skeleton rows={4} />}
      {sessions.data && (
        <>
          <SessionGroup title="Running" items={running} m={m} now={now} empty={`Nothing runs on ${m.name} now.`} />
          {recent.length > 0 && <SessionGroup title="Recent" items={recent} m={m} now={now} />}
          <p className="text-[12px] text-fg-faint">
            Starting a session on {m.name} from here comes next; for now start it there, or with <span className="mono">caprock</span> over SSH, and it shows up here.
          </p>
        </>
      )}
    </div>
  )
}

function SessionGroup({ title, items, m, now, empty }: { title: string; items: SessionSummary[]; m: Machine; now: number; empty?: string }) {
  return (
    <section className="grid gap-1.5">
      <h2 className="text-[12.5px] font-medium text-fg-muted">{title}{items.length > 0 ? ` · ${items.length}` : ''}</h2>
      {items.length === 0 ? <p className="text-[13px] text-fg-faint">{empty}</p> : (
        <ul className="grid gap-1">
          {items.map((s) => (
            <li key={s.session_id}>
              <a
                href={href({ name: 'machine', id: m.id, session: s.session_id })}
                data-machine-session={s.session_id}
                className="flex min-w-0 items-center gap-3 rounded-md border border-border bg-panel px-3 py-2 hover:border-border-strong"
              >
                <span aria-hidden className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${s.status === 'active' ? 'bg-ok' : s.status === 'idle' ? 'bg-warn' : 'bg-fg-faint'}`} />
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg">{sessionTitle(s)}</span>
                <span className="mono shrink-0 truncate text-[12px] text-fg-muted">{basename(s.cwd) || s.project}</span>
                <span className="shrink-0 text-[12px] text-fg-faint">{fmtAgo(s.last_event_at, now)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** A session's name as the sidebar shows it: the user's, the agent's, else its folder. */
export function sessionTitle(s: Pick<SessionSummary, 'name' | 'title' | 'cwd' | 'project'>): string {
  return s.name || s.title || basename(s.cwd) || s.project || 'session'
}

function MachineSession({ m, session, tab }: { m: Machine; session: string; tab?: string }) {
  const look = machineLook(m)
  // The frame's address is set once per session: a tab chosen inside it is
  // its own business, and reloading it on every hash change would cut the
  // terminal it holds.
  const [src] = useState(() => machinePageURL(m.id, session, tab ?? 'terminal'))
  return (
    <div className="grid w-full gap-2" data-machine={m.id} data-machine-session-open={session}>
      <MachineHead m={m} back>
        <button type="button" onClick={() => navigate({ name: 'machine', id: m.id })} className="text-[12.5px] text-fg-muted hover:text-fg">All of {m.name}&apos;s sessions</button>
      </MachineHead>
      {!look.reachable && look.detail && <p role="alert" className="text-[13px] text-danger">{look.detail}</p>}
      {look.reachable && (
        <iframe
          key={session}
          title={`${m.name}: session`}
          src={src}
          data-machine-frame
          className="block w-full rounded-md border border-border bg-bg"
          style={{ height: 'calc(100vh - 11rem)', minHeight: 420 }}
        />
      )}
    </div>
  )
}
