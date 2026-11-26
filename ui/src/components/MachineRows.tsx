/**
 * The sidebar's other computers (ADR-067), under the projects.
 *
 * - **None linked:** one quiet row, **+ Add a machine**, opening Settings →
 *   Computers with the steps for the other computer (the owner's install
 *   hook, 2026-10-15). No badge, no count, no modal.
 * - **Linked:** a Computers heading with **All N**, opening All computers
 *   (`#/m`); each computer on two lines — a status dot, its name and how many
 *   run there in an accent badge, then *macOS · 36 GB · 2 running* (its setup
 *   check and resource report, lib/machinespec.ts) or *offline · seen 3d
 *   ago*, greyed — and under it the sessions running there, each tagged by
 *   that computer: a row opens the session through `/v1/m/{id}/…`
 *   (#/m/<id>/session/<sid>, screens/Machine).
 *
 * A computer's row has the sidebar's row menu (right-click, Shift+F10 or the
 * context-menu key): **Open** and **Rename**, renamed in place with `PATCH
 * /v1/machines/{id}` — the owner could not rename one from here in his first
 * two-computer test (2026-11-20).
 *
 * Their sessions are the one list (lib/machines.ts useMachineSessions, GET
 * /v1/machines/sessions), read while the window is in view and again when
 * the daemon says one of them changed; a session there that needs its owner
 * sorts first with the warn dot and the reason, as one here does.
 */
