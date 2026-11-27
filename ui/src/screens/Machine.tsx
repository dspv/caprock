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
 * A computer's page is the owner's pick of 2026-11-25 (page B, *Machine
 * card*): a band with its OS mark and live dot, its name large and a spec
 * line (state, OS, memory, cores, Caprock version), **Start an agent there**
 * where New agent can open on it (the app); then its memory and processor
 * bars and how many agents run, what is ready there, and its sessions.
 * Offline, the figures it had last time, said as last time. All computers
 * (#/m) is one card each with the same figures (components/MachineCard).
 *
 * States say what to do: offline (and why), waiting for Allow there, removed
 * there, refused. A terminal that drops with the channel reopens by itself
 * and resumes where it was (terminal protocol v2).
 */
import { useMemo, useState, type ReactNode } from 'react'
import { ApiError, type SessionSummary } from '@/lib/api'
import { machineLook, machinePageURL, offlineWhy, machinesApi, useMachineSessions, useMachines, type Machine, type MachineSessions as MachineRead } from '@/lib/machines'
import { gb, machineState, osName, seenAgo, stateStatus, useMachineSpec } from '@/lib/machinespec'
import { ready, useAppActions } from '@/lib/setup'
import { MachineCard, MachineMeters, MachineReadyList, OsGlyph } from '@/components/MachineCard'
import { href, navigate } from '@/lib/router'
import { useApi } from '@/lib/useApi'
import { useNow } from '@/lib/useNow'
import { keys } from '@/lib/appkeys'
import { basename, fmtAgo } from '@/lib/format'
import { Empty, Skeleton } from '@/components/ui'
import { RemoteSetup } from '@/components/RemoteSetup'
import { SendSecrets } from '@/components/SendSecrets'

export function MachineScreen({ id, session, tab, joined }: { id: string; session?: string; tab?: string; joined?: boolean }) {
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
  return session ? <MachineSession m={m} session={session} tab={tab} /> : <MachineSessions m={m} joined={joined} />
}

/** The computer's name and how it stands, above its list or its session. */
function MachineHead({ m, back, children }: { m: Machine; back?: boolean; children?: ReactNode }) {
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

function MachineSessions({ m, joined }: { m: Machine; joined?: boolean }) {
  const now = useNow(30_000)
  const actions = useAppActions()
  // The one list the sidebar reads too (shared, no second request): its
  // answer stands in for this page's own until that comes.
  const shared = useMachineSessions(useMemo(() => [m], [m])).get(m.id)
  const sessions = useApi(() => machinesApi.sessions(m.id, false), [m.id], { live: false, intervalMs: 15_000, active: machineLook(m).reachable })
  const failure = sessions.error instanceof ApiError ? (sessions.error.body as { error?: string; status?: string } | undefined) : undefined
  // Its state is machineState's, as the sidebar and All computers have it:
  // this page's own read when it has one, else the shared list's.
  const read = failure?.status ? { status: failure.status } : sessions.data ? { status: 'online' } : shared
  const st = machineState(m, read)
  const look = machineLook({ ...m, status: stateStatus(m, read, st) })
  const spec = useMachineSpec(m.id, look.reachable && !st.down, 15_000)
  // What runs there: this page's read (running and recent), else the shared
  // list's running ones, so a slow first read there never leaves a skeleton.
  const sharedRunning = shared?.status === 'online' && !shared.error ? shared.sessions : undefined
  const listed = sessions.data ?? sharedRunning
  const all = listed ?? []
  const running = all.filter((s) => s.status !== 'ended')
  const recent = (sessions.data ?? []).filter((s) => s.status === 'ended').slice(0, 20)
  const rep = spec.data?.setup
  const f = spec.data?.machine
  // Figures kept from before and not yet confirmed, or the computer is down: last time's.
  const lastTime = st.down || spec.stale
  // New agent opens on this computer only in the app (AppActionsContext).
  const canStart = !!actions.newAgentOn && st.online && ready(rep)
  const lastKnown = [f?.mem_total ? `${gb(f.mem_total)} GB memory` : '', f?.cpus ? `${f.cpus} cores` : '', m.version ? `Caprock ${m.version}` : ''].filter(Boolean).join(', ')
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-5" data-machine={m.id}>
      <div className="flex justify-end gap-3">
        <a href={href({ name: 'machines' })} className="text-[12.5px] text-fg-muted hover:text-fg">All computers</a>
        <a href={href({ name: 'settings', section: 'computers' })} className="text-[12.5px] text-fg-muted hover:text-fg">Settings → Computers</a>
      </div>
      <header
        className="grid grid-cols-1 items-center gap-5 rounded-[10px] border border-border px-6 py-6 sm:grid-cols-[auto_minmax(0,1fr)]"
        style={st.online ? { background: 'linear-gradient(180deg, color-mix(in srgb, var(--color-ok) 7%, var(--color-bg)), var(--color-bg))' } : undefined}
        data-machine-band={st.online ? 'online' : st.offline ? 'offline' : m.status}
      >
        <span aria-hidden className="relative grid h-[84px] w-[84px] place-items-center rounded-[18px] border border-border-strong bg-panel text-fg-muted">
          <OsGlyph os={rep?.os} />
          <span className={`absolute -bottom-1 -right-1 h-[18px] w-[18px] rounded-full border-[3px] border-bg ${st.online ? 'bg-ok' : 'bg-fg-faint'}`} data-machine-live={st.online ? 'on' : 'off'} />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-[32px] font-bold leading-none tracking-[-0.015em] text-fg sm:text-[40px]">{m.name}</h1>
          <div className="mt-2.5 flex tabular-nums flex-wrap gap-x-[18px] gap-y-1.5 text-[14px] text-fg-muted" data-machine-spec>
            <span data-machine-state={m.status}>
              <b className={`font-semibold ${st.online || st.offline ? 'text-fg' : look.tone === 'warn' ? 'text-warn' : look.tone === 'bad' ? 'text-danger' : 'text-fg'}`}>{st.offline ? 'offline' : st.online ? 'online' : look.label}</b>
              {st.offline ? ` · ${seenAgo(m.last_seen, now)}` : st.online && ready(rep) ? ' · ready' : ''}
            </span>
            {rep?.os && <span><b className="font-semibold text-fg">{osName(rep.os)}</b></span>}
            {f?.mem_total ? <span><b className="font-semibold text-fg">{gb(f.mem_total)} GB</b> memory</span> : null}
            {f?.cpus ? <span><b className="font-semibold text-fg">{f.cpus}</b> cores</span> : null}
            {m.version && <span>Caprock <b className="font-semibold text-fg">{m.version}</b></span>}
          </div>
          {canStart && (
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={() => actions.newAgentOn!(m.id)} className="rounded-[6px] bg-accent px-3.5 py-2 text-[13.5px] font-semibold text-panel hover:brightness-110" data-start-there>Start an agent there</button>
            </div>
          )}
        </div>
      </header>
      {/* Just joined with a key made here (ADR-108): what is left is offered, nothing runs. */}
      {joined && <JoinedNote m={m} online={st.online} />}
      {/* What it still needs, each step run there on a click (#1088). */}
      {st.online && <RemoteSetup m={m} />}
      {/* Keys copied there on a click, through the link (ADR-107, #1095). */}
      {st.online && <SendSecrets m={m} />}
      {!failure?.status && look.detail && look.tone !== 'ok' && look.tone !== 'muted' && <p className="text-[13px] text-fg-muted">{look.detail}</p>}
      {sessions.error && (
        <p role="alert" className="text-[13px] text-danger" data-machine-error={failure?.status ?? 'error'} title={failure?.error}>
          {readFailure(m, st, failure, sessions.error.message)}
          {' '}
          <button type="button" onClick={sessions.refresh} className="text-accent hover:underline">Try again</button>
        </p>
      )}
      {(spec.data || st.offline) && (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          {st.offline ? (
            <div className="grid content-start gap-1 rounded-[7px] border border-border bg-panel px-4 py-3.5 text-[13.5px] text-fg-muted" data-machine-offline-note>
              <b className="font-semibold text-fg">Offline, {seenAgo(m.last_seen, now)}.</b>
              <span>It shows up again by itself when that computer is on and Caprock runs there.{lastKnown && ` Last known: ${lastKnown}.`}</span>
            </div>
          ) : st.down ? null : <MachineMeters spec={spec.data} running={running.length} />}
          <MachineReadyList m={m} spec={spec.data} lastTime={lastTime} />
        </div>
      )}
      {/* Reading, and nothing to show yet: the only skeleton, and it ends —
          every read is bounded (lib/machines.ts MACHINE_READ_MS) and ends in
          the list, its empty state, or the error above with Try again. */}
      {look.reachable && !st.down && !listed && !sessions.error && <Skeleton rows={4} />}
      {listed && !st.down && (
        <>
          <SessionGroup title="Running" items={running} m={m} now={now} empty={`Nothing runs on ${m.name} now.`} />
          {recent.length > 0 && <SessionGroup title="Recent" items={recent} m={m} now={now} />}
          {!actions.newAgentOn && (
            <p className="text-[12px] text-fg-faint">
              To start one on {m.name}, open New agent (<span className="mono">{keys('⇧⌘N')}</span>) and pick {m.name} under Machine.
            </p>
          )}
        </>
      )}
    </div>
  )
}

/**
 * The line a computer's page opens with right after it joined with a key
 * made here (ADR-108, `#/m/<id>?joined=1`): what the join did, and that what
 * is left there — the checklist below and Send secrets — waits for clicks.
 */
function JoinedNote({ m, online }: { m: Machine; online: boolean }) {
  return (
    <div role="status" data-machine-joined className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1 rounded-[10px] border border-ok/40 bg-ok/5 px-5 py-3.5 text-[13.5px]">
      <span className="min-w-0 flex-1 basis-64">
        <b className="font-semibold text-fg">✓ {m.name} joined with the key.</b>{' '}
        <span className="text-fg-muted">
          {online
            ? 'Nothing has run there and nothing was sent. Below: what it still needs, each step run there when you click it, and Send secrets, which sends only what you tick.'
            : `Nothing has run there and nothing was sent. Its steps and Send secrets show here once ${m.name} is online.`}
        </span>
      </span>
      <a href={href({ name: 'machine', id: m.id })} className="shrink-0 text-[12.5px] text-fg-muted hover:text-fg">Dismiss</a>
    </div>
  )
}

/**
 * Why this page's read of the computer failed, said for a person: offline
 * (and why) only when machineState says so — a read that ran out of time on
 * a computer whose channel is up is slow, not offline.
 */
function readFailure(m: Machine, st: { offline: boolean }, failure: { error?: string; status?: string } | undefined, message: string): string | undefined {
  const status = failure?.status
  if (status === 'offline' && st.offline) return `${m.name} is offline. ${offlineWhy(failure?.error ?? '')}`
  if (status === 'revoked' || status === 'refused' || status === 'pending') return machineLook({ ...m, status }).detail
  if (status === 'offline' || status === 'timeout') return `${m.name} is online but did not answer in time.`
  return failure?.error ?? message
}

/** All computers (#/m): one card each, the same figures as their pages; a card opens the page. */
export function MachinesScreen() {
  const list = useMachines()
  const machines = list.data
  const reads = useMachineSessions(machines)
  const now = useNow(60_000)
  if (!machines) return list.error ? <Empty title="Cannot reach the daemon">{list.error.message}</Empty> : <Skeleton rows={4} />
  if (machines.length === 0) {
    return (
      <Empty title="No other computer linked">
        Link one in <a href={href({ name: 'settings', section: 'computers' })} className="text-accent hover:underline">Settings → Computers</a>.
      </Empty>
    )
  }
  const states = machines.map((m) => machineState(m, reads.get(m.id)))
  const online = states.filter((x) => x.online).length
  const running = machines.reduce((n, m, i) => n + (states[i]!.down ? 0 : (reads.get(m.id)?.sessions ?? []).filter((s) => s.status !== 'ended').length), 0)
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4" data-machines-all-screen>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-[28px] font-bold text-fg">All computers</h1>
        <span className="text-[13.5px] tabular-nums text-fg-muted" data-machines-summary>
          {machines.length} linked · {online} online · {running} {running === 1 ? 'agent' : 'agents'} running
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
        {machines.map((m, i) => <MachineCardRead key={m.id} m={m} read={reads.get(m.id)} down={states[i]!.down} now={now} />)}
      </div>
    </div>
  )
}

/** One card with its own spec read, shared with the sidebar's and the page's. */
function MachineCardRead({ m, read, down, now }: { m: Machine; read?: MachineRead; down: boolean; now: number }) {
  const spec = useMachineSpec(m.id, !down, 30_000)
  return <MachineCard m={m} read={read} spec={spec.data} now={now} />
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
  const [src] = useState(() => machinePageURL(m.id, session, tab ?? 'chat'))
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
