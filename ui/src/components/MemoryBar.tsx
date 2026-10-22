/**
 * The machine's memory on the status strip (.ai/04-ui.md § Status strip;
 * owner-approved mockup, 2026-10-22). A user's Mac froze with agents holding
 * all its memory while the strip said only what the agent in front used.
 *
 * - **Normal**: "Mac 9.1/16 GB" and a small green bar.
 * - **Tight** (the OS warns, or 85% is in use): amber, and how much the
 *   agents hold.
 * - **Critical** (the OS says critical, or swap is growing): red, "Memory
 *   low", and a ›.
 *
 * A click opens the popover: who holds the memory, the agents with their
 * state, the other apps using the most, and one button that ends the idle
 * agents Caprock started — the way closing an idle tab ends one, so the
 * conversation is kept. Agents started elsewhere are listed, never ended.
 *
 * The totals come with each `resources` frame; the popover asks
 * GET /v1/system/memory on open and again with each frame while open.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, errText, type SessionSummary } from '@/lib/api'
import { fmtMem, onResources, useMachineMemory } from '@/lib/resources'
import { sessionTitle } from '@/lib/sidebar'
import {
  agentStateText, endIdleLabel, fmtUsedOf, heavyLine, heavyText, levelReason, memoryHeadline, memoryParts, restartFresh, usedPct,
  type MachineMemory, type MemoryAgent, type MemoryReport,
} from '@/lib/memory'
import { CloseIcon } from './AppIcons'

const TONE = {
  normal: { bar: 'bg-ok', text: 'text-fg-muted hover:text-fg' },
  tight: { bar: 'bg-warn', text: 'text-warn' },
  critical: { bar: 'bg-danger', text: 'text-danger' },
} as const

const PART_COLOR = { agents: 'var(--color-accent)', caprock: 'var(--color-merged)', other: 'var(--color-fg-muted)' } as const

/** How many agents the popover lists before "N more". */
export const AGENTS_SHOWN = 5

function MiniBar({ m }: { m: MachineMemory }) {
  return (
    <span aria-hidden data-memory-minibar className="relative h-[4px] w-[30px] overflow-hidden rounded-full bg-[var(--app-hairline-strong)]">
      <span className={`absolute inset-y-0 left-0 rounded-full ${TONE[m.level].bar}`} style={{ width: `${usedPct(m)}%` }} />
    </span>
  )
}