import { useState } from 'react'
import { errText } from '@/lib/api'
import { machineLook, machinesApi, useMachineSessions, useMachines, type Machine, type MachineSessions } from '@/lib/machines'
import { machineLine, machineState, stateStatus, useMachineSpec } from '@/lib/machinespec'
import { remoteSteps, stepCounts } from '@/lib/remotesetup'
import { useNow } from '@/lib/useNow'
import { useRoute, type SettingsSection } from '@/lib/router'
import { needLabel, needsYou, oldestFirst } from '@/lib/needs'
import { ExternalIcon, PencilIcon, PlusIcon } from './AppIcons'
import { MenuBox, MenuItem, type MenuAt } from './RowMenu'

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
  const allOn = dashboardActive && route.name === 'machines'
  return (
    <div data-machine-rows className="mt-2">
      <div className="flex h-[28px] items-center gap-1.5 px-2 pt-1.5">
        <h2 className="flex-1 text-[11px] font-semibold uppercase tracking-[0.07em] text-fg-faint">Computers</h2>
        <button
          type="button"
          data-machines-all
          aria-current={allOn ? 'true' : undefined}
          onClick={() => onOpen('#/m')}
          title="All computers: one card each"
          className={`rounded-[4px] px-1 text-[12px] tabular-nums hover:underline ${allOn ? 'text-accent-strong' : 'text-accent'}`}
        >
          All {machines.length}
        </button>
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
  const now = useNow(60_000)
  // One word for how it stands, the same as its page and its card say
  // (machineState): online or offline is the channel's, never a failed read's.
  const st = machineState(m, read)
  const look = machineLook({ ...m, status: stateStatus(m, read, st) })
  const state = st.offline || look.tone === 'ok' || look.tone === 'muted' ? '' : look.label
  // Online green, offline greyed, a state that needs something in its tone.
  const dot = st.offline ? 'bg-fg-faint opacity-60' : look.tone === 'bad' ? 'bg-danger' : look.tone === 'warn' ? 'bg-warn' : st.online ? 'bg-ok' : 'bg-fg-faint'
  const spec = useMachineSpec(m.id, !st.down, 120_000)
  const live = (read?.sessions ?? []).filter((s) => s.status !== 'ended')
  // Needing you first, oldest first, as this machine's own rows (lib/needs).
  const waiting = oldestFirst(live.filter((s) => needsYou(s)))
  const running = [...waiting, ...live.filter((s) => !needsYou(s))]
  const line = machineLine({ offline: st.offline, state, lastSeen: m.last_seen, spec: spec.data, running: running.length, now })
  // Steps its page's *Set up this computer* still lists (#1088), from the
  // same read: said in amber when nothing else is.
  const toSetUp = st.online ? stepCounts(remoteSteps(spec.data?.setup, m.setup_done)).left : 0
  const [menu, setMenu] = useState<MenuAt | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(m.name)
  const [err, setErr] = useState('')
  const rename = async () => {
    const n = name.trim()
    setRenaming(false)
    if (!n || n === m.name) { setName(m.name); return }
    try { await machinesApi.rename(m.id, n); setErr('') } catch (e) { setErr(errText(e)); setName(m.name) }
  }
  return (
    <li data-machine-row={m.id}>
      {renaming ? (
        <div className="flex h-[32px] items-center gap-2 pl-2.5 pr-2">
          <span aria-hidden className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${dot}`} />
          <input
            autoFocus
            aria-label="Computer name"
            data-machine-rename
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void rename() }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setName(m.name); setRenaming(false) }
            }}
            className="min-w-0 flex-1 rounded-sm border border-accent bg-bg px-1.5 py-0.5 text-[13px] text-fg focus:outline-none"
          />
        </div>
      ) : (
      <button
        type="button"
        data-nav-row
        aria-current={activeMachine ? 'true' : undefined}
        aria-haspopup="menu"
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }) }}
        onKeyDown={(e) => {
          if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault()
            const r = e.currentTarget.getBoundingClientRect()
            setMenu({ x: r.left + 12, y: r.bottom })
          }
        }}
        onClick={() => onOpen(`#/m/${m.id}`)}
        title={look.detail ? `${m.name}: ${look.label}. ${look.detail}` : `${m.name}: its sessions`}
        className={`app-row grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 rounded-[7px] py-1 pl-2.5 pr-2 text-left ${activeMachine ? 'app-row-selected' : ''}`}
      >
        <span aria-hidden className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${dot}`} />
        <span className={`min-w-0 truncate text-[13px] ${st.offline ? 'text-fg-faint' : 'text-fg'}`}>{m.name}</span>
        {waiting.length > 0 ? <span className="shrink-0 text-[11px] text-warn" data-machine-row-waiting>{waiting.length} need{waiting.length === 1 ? 's' : ''} you</span>
          : running.length > 0 && !st.down ? <span className="num shrink-0 rounded-[9px] bg-accent px-1.5 text-[11px] font-medium leading-[17px] text-panel" data-machine-row-count>{running.length}</span>
            : toSetUp > 0 ? <span className="shrink-0 text-[11px] text-warn" data-machine-row-setup>{toSetUp} to set up</span>
              : <span />}
        <span className={`tabular-nums col-start-2 col-end-4 min-w-0 truncate text-[11.5px] ${state ? 'text-fg-muted' : 'text-fg-faint'}`} data-machine-row-line {...(state || st.offline ? { 'data-machine-row-state': '' } : {})}>{line}</span>
      </button>
      )}
      {err && <div role="alert" className="pl-[22px] pr-2 text-[11px] text-danger">{err}</div>}
      {menu && (
        <MenuBox at={menu} label={`${m.name} menu`} onClose={() => setMenu(null)}>
          <MenuItem icon={<ExternalIcon size={13} />} label="Open" onClick={() => { setMenu(null); onOpen(`#/m/${m.id}`) }} />
          <MenuItem icon={<PencilIcon size={13} />} label="Rename" onClick={() => { setMenu(null); setName(m.name); setRenaming(true) }} />
        </MenuBox>
      )}
      {running.length > 0 && (
        <ul className="grid grid-cols-1 gap-px" aria-label={`Sessions on ${m.name}`}>
          {running.slice(0, MACHINE_ROWS_MAX).map((s) => {
            const title = s.name || s.title || s.project || 'session'
            const active = activeSession === s.session_id
            const waits = needsYou(s)
            const why = waits ? needLabel(s.activity?.need) || 'needs you' : ''
            return (
              <li key={s.session_id}>
                <button
                  type="button"
                  data-nav-row
                  data-machine-session-row={s.session_id}
                  data-needs-you={waits ? '' : undefined}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => onOpen(`#/m/${m.id}/session/${encodeURIComponent(s.session_id)}`)}
                  title={`${title} — on ${m.name}, in ${s.cwd}${why ? ` · needs you: ${why}` : ''}`}
                  className={`app-row flex h-[30px] w-full min-w-0 items-center gap-2 rounded-[7px] pl-[22px] pr-2 text-left text-[12.5px] ${active ? 'app-row-selected' : ''}`}
                >
                  <span aria-hidden className={`inline-block h-[6px] w-[6px] shrink-0 rounded-full ${waits ? 'bg-warn app-ring' : s.status === 'active' ? 'bg-ok' : 'bg-fg-faint'}`} />
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
