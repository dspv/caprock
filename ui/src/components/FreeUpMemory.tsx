/**
 * Free up memory (.ai/04-ui.md § Free up memory; owner, 2026-10-25: "a
 * button: clean everything that can be cleaned and is safe", and "I want it
 * fully safe and to understand it", translated). The one component both
 * Caprock resources and the memory popover show, so the two can never say
 * different things: a button with what it frees, and on a click an inline
 * confirmation in two groups — Leftovers and Idle agents — each line with
 * its own checkbox and size, the total following the ticks.
 *
 * Nothing is stopped or ended before the confirmation's own button, and the
 * daemon judges each again then (lib/freeup.ts). Absent on a paired device.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, errText, type SessionSummary } from '@/lib/api'
import type { Footprint } from '@/lib/footprint'
import type { MemoryReport } from '@/lib/memory'
import { fmtMem } from '@/lib/resources'
import { AGENTS_LINE, WHAT_HAPPENS, confirmLabel, freeUpLabel, freeUpPlan, heldLine, resultNote, type FreeUpItem, type FreeUpPlan } from '@/lib/freeup'

const PRIMARY = 'min-h-[2.3em] shrink-0 rounded-[7px] bg-accent px-3 font-medium text-bg hover:brightness-110 disabled:opacity-50'
const BUTTON = 'min-h-[2.3em] shrink-0 rounded-[7px] border border-[var(--app-hairline-strong)] px-3 text-fg hover:border-accent disabled:opacity-50'

/**
 * `footprint` and `memory` are the screen's own answers when it has them
 * (the doctor's scan, the popover's list); the component asks for whichever
 * is missing. `front` is the session whose tab is in front: never offered.
 */
