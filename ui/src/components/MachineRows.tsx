/**
 * The sidebar's other computers (ADR-067), under the projects.
 *
 * - **None linked:** one quiet row, **+ Add a machine**, opening Settings →
 *   Computers with the steps for the other computer (the owner's install
 *   hook, 2026-10-15). No badge, no count, no modal.
 * - **Linked:** a Computers heading, each computer by its name here with its
 *   state when it is not simply reachable, and under it the sessions running
 *   there, each tagged by that computer: a row opens the session through
 *   `/v1/m/{id}/…` (#/m/<id>/session/<sid>, screens/Machine).
 *
 * Their sessions are read while the window is in view (lib/machines.ts
 * useMachineSessions), so a computer's channel is up while the app shows it
 * and closes 90 s after it does not.
 */
import { machineLook, useMachineSessions, useMachines, type Machine, type MachineSessions } from '@/lib/machines'
import { useRoute, type SettingsSection } from '@/lib/router'
import { PlusIcon } from './AppIcons'

/** How many of a computer's running sessions the sidebar lists; the rest are a click away. */
export const MACHINE_ROWS_MAX = 6

export function MachineRows({ onOpen, onSettingsSection, dashboardActive }: {
  onOpen: (hash: string) => void
  onSettingsSection?: (section: SettingsSection) => void
  dashboardActive: boolean
}) {
  const list = useMachines()
  const machines = list.data
  const sessions = useMachineSessions(machines)
  const route = useRoute()
  if (!machines) return null
  if (machines.length === 0) {
    return (
      <button
        type="button"
        data-nav-row
        data-add-machine
        onClick={() => (onSettingsSection ? onSettingsSection('computers') : onOpen('#/settings/computers'))}
        title="Reach the sessions on your other computers from here: Settings → Computers"
        className="mt-2 flex h-[26px] w-full items-center gap-2 rounded-[6px] pl-2.5 pr-2 text-left text-[12px] text-fg-faint hover:bg-[var(--app-row-hover)] hover:text-fg-muted"
      >
        <PlusIcon size={13} />
        <span className="flex-1">Add a machine</span>
      </button>
    )
  }
  const at = dashboardActive && route.name === 'machine' ? route : undefined
  return (
    <div data-machine-rows className="mt-2">
      <div className="flex h-[28px] items-center gap-1.5 px-2 pt-1.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.07em] text-fg-faint">Computers</h2>
      </div>
      <ul className="grid grid-cols-1 gap-px">
        {machines.map((m) => (
          <MachineRow key={m.id} m={m} read={sessions.get(m.id)} onOpen={onOpen} activeMachine={at?.id === m.id && !at.session} activeSession={at?.id === m.id ? at.session : undefined} />
        ))}
      </ul>
    </div>
  )
}

function MachineRow({ m, read, onOpen, activeMachine, activeSession }: { m: Machine; read?: MachineSessions; onOpen: (hash: string) => void; activeMachine: boolean; activeSession?: string }) {
  const look = machineLook(m)
  // What the proxy said last outranks the list's state: it was asked later.
  const failed = read?.status === 'offline' || read?.status === 'revoked' || read?.status === 'refused' ? read.status : ''
  const state = failed === 'offline' ? 'offline' : failed === 'revoked' ? 'removed there' : failed === 'refused' ? 'refused' : look.tone === 'ok' || look.tone === 'muted' ? '' : look.label
  const dot = failed || look.tone === 'bad' ? 'bg-danger' : look.tone === 'warn' ? 'bg-warn' : (read?.sessions.length ?? 0) > 0 ? 'bg-ok' : 'bg-fg-faint'
  const running = (read?.sessions ?? []).filter((s) => s.status !== 'ended')
  return (
    <li data-machine-row={m.id}>
      <button
        type="button"
        data-nav-row
        aria-current={activeMachine ? 'true' : undefined}
        onClick={() => onOpen(`#/m/${m.id}`)}
        title={look.detail ? `${m.name}: ${look.label}. ${look.detail}` : `${m.name}: its sessions`}
        className={`app-row flex h-[32px] w-full min-w-0 items-center gap-2 rounded-[7px] pl-2.5 pr-2 text-left text-[13px] ${activeMachine ? 'app-row-selected' : ''}`}
      >
        <span aria-hidden className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${dot}`} />
        <span className="min-w-0 flex-1 truncate text-fg">{m.name}</span>
        {state ? <span className="shrink-0 text-[11px] text-fg-faint" data-machine-row-state>{state}</span>
          : running.length > 0 && <span className="num shrink-0 text-[11.5px] text-fg-faint">{running.length}</span>}
      </button>
      {running.length > 0 && (
        <ul className="grid grid-cols-1 gap-px" aria-label={`Sessions on ${m.name}`}>
          {running.slice(0, MACHINE_ROWS_MAX).map((s) => {
            const title = s.name || s.title || s.project || 'session'
            const active = activeSession === s.session_id
            return (
              <li key={s.session_id}>
                <button
                  type="button"
                  data-nav-row
                  data-machine-session-row={s.session_id}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => onOpen(`#/m/${m.id}/session/${encodeURIComponent(s.session_id)}`)}
                  title={`${title} — on ${m.name}, in ${s.cwd}`}
                  className={`app-row flex h-[30px] w-full min-w-0 items-center gap-2 rounded-[7px] pl-[22px] pr-2 text-left text-[12.5px] ${active ? 'app-row-selected' : ''}`}
                >
                  <span aria-hidden className={`inline-block h-[6px] w-[6px] shrink-0 rounded-full ${s.status === 'active' ? 'bg-ok' : 'bg-warn'}`} />
                  <span className="min-w-0 flex-1 truncate text-fg">{title}</span>
                  {/* The tag: which computer it runs on, so it never reads as this one's. */}
                  <span className="max-w-[40%] shrink-0 truncate rounded-[4px] border border-[var(--app-hairline-strong)] px-1 text-[10.5px] text-fg-faint" data-machine-tag>{m.name}</span>
                </button>
              </li>
            )
          })}
          {running.length > MACHINE_ROWS_MAX && (
            <li>
              <button type="button" data-nav-row onClick={() => onOpen(`#/m/${m.id}`)} className="flex h-[24px] w-full items-center rounded-[6px] pl-[22px] pr-2 text-left text-[11.5px] text-fg-faint hover:bg-[var(--app-row-hover)] hover:text-fg-muted">
                {running.length - MACHINE_ROWS_MAX} more on {m.name}
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  )
}