/** The strip's item. `owner` is false on a paired device, which reads the totals and ends nothing. */
export function MemoryBar({ owner, sessions, onOpenSession }: {
  owner: boolean
  sessions?: SessionSummary[]
  onOpenSession?: (id: string) => void
}) {
  const m = useMachineMemory()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: globalThis.MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  if (!m || m.total <= 0) return null
  const why = levelReason(m)
  const title = open ? undefined : [
    `${m.label === 'Memory' ? 'This computer' : m.label}: ${fmtUsedOf(m.used, m.total)} of memory in use${why ? ` — ${why}` : ''}`,
    `Agents ${fmtMem(m.agents)} · Caprock ${fmtMem(m.caprock)} · everything else ${fmtMem(m.other)}`,
    m.swap_used ? `Swap in use: ${fmtMem(m.swap_used)}` : '',
    'Click for who holds it.',
  ].filter(Boolean).join('\n')
  return (
    <span ref={box} className="relative inline-flex">
      <button type="button" data-memory-bar={m.level} aria-haspopup="dialog" aria-expanded={open} title={title}
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-[4px] outline-none focus-visible:ring-1 focus-visible:ring-accent ${TONE[m.level].text}`}>
        {m.level === 'critical' ? (
          <>
            <span className="font-medium">Memory low</span>
            <MiniBar m={m} />
            <span>agents <span className="num">{fmtMem(m.agents)}</span></span>
            <span aria-hidden>›</span>
          </>
        ) : (
          <>
            <span>{m.label} <span className={`num ${m.level === 'normal' ? 'text-fg' : ''}`}>{fmtUsedOf(m.used, m.total)}</span></span>
            <MiniBar m={m} />
            {m.level === 'tight' && <span>agents <span className="num">{fmtMem(m.agents)}</span></span>}
          </>
        )}
      </button>
      {open && <MemoryPopover m={m} owner={owner} sessions={sessions} onOpenSession={onOpenSession} onClose={() => setOpen(false)} />}
    </span>
  )
}

/** The popover above the strip. */
export function MemoryPopover({ m: frame, owner, sessions, onOpenSession, onClose }: {
  m: MachineMemory
  owner: boolean
  sessions?: SessionSummary[]
  onOpenSession?: (id: string) => void
  onClose: () => void
}) {
  const [rep, setRep] = useState<MemoryReport>()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string>()
  const load = useCallback(() => api.systemMemory().then(setRep).catch(() => { /* an older daemon: the frame's totals stand */ }), [])
  useEffect(() => {
    void load()
    return onResources(() => { void load() })
  }, [load])
  const m = rep?.memory ?? frame
  const names = useMemo(() => new Map((sessions ?? []).map((s) => [s.session_id, sessionTitle(s)])), [sessions])
  const byId = useMemo(() => new Map((sessions ?? []).map((s) => [s.session_id, s])), [sessions])
  const [restarting, setRestarting] = useState<string>()
  const restart = async (a: MemoryAgent) => {
    setRestarting(a.session_id)
    setNote(undefined)
    try {
      const id = await restartFresh(a.session_id, byId.get(a.session_id)?.cwd)
      setNote(`Restarted ${names.get(a.session_id) ?? 'the agent'} fresh; the conversation carries on.`)
      await load()
      onOpenSession?.(id)
    } catch (e) {
      setNote(errText(e))
    } finally {
      setRestarting(undefined)
    }
  }
  const now = rep?.at ?? Date.now()
  const agents = rep?.agents ?? []
  const shown = agents.slice(0, AGENTS_SHOWN)
  const more = agents.length - shown.length
  const offer = rep?.idle_end
  const elsewhere = agents.some((a) => !a.owned)
  const end = async () => {
    if (!offer || offer.count === 0) return
    setBusy(true)
    setNote(undefined)
    try {
      const r = await api.endIdleAgents(offer.session_ids)
      const n = r.ended.length
      const left = r.skipped?.length ?? 0
      setNote(`${n === 0 ? 'Nothing was ended' : `Ended ${n} ${n === 1 ? 'agent' : 'agents'}`}${left ? `; ${left} had started working again and ${left === 1 ? 'was' : 'were'} left alone` : ''}.`)
      await load()
    } catch (e) {
      setNote(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const parts = memoryParts(m)
  return (
    <div role="dialog" aria-label="Memory" data-memory-popover={m.level}
      className="fixed bottom-[30px] right-3 z-40 grid max-h-[calc(100vh-60px)] w-[min(360px,calc(100vw-24px))] gap-3 overflow-y-auto rounded-[10px] border border-border-strong bg-panel p-3 text-[11.5px] text-fg shadow-lg">
      <div className="flex items-start gap-2">
        <div className="grid flex-1 gap-0.5">
          <span data-memory-headline className={`text-[13px] font-semibold ${m.level === 'critical' ? 'text-danger' : m.level === 'tight' ? 'text-warn' : ''}`}>{memoryHeadline(m)}</span>
          <span className="text-fg-muted">
            <span className="num text-fg">{fmtUsedOf(m.used, m.total)}</span> in use
            {m.swap_used ? <> · swapping <span className="num text-fg">{fmtMem(m.swap_used)}</span></> : null}
            {m.simulated && <span className="text-fg-faint"> · pressure simulated</span>}
          </span>
        </div>
        <button type="button" aria-label="Close" title="Close (Esc)" onClick={onClose}
          className="-mr-1 grid h-6 w-6 place-items-center rounded-md text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">
          <CloseIcon size={13} />
        </button>
      </div>

      <section aria-label="Who holds it" className="grid gap-1.5">
        <div data-memory-stack className="flex h-[8px] w-full overflow-hidden rounded-full bg-[var(--app-hairline-strong)]">
          {parts.map((p) => p.pct > 0 && (
            <span key={p.key} data-part={p.key} style={{ width: `${p.pct}%`, background: PART_COLOR[p.key] }} className="h-full" />
          ))}
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-[2px]">
          {parts.map((p) => (
            <div key={p.key} className="contents">
              <span className="flex min-w-0 items-center gap-1.5 truncate text-fg-muted">
                <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-[2px]" style={{ background: PART_COLOR[p.key] }} />
                {p.label}
              </span>
              <span className="num text-right text-fg">{fmtMem(p.bytes)}</span>
            </div>
          ))}
        </div>
      </section>

      {shown.length > 0 && (
        <section aria-label="Agents" className="grid gap-1">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-faint">Agents</div>
          <ul className="grid gap-px">
            {shown.map((a) => (
              <li key={a.session_id}>
                <button type="button" data-memory-agent={a.session_id} disabled={!onOpenSession}
                  onClick={() => { onClose(); onOpenSession?.(a.session_id) }}
                  title={`${a.procs} ${a.procs === 1 ? 'process' : 'processes'}${a.owned ? '' : ' · started outside Caprock: never ended from here'}`}
                  className="grid w-full grid-cols-[minmax(0,1fr)_auto_4rem] items-baseline gap-x-2 rounded-[5px] px-1 py-[3px] text-left hover:bg-[var(--app-row-hover)] disabled:cursor-default disabled:hover:bg-transparent">
                  <span className="min-w-0 truncate text-fg">
                    {names.get(a.session_id) ?? `pid ${a.pid}`}
                    {!a.owned && <span className="text-fg-faint"> · elsewhere</span>}
                  </span>
                  <span className={a.state === 'working' ? 'text-ok' : a.state === 'waiting' ? 'text-warn' : 'text-fg-muted'}>{agentStateText(a, now)}</span>
                  <span className="num text-right text-fg-muted">{fmtMem(a.mem_bytes)}</span>
                </button>
                {a.heavy && (
                  <div data-memory-heavy={a.heavy} className="grid gap-1 px-1 pb-1">
                    <span className="text-danger">{heavyText(a.heavy, a.max_proc_bytes)}</span>
                    {a.owned && <span className="text-fg-faint">{heavyLine(byId.get(a.session_id)?.agent)}</span>}
                    {owner && a.owned && (
                      <button type="button" data-restart-fresh={a.session_id} disabled={!a.restartable || restarting !== undefined}
                        title={a.restartable ? undefined : 'It is working; restart it once its turn ends.'}
                        onClick={() => void restart(a)}
                        className="justify-self-start rounded-[6px] border border-[var(--app-hairline-strong)] px-2 py-[2px] text-[11.5px] text-fg hover:border-accent disabled:opacity-50">
                        {restarting === a.session_id ? 'Restarting…' : 'Restart it fresh'}
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {more > 0 && <p data-memory-more className="px-1 text-fg-faint">{more} more</p>}
        </section>
      )}

      {rep?.apps && rep.apps.length > 0 && (
        <section aria-label="Other apps" className="grid gap-1">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-faint">Other apps</div>
          <ul className="grid gap-px">
            {rep.apps.map((a) => (
              <li key={a.name} data-memory-app className="grid grid-cols-[minmax(0,1fr)_4rem] items-baseline gap-x-2 px-1 py-[2px]"
                title={`${a.procs} ${a.procs === 1 ? 'process' : 'processes'}`}>
                <span className="min-w-0 truncate text-fg">{a.name}</span>
                <span className="num text-right text-fg-muted">{fmtMem(a.mem_bytes)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {owner && offer && offer.count > 0 && (
        <div className="grid gap-1.5">
          <button type="button" data-end-idle disabled={busy} onClick={() => void end()}
            className="min-h-[30px] rounded-[7px] bg-accent px-3 text-[12.5px] font-medium text-bg hover:brightness-110 disabled:opacity-50">
            {busy ? 'Ending…' : endIdleLabel(offer.count, offer.mem_bytes)}
          </button>
          <p className="text-fg-faint">Ending keeps their conversations; Continue picks them up later.</p>
        </div>
      )}
      {elsewhere && <p className="text-fg-faint">Agents started outside Caprock are listed but never ended from here.</p>}
      {note && <p role="status" data-memory-note className="text-fg-muted">{note}</p>}
    </div>
  )
}