export function FreeUpMemory({ footprint, memory, front, sessions, onDone }: {
  footprint?: Footprint
  memory?: MemoryReport
  front?: string
  sessions?: SessionSummary[]
  /** After a free-up: the screen asks its own figures again. */
  onDone?: () => void
}) {
  const scanned = footprint?.orphans?.scanned ? footprint : undefined
  const [ownFp, setOwnFp] = useState<Footprint>()
  const [ownMem, setOwnMem] = useState<MemoryReport>()
  // Answered, or failed: the button waits for both, so a click never
  // reviews half the list.
  const [fpAsked, setFpAsked] = useState(false)
  const [memAsked, setMemAsked] = useState(false)
  const needFp = !scanned
  const needMem = !memory
  const load = useCallback(async () => {
    await Promise.all([
      needFp ? api.footprint(true).then(setOwnFp, () => { /* an older daemon: no leftovers */ }).finally(() => setFpAsked(true)) : undefined,
      needMem ? api.systemMemory(front).then(setOwnMem, () => { /* an older daemon: no agents */ }).finally(() => setMemAsked(true)) : undefined,
    ])
  }, [needFp, needMem, front])
  useEffect(() => { void load() }, [load])
  const f = scanned ?? ownFp
  const m = memory ?? ownMem
  const plan = useMemo(() => freeUpPlan(f, m, sessions), [f, m, sessions])
  // What the person reviews is what was offered when they opened it.
  const [open, setOpen] = useState<FreeUpPlan>()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string>()
  const ready = (!needFp || fpAsked) && (!needMem || memAsked)
  if (!ready || !(f || m)) return null
  const total = plan.leftovers.length + plan.agents.length
  const anything = total > 0 || plan.kept.length > 0 || plan.held.length > 0

  const run = async (picked: FreeUpItem[]) => {
    setBusy(true)
    setNote(undefined)
    try {
      const orphans = picked.flatMap((x) => (x.orphan ? [x.orphan] : []))
      const agents = picked.flatMap((x) => (x.agent ? [x.agent.session_id] : []))
      const [stop, end] = await Promise.all([
        orphans.length ? api.stopOrphans(orphans.map((o) => ({ pid: o.pid, started_at: o.started_at })), false, true) : undefined,
        agents.length ? api.endIdleAgents(agents, front) : undefined,
      ])
      setNote(resultNote(picked, stop, end))
      setOpen(undefined)
      await load()
      onDone?.()
    } catch (e) {
      setNote(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-free-up-box className="flex flex-col gap-2">
      {!open && (
        total > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" data-free-up className={PRIMARY} disabled={busy} onClick={() => { setNote(undefined); setOpen(plan) }}>
              {freeUpLabel(plan.mem_bytes)}
            </button>
            <span className="text-[0.9em] text-fg-muted">Review before anything stops.</span>
          </div>
        ) : (
          <p data-free-up-none className="text-[0.92em] text-fg-muted">
            Nothing safe to free up right now.
            {anything && <> <button type="button" data-free-up-why className="text-fg-muted underline decoration-dotted underline-offset-2 hover:text-accent" onClick={() => { setNote(undefined); setOpen(plan) }}>Why</button></>}
          </p>
        )
      )}
      {open && <FreeUpConfirm plan={open} busy={busy} onRun={(xs) => void run(xs)} onCancel={() => setOpen(undefined)} />}
      {note && <p role="status" data-free-up-note className="text-[0.92em] text-fg-muted">{note}</p>}
    </div>
  )
}

/** The inline confirmation: two groups, a checkbox and a size per line, the total following the ticks. */
function FreeUpConfirm({ plan, busy, onRun, onCancel }: {
  plan: FreeUpPlan
  busy: boolean
  onRun: (xs: FreeUpItem[]) => void
  onCancel: () => void
}) {
  const items = [...plan.leftovers, ...plan.agents]
  const [picked, setPicked] = useState<Set<string>>(() => new Set(items.map((x) => x.key)))
  const chosen = items.filter((x) => picked.has(x.key))
  const bytes = chosen.reduce((s, x) => s + x.mem_bytes, 0)
  const toggle = (key: string) => setPicked((s) => {
    const n = new Set(s)
    if (n.has(key)) n.delete(key)
    else n.add(key)
    return n
  })
  return (
    <div role="alertdialog" aria-label="Free up memory" data-free-up-confirm
      onKeyDown={(e) => { if (e.code === 'Escape') { e.stopPropagation(); onCancel() } }}
      className="flex flex-col gap-2.5 rounded-[8px] border border-[var(--app-hairline-strong)] bg-[var(--app-hairline)] px-2.5 py-2">
      <p data-free-up-what className="text-fg">{WHAT_HAPPENS} <span className="text-fg-muted">Untick anything you want to keep.</span></p>
      <Group id="leftovers" title="Leftovers" items={plan.leftovers} picked={picked} busy={busy} onToggle={toggle}
        line="Nothing uses these: test copies whose agent has finished, commands whose window or script closed, finished sessions."
        foot={plan.held.length > 0 ? heldLine(plan.held) : undefined} />
      <Group id="agents" title="Idle agents" items={plan.agents} picked={picked} busy={busy} onToggle={toggle} line={AGENTS_LINE}>
        {plan.kept.length > 0 && (
          <div data-free-up-kept className="flex flex-col gap-0.5 text-[0.92em]">
            <span className="text-fg-faint">Kept running:</span>
            <ul className="flex flex-col gap-0.5">
              {plan.kept.slice(0, KEPT_SHOWN).map((k) => (
                <li key={k.session_id} data-free-up-kept-agent={k.session_id} className="flex min-w-0 gap-1.5 pl-[1.4em]">
                  <span className="min-w-0 truncate text-fg-muted">{k.name}</span>
                  <span className="shrink-0 text-fg-faint">· {k.why}</span>
                </li>
              ))}
            </ul>
            {plan.kept.length > KEPT_SHOWN && <span className="pl-[1.4em] text-fg-faint">{plan.kept.length - KEPT_SHOWN} more kept</span>}
          </div>
        )}
      </Group>
      <p className="text-[0.92em] text-fg-faint">Agents started outside Caprock are never ended from here.</p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" data-free-up-yes autoFocus className={PRIMARY} disabled={busy || chosen.length === 0} onClick={() => onRun(chosen)}>
          {busy ? 'Freeing…' : confirmLabel(chosen.length, bytes)}
        </button>
        <button type="button" data-free-up-no className={BUTTON} disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

/** How many kept agents the confirmation names before "N more kept". */
export const KEPT_SHOWN = 5

function Group({ id, title, items, picked, busy, line, foot, onToggle, children }: {
  id: 'leftovers' | 'agents'
  title: string
  items: FreeUpItem[]
  picked: Set<string>
  busy: boolean
  line: string
  foot?: string
  onToggle: (key: string) => void
  children?: ReactNode
}) {
  const ticked = items.filter((x) => picked.has(x.key))
  const bytes = ticked.reduce((s, x) => s + x.mem_bytes, 0)
  if (!items.length && !foot && !children) return null
  return (
    <section data-free-up-group={id} aria-label={title} className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 border-b border-[var(--app-hairline-strong)] pb-0.5">
        <span className="text-[0.75em] font-semibold uppercase tracking-[0.07em] text-fg-faint">{title}{items.length > 0 && <span className="num"> · {ticked.length} of {items.length}</span>}</span>
        {items.length > 0 && <span data-free-up-group-total className="num text-[0.92em] text-fg-muted">{fmtMem(bytes)}</span>}
      </div>
      <p className="text-[0.92em] text-fg-muted">{items.length ? line : id === 'agents' ? 'No idle agent to end.' : 'No leftovers.'}</p>
      {items.length > 0 && (
        <ul className="flex flex-col gap-1">
          {items.map((x) => (
            <li key={x.key}>
              <label className="flex cursor-pointer items-start gap-2">
                <input type="checkbox" data-free-up-pick={x.key} checked={picked.has(x.key)} onChange={() => onToggle(x.key)} disabled={busy}
                  className="mt-[0.2em] h-3.5 w-3.5 shrink-0 accent-accent" />
                <span className="min-w-0 flex-1">
                  <span className="text-fg">{x.name}</span>
                  <span className="text-fg-faint"> · {x.detail}</span>
                </span>
                <span className="num shrink-0 text-fg-muted">{fmtMem(x.mem_bytes)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {foot && <p data-free-up-held className="text-[0.92em] text-fg-faint">{foot}</p>}
      {children}
    </section>
  )
}
