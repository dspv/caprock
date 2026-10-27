/**
 * Now's *On other computers* (ADR-067, Phase 2): the sessions running on the
 * computers this one reaches, in the one list (GET /v1/machines/sessions) —
 * those that need you first, with why, each tagged with its computer, a
 * click from its terminal there (`#/m/<id>/session/<sid>`). A computer that
 * cannot be read says so with when it last answered, never with the list it
 * had then. Nothing at all with no computer linked, so a single machine's
 * Now looks as it always did; on a paired device it is never drawn (the
 * computer routes are this machine's own).
 */
import { isPairedDevice } from '@/lib/api'
import { fmtAgo } from '@/lib/format'
import { machineLook, machineSessionRoute, remoteRunning, useAllMachineSessions, useMachines, type Machine, type MachineSessionsEntry } from '@/lib/machines'
import { needsYou } from '@/lib/needs'
import { NeedChip } from './NeedChip'
import { Panel } from './ui'

/** How many rows the panel lists; the rest are on each computer's screen. */
export const MACHINE_PANEL_MAX = 8

export function MachineSessionsPanel({ now }: { now: number }) {
  if (isPairedDevice()) return null
  return <MachineSessionsInner now={now} />
}

function MachineSessionsInner({ now }: { now: number }) {
  const machines = useMachines().data ?? []
  const one = useAllMachineSessions(machines.length > 0)
  if (machines.length === 0) return null
  const entries = one.data ?? []
  const rows = remoteRunning(entries)
  const waiting = rows.filter((r) => needsYou(r.session)).length
  const down = machines.map((m) => ({ m, e: entries.find((e) => e.id === m.id) })).filter(({ e }) => e && !e.sessions)
  return (
    <Panel
      title="On other computers"
      right={<span className="text-[11px] text-fg-faint">{waiting > 0 ? <span className="text-warn">{waiting} need{waiting === 1 ? 's' : ''} you · </span> : null}{rows.length} running</span>}
    >
      <div data-machine-panel className="grid gap-px p-1.5">
        {!one.data && <p className="px-2 py-1.5 text-[12.5px] text-fg-faint">Reading the other computers…</p>}
        {rows.slice(0, MACHINE_PANEL_MAX).map(({ machine, session: s }) => {
          const title = s.name || s.title || s.project || 'session'
          const waits = needsYou(s)
          return (
            <a
              key={`${machine.id}/${s.session_id}`}
              href={machineSessionRoute(machine.id, s.session_id)}
              data-machine-panel-row={s.session_id}
              data-needs-you={waits ? '' : undefined}
              title={`${title} — on ${machine.name}, in ${s.cwd}`}
              className="flex min-w-0 items-center gap-2 rounded-[6px] px-2 py-1.5 text-[13px] hover:bg-panel-2"
            >
              <span aria-hidden className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${waits ? 'bg-warn' : s.status === 'active' ? 'bg-ok' : 'bg-fg-faint'}`} />
              <span className="min-w-0 flex-1 truncate text-fg">{title}</span>
              {waits && <NeedChip need={s.activity?.need} small />}
              <span className="mono hidden min-w-0 max-w-[30%] truncate text-[11.5px] text-fg-faint sm:inline">{s.project || s.cwd}</span>
              <span className="max-w-[30%] shrink-0 truncate rounded-[4px] border border-border px-1 text-[10.5px] text-fg-faint" data-machine-tag>{machine.name}</span>
              {s.last_event_at ? <span className="num w-[52px] shrink-0 text-right text-[11px] text-fg-faint">{fmtAgo(s.last_event_at, now)}</span> : null}
            </a>
          )
        })}
        {rows.length > MACHINE_PANEL_MAX && <p className="px-2 py-1 text-[11.5px] text-fg-faint">{rows.length - MACHINE_PANEL_MAX} more: open a computer in the sidebar.</p>}
        {one.data && rows.length === 0 && down.length === 0 && (
          <p className="px-2 py-1.5 text-[12.5px] text-fg-faint">Nothing running on {machines.map((m) => m.name).join(', ')}.</p>
        )}
        {down.map(({ m, e }) => <MachineDown key={m.id} m={m} e={e as MachineSessionsEntry} now={now} />)}
      </div>
    </Panel>
  )
}

function MachineDown({ m, e, now }: { m: Machine; e: MachineSessionsEntry; now: number }) {
  const look = machineLook({ ...m, status: e.status as Machine['status'], error: e.error })
  return (
    <a href={`#/m/${m.id}`} data-machine-panel-down={m.id} title={look.detail ?? e.error} className="flex min-w-0 items-center gap-2 rounded-[6px] px-2 py-1.5 text-[12.5px] text-fg-muted hover:bg-panel-2">
      <span aria-hidden className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${look.tone === 'bad' ? 'bg-danger' : 'bg-warn'}`} />
      <span className="shrink-0 text-fg">{m.name}</span>
      <span className="min-w-0 flex-1 truncate">· {look.label}{e.last_ok ? `, last answered ${fmtAgo(e.last_ok, now)}` : ''}</span>
    </a>
  )
}
