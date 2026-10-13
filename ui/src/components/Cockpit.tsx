/**
 * The agent cockpit (.ai/21-app.md § Agent cockpit): the inspector as it reads
 * beside an agent's terminal. What only Caprock knows about the session in
 * front — what it has cost and what each call costs now, how full its context
 * is, what it is doing this second, what it did a moment ago and how long each
 * step took, how much of the plan is left, and whether it is going round in
 * circles.
 *
 * Every figure is the daemon's: the session row the sidebar already polls,
 * the session's own events (fetched once, then followed on the live socket),
 * and the day's summary for the plan windows. Nothing here is estimated, and a
 * figure an agent does not report is left out rather than drawn as a zero.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react'
import { api, type Event, type Permission, type RateWindow, type SessionSummary, type Subagent, type SubagentsNow, type Summary } from '@/lib/api'
import { usePermission } from './PermissionPrompt'
import { live } from '@/lib/live'
import { useSessionEvents } from '@/lib/sessionEvents'
import { fmtAgo, fmtPct, fmtTokens, fmtUSD } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { countdown, resetClock } from '@/lib/limitclock'
import { readWindow } from './PlanLimits'
import { PlanChip } from './PlanPicker'
import { useSessionPlan, windowsOf, type SessionPlan } from './AccountPlan'
import { WINDOW_MS, pace } from '@/lib/pace'
import { SpendChart, SpendOverTime } from './SpendScrub'
import { callsFromEvents } from '@/lib/scrub'
import { everyWhileVisible } from '@/lib/visible'
import { HEADLINES, METRICS, SPEND_PERIODS, foldedLine, metricTitle, metricValue, periodFigures, periodScope, pickHero, pickSlot, setSpendPrefs, shownSlots, spendFigures, useSpendPrefs, type Metric, type PeriodFigures, type SpendFigures, type SpendPeriod, type SpendView } from '@/lib/spendview'
import { AgentCharacter, agentName, characterFor } from './Characters'
import { SubscriptionTag } from './SubscriptionPicker'
import { TodoBlock } from './SessionTodos'
import { PermissionModeChip } from './PermissionModeChip'
import { KindIcon } from './KindIcon'
import { SubagentDetail } from './SubagentDetail'
import {
  askLine, backgroundAgents, chipGroups, chipGroupsThatFit, subagentChips, subagentDoing, subagentInitial, subagentTone, CHIP_GROUP, MAX_SUBAGENT_CHIPS, backgroundLabel, cockpitState, commandGist, fmtRun, planWindowsFor, requester, runningTool, runShare, runVerb, subagentWaiting, toolKind, toolRuns,
  type CockpitState, type SubagentChip, type ToolRun,
} from '@/lib/cockpit'

const TIMELINE_ROWS = 7
const SUBAGENT_ROWS = 5
/** How many finished subagents "+N finished", opened, asks the daemon for. */
const FINISHED_OPEN = 30
/** The subagent list is read again at most this often while their events stream in. */
const SUBAGENTS_THROTTLE_MS = 2_000
/** …and this often regardless, so a finished or silent one drops off. */
const SUBAGENTS_POLL_MS = 20_000

/**
 * The subagents working in the session, as the daemon sums them up
 * (`/subagents`): read on open, again at most every two seconds while their
 * events stream in on the live socket, and every twenty seconds so one that
 * finished drops off. The daemon does the counting; thousands of subagent
 * events never reach the page.
 */
export function useSubagents(sessionId: string, enabled: boolean, recent = 0): SubagentsNow | undefined {
  const [data, setData] = useState<SubagentsNow | undefined>(undefined)
  const [tick, setTick] = useState(0)
  const last = useRef(0)
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    last.current = Date.now()
    api.subagents(sessionId, recent)
      .then((r) => { if (alive && r && Array.isArray(r.working)) setData(r) })
      .catch(() => { /* an older daemon: no section */ })
    return () => { alive = false }
  }, [sessionId, enabled, tick, recent])
  useEffect(() => {
    if (!enabled) return
    const poll = setInterval(() => setTick((t) => t + 1), SUBAGENTS_POLL_MS)
    const off = live.onFrame((f) => {
      if (f.type !== 'event' || f.data.session_id !== sessionId || !f.data.agent_id || pending.current) return
      const wait = Math.max(0, last.current + SUBAGENTS_THROTTLE_MS - Date.now())
      pending.current = setTimeout(() => { pending.current = undefined; setTick((t) => t + 1) }, wait)
    })
    return () => {
      clearInterval(poll)
      off()
      if (pending.current) { clearTimeout(pending.current); pending.current = undefined }
    }
  }, [sessionId, enabled])
  return enabled ? data : undefined
}

const STATE_LABEL: Record<CockpitState, string> = {
  working: 'Working',
  waiting: 'Waiting on you',
  looping: 'Looping?',
  idle: 'Idle',
  ended: 'Ended',
}

const STATE_TEXT: Record<CockpitState, string> = {
  working: 'text-ok',
  waiting: 'text-accent',
  looping: 'text-danger',
  idle: 'text-fg-muted',
  ended: 'text-fg-faint',
}

/** The cockpit's sections below the permission card, in reading order. */
export function Cockpit({ s, sessionId, hasPermission, summary, changes }: {
  s: SessionSummary
  sessionId: string
  hasPermission: boolean
  summary?: Summary
  /** The working tree's changes, drawn by the inspector (it owns the diff fetch). */
  changes?: ReactNode
}) {
  // Held once per session and shared with the session deck (lib/sessionEvents.ts).
  const main = useSessionEvents(sessionId)
  const [permission] = usePermission(sessionId)
  const now = useNow(1000)
  const runs = useMemo(() => toolRuns(main), [main])
  const state = cockpitState(s, hasPermission || !!permission)
  // The subagent row opened in place (one at a time), and whether "+N
  // finished" is open — which asks the daemon for more than three of them.
  const [openSub, setOpenSub] = useState<string | null>(null)
  const [allFinished, setAllFinished] = useState(false)
  const [reveal, setReveal] = useState(0)
  // Claude Code is the agent with subagents Caprock hears from.
  const subs = useSubagents(sessionId, state !== 'ended' && (s.agent ?? 'claude') === 'claude', allFinished ? FINISHED_OPEN : 0)
  const openFromChip = (id: string) => { setOpenSub(id); setReveal((n) => n + 1) }
  const running = state === 'working' || state === 'looping' ? runningTool(runs, now) : undefined
  // A session on one of the user's subscriptions shows that account's
  // windows and plan; the day's summary carries the own sign-in's.
  const acct = useSessionPlan(s.agent, s.subscription)
  const plan = s.subscription ? windowsOf(acct.account) : planWindowsFor(s.agent, summary)
  const calls = useMemo(() => callsFromEvents(main), [main])
  const figures = spendFigures(s, calls)
  // The order is what the people using it look at (owner, 2026-10-12): the
  // agent and its headline figure, what it and its subagents are doing now,
  // its task list, the context, the plan limits; the spend details after,
  // folded until a viewer opens them.
  return (
    <>
      <Hero s={s} sessionId={sessionId} state={state} now={now} background={hasPermission || permission ? 0 : backgroundAgents(s)} subs={subs} permission={permission} figures={figures} onChip={openFromChip} />
      <NowDoing s={s} state={state} running={running} last={runs[runs.length - 1]} permission={permission} background={backgroundAgents(s)} now={now} />
      {s.loop && state !== 'ended' && <LoopWarning s={s} now={now} />}
      {subs && (subs.working.length > 0 || (subs.recent?.length ?? 0) > 0) && (
        <Subagents subs={subs} permission={permission} now={now} sessionId={sessionId} open={openSub} onOpen={setOpenSub}
          allFinished={allFinished} onAllFinished={setAllFinished} reveal={reveal} />
      )}
      <TodoBlock sessionId={sessionId} />
      <ContextMeter s={s} />
      {plan && <PlanWindows limits={plan} agent={s.agent} now={now} acct={acct} />}
      <Spend s={s} sessionId={sessionId} events={main} now={now} figures={figures} summary={summary} />
      <Timeline runs={runs} total={s.stats?.tool_calls} now={now} />
      {changes}
    </>
  )
}

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <h4 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-faint">{children}</h4>
      {right && <div className="ml-auto flex items-baseline gap-2 text-[11.5px]">{right}</div>}
    </div>
  )
}

/**
 * How many chips the hero's one row of subagents holds: as many whole
 * groups of four as its width fits (three in a 324px inspector, five in a
 * 480px one), "+N" after them for the working left out. Measured from the
 * row's width only, never from what it shows, so a subagent starting or
 * finishing never changes the layout; until laid out, three groups.
 */
function useChipRoom(row: RefObject<HTMLDivElement | null>, total: number): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = row.current
    if (!el || typeof ResizeObserver !== 'function') return
    const read = () => { if (el.clientWidth > 0) setWidth(el.clientWidth) }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [row])
  if (!(width > 0)) return 3 * CHIP_GROUP
  const all = chipGroupsThatFit(width, false) * CHIP_GROUP
  return Math.min(MAX_SUBAGENT_CHIPS, total <= all ? all : chipGroupsThatFit(width, true) * CHIP_GROUP)
}

/**
 * The agent, its figures and its subagents, in one grid that never changes
 * shape (owner, 2026-10-13: "restore the awesome look — both when work is
 * going on and when it waits"). Three fixed rows:
 *
 * - **The agent's row**, as tall as the avatar: the character, whose ring
 *   carries the state's colour; the agent, its model on a line of its own
 *   (never cut to make room for the figure), the state line in the same
 *   colour. At its right, in a place of its own, the
 *   headline figure and what it is (owner, 2026-10-12: "put it to the right
 *   of the agent").
 * - **The detail row**: the permission mode and when it started under the
 *   agent's lines, the two smaller figures under the headline, quieter.
 * - **The subagents' row**, one line high: a chip per subagent in groups of
 *   four, or *no subagents running*.
 *
 * A state change recolours the ring, the dot and the state line and changes
 * the chips; nothing moves. A longer figure takes room from the agent's
 * lines, which are left-aligned and cut rather than wrapped; a narrower
 * inspector steps the headline down (.cockpit-hero, a container query).
 */
function Hero({ s, sessionId, state, now, background, subs, permission, figures, onChip }: { s: SessionSummary; sessionId: string; state: CockpitState; now: number; background: number; subs?: SubagentsNow; permission?: Permission | null; figures: SpendFigures; onChip: (id: string) => void }) {
  const since = s.worked_at || s.last_event_at
  const saysBackground = background > 0 && state === 'working'
  const working = subs?.working.length ?? 0
  const chipRow = useRef<HTMLDivElement>(null)
  const room = useChipRoom(chipRow, working + (subs?.recent?.length ?? 0))
  const strip = subagentChips(subs, permission, room)
  const count = working || (strip.chips.length === 0 ? s.live_subagents ?? 0 : 0) || (saysBackground ? background : 0)
  const model = s.model_display || s.model
  const label = saysBackground ? 'Background agents' : STATE_LABEL[state]
  const ago = (state === 'idle' || state === 'ended') && since ? fmtAgo(since, now) : ''
  return (
    <div className="@container min-w-0">
      <div className="cockpit-hero" data-state={state}>
        <div className="cockpit-avatar relative grid place-items-center rounded-[15px] [grid-area:av]" data-state={state}>
          <AgentCharacter who={characterFor(s.agent ?? 'claude')} size={46} className="cockpit-character" />
        </div>
        {/* Name, model, state: three lines, so the model is never cut to
          * make room for the figure at the right (owner, 2026-10-13, picked
          * from three variants). */}
        <div className="grid min-w-0 content-start [grid-area:info]">
          <p className="truncate whitespace-nowrap text-[13px] font-semibold leading-[19px] text-fg">{agentName(s.agent ?? 'claude')}</p>
          {model ? (
            <p data-hero-model className="flex min-w-0 items-baseline whitespace-nowrap text-[12px] leading-[17px] text-fg-muted" title={model}>
              <span className="truncate">{model}</span>
              <SubscriptionTag id={s.subscription} agent={s.agent ?? 'claude'} className="min-w-0 shrink truncate text-[12px] text-fg-muted" />
            </p>
          ) : null}
          <p className={`flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[12.5px] font-medium leading-[19px] ${STATE_TEXT[state]}`} role="status"
            title={saysBackground ? backgroundLabel(background) : undefined}>
            <span className="cockpit-dot inline-block h-[7px] w-[7px] shrink-0 rounded-full" data-state={state} />
            <span className="truncate">{label}{ago ? <span className="font-normal text-fg-faint"> · {ago}</span> : null}</span>
          </p>
        </div>
        {s.stats && <div data-hero-fig className="min-w-0 justify-self-end [grid-area:fig]"><HeadlineFigure figures={figures} /></div>}
        {/* The permission mode, and for a session Caprock started, the way
          * to change it while it runs (ADR-054); then since when it runs. */}
        <div data-hero-meta className="grid min-w-0 content-start gap-[3px] [grid-area:meta]">
          {state !== 'ended' && <p className="flex min-w-0"><PermissionModeChip sessionId={sessionId} agent={s.agent} /></p>}
          {s.started_at > 0 && state !== 'ended' && (
            <p className="truncate text-[11px] leading-[15px] text-fg-faint">started {fmtAgo(s.started_at, now)}</p>
          )}
        </div>
        {s.stats && <div data-hero-sec className="min-w-0 justify-self-end [grid-area:sec]"><HeroSecondaries figures={figures} /></div>}
        {/* Always there, one line high, so nothing above or below it moves
          * when subagents start or finish (owner, 2026-10-13: "fix its
          * position and mark the subagents' place when nothing runs"). */}
        <div ref={chipRow} data-hero-chips className="flex min-w-0 items-center overflow-hidden [grid-area:chips]">
          {count > 0 && state !== 'ended' && (
            <span data-hero-count className="mr-2.5 shrink-0 text-[11px] text-fg-muted" title={`${count} ${count === 1 ? 'subagent' : 'subagents'} working`}>{count} working</span>
          )}
          {strip.chips.length > 0
            ? <SubagentStrip chips={strip.chips} more={strip.more} onChip={onChip} />
            : state !== 'ended' && <span data-hero-nosubs className="text-[11px] text-fg-faint">no subagents running</span>}
        </div>
      </div>
    </div>
  )
}

/**
 * One mini-avatar per subagent on the hero's last row: its type's initial
 * in a tint fixed per type, pulsing while it works, accent while it waits
 * on you, muted once finished. In groups of four on one line, as many
 * groups as fit, then "+N" (owner, 2026-10-12: "why doesn't it show more
 * agents?"). A chip opens its subagent's row in the Subagents section below.
 */
function SubagentStrip({ chips, more, onChip }: { chips: SubagentChip[]; more: number; onChip: (id: string) => void }) {
  const groups = chipGroups(chips)
  return (
    <div role="group" aria-label={`Subagents${more > 0 ? `, and ${more} more working` : ''}`}
      className="flex flex-nowrap items-center gap-x-2 p-[2px]" data-chips={chips.length}>
      {groups.map((g, i) => (
        <span key={i} className="flex shrink-0 gap-[3px]">
          {g.map((c) => (
            <button key={c.id} type="button" title={c.label} aria-label={`${c.label}. Open`} data-state={c.state} data-tone={c.tone}
              onClick={() => onChip(c.id)}
              className="cockpit-subchip num relative grid h-[18px] w-[18px] place-items-center rounded-[5px] text-[10px] font-semibold outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
              {c.initial}
            </button>
          ))}
          {i === groups.length - 1 && more > 0 && (
            <span title={`${more} more working`} className="cockpit-subchip num relative grid h-[18px] min-w-[18px] place-items-center rounded-[5px] px-1 text-[10px] font-medium" data-state="more">+{more}</span>
          )}
        </span>
      ))}
    </div>
  )
}


/** A number that counts up to its new value rather than jumping. */
function useTweened(value: number, ms = 650): number {
  const [shown, setShown] = useState(value)
  const from = useRef(value)
  useEffect(() => {
    const start = from.current
    if (start === value || typeof requestAnimationFrame !== 'function') { from.current = value; setShown(value); return }
    let raf = 0
    const t0 = performance.now()
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms)
      const eased = 1 - Math.pow(1 - k, 3)
      const v = start + (value - start) * eased
      from.current = v
      setShown(v)
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value, ms])
  return shown
}

/** A small menu's housekeeping: closes on a click outside or Escape, and its current choice takes the focus. */
function useMenuDismiss(open: boolean, box: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return
    const onDown = (e: globalThis.MouseEvent) => { if (!box.current?.contains(e.target as Node)) close() }
    const onKey = (e: KeyboardEvent) => { if (e.code === 'Escape') close() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    // The current choice takes the focus, so arrows move from it.
    box.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')?.focus()
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
}

/** ↑/↓ move through a menu's enabled items. */
function onMenuKey(e: ReactKeyboardEvent<HTMLDivElement>) {
  const d = e.code === 'ArrowDown' ? 1 : e.code === 'ArrowUp' ? -1 : 0
  if (!d) return
  e.preventDefault()
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)'))
  const i = items.indexOf(document.activeElement as HTMLButtonElement)
  items[(i + d + items.length) % items.length]?.focus()
}

const HERO_PLACE = ['the big figure', 'the line under it', 'the second line'] as const

/**
 * What one of the three figures beside the agent can show: every metric
 * with its value and what it is. One another figure shows is marked, and
 * picking it swaps the two, so none is shown twice.
 */
function HeroMenu({ slot, hero, figures, label, onPick }: { slot: number; hero: readonly Metric[]; figures: SpendFigures; label: string; onPick: (m: Metric) => void }) {
  return (
    <div role="menu" aria-label={label} onKeyDown={onMenuKey}
      className="absolute right-0 top-full z-30 mt-1 grid w-[min(16rem,calc(100vw-32px))] gap-0.5 rounded-[9px] border border-border-strong bg-panel p-1.5 shadow-lg">
      {HEADLINES.map((h) => {
        const at = hero.indexOf(h.id)
        const other = at >= 0 && at !== slot
        return (
          <button key={h.id} type="button" role="menuitemradio" aria-checked={at === slot} onClick={() => onPick(h.id)}
            title={other ? `Shown as ${HERO_PLACE[at]}: picking it swaps the two` : h.hint}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2 rounded-[6px] px-2 py-1.5 text-left outline-none hover:bg-panel-2 focus-visible:bg-panel-2 aria-checked:bg-accent/10">
            <span className={`truncate text-[13px] ${at === slot ? 'font-semibold text-fg' : 'text-fg'}`}>
              {h.name}{other ? <span className="font-normal text-fg-faint"> · shown</span> : null}
            </span>
            <span className="num text-[12px] text-fg-muted">{metricValue(h.id, figures)}</span>
            <span className="col-span-2 truncate text-[11.5px] text-fg-muted">{h.hint}</span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * The headline figure beside the agent, and what it is: burn rate by default, or
 * whatever the viewer picked from the ▾, remembered per viewer (owner,
 * 2026-10-12: "the number is cool but says nothing; let me switch what
 * matters more to me").
 */
function HeadlineFigure({ figures }: { figures: SpendFigures }) {
  const { hero } = useSpendPrefs()
  const headline = hero[0]!
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const tweened = useTweened(figures.cost)
  const meta = HEADLINES.find((h) => h.id === headline) ?? HEADLINES[0]!
  useMenuDismiss(open, box, () => setOpen(false))
  const value = headline === 'cost' ? fmtUSD(tweened) : metricValue(headline, figures)
  const [num, unit] = value.endsWith('/h') ? [value.slice(0, -2), '/h'] : [value, '']
  const choose = (m: Metric) => { setSpendPrefs({ hero: pickHero(hero, 0, m) }); setOpen(false) }
  return (
    <div ref={box} className="relative grid min-w-0 justify-items-end gap-[5px]" data-headline={headline}>
      <span className="cockpit-hero-num num whitespace-nowrap font-semibold leading-none tracking-[-0.03em] text-fg" data-long={num.length >= 8 ? '' : undefined}
        aria-label={`${meta.name} ${metricValue(headline, figures)}`} title={metricTitle(headline, figures)}>
        {num}{unit && <span className="text-[16px] font-medium text-fg-muted">{unit}</span>}
      </span>
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={`Headline: ${meta.name}. Choose what it shows`}
        onClick={() => setOpen((o) => !o)}
        title="Choose what this figure shows"
        className="-mr-1 inline-flex items-center gap-1 rounded-[5px] px-1 text-[11.5px] leading-[16px] text-fg-faint outline-none hover:bg-panel-2 hover:text-fg-muted focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] aria-expanded:bg-panel-2">
        {meta.name.toLowerCase()}<span aria-hidden className="text-[9px]">▾</span>
      </button>
      {open && <HeroMenu slot={0} hero={hero} figures={figures} label="Headline figure" onPick={choose} />}
    </div>
  )
}

/**
 * The two smaller figures under the headline, one line each in 13px —
 * the value, then a short word for it and a ▾ (*$4.08/h burn ▾*, *4.01B
 * tok ▾*). Moved under the agent, they stand side by side on a row of
 * their own, or stacked at the right of the subagent chips. Each line is its own chooser over the same metrics as the
 * headline, swapping rather than repeating; tokens and cost until a
 * viewer picks, remembered per viewer.
 */
function HeroSecondaries({ figures }: { figures: SpendFigures }) {
  const { hero } = useSpendPrefs()
  const [open, setOpen] = useState<number | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useMenuDismiss(open !== null, box, () => setOpen(null))
  const choose = (i: number, m: Metric) => { setSpendPrefs({ hero: pickHero(hero, i, m) }); setOpen(null) }
  return (
    <div ref={box} className="relative grid justify-items-end gap-[2px]">
      {[1, 2].map((i) => {
        const m = hero[i]!
        const meta = HEADLINES.find((h) => h.id === m)!
        const value = metricValue(m, figures)
        return (
          <button key={i} type="button" data-hero-line={m} aria-haspopup="menu" aria-expanded={open === i}
            aria-label={`${meta.name} ${value}. Choose what this line shows`} title={metricTitle(m, figures)}
            onClick={() => setOpen((o) => (o === i ? null : i))}
            className="-mr-1 inline-flex items-baseline gap-1 whitespace-nowrap rounded-[5px] px-1 text-[13px] leading-[18px] outline-none hover:bg-panel-2 focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] aria-expanded:bg-panel-2">
            <span className="num font-medium text-fg-muted">{value}</span>
            <span className="text-[12px] text-fg-faint">{meta.short}</span>
            <span aria-hidden className="text-[9px] text-fg-faint">▾</span>
          </button>
        )
      })}
      {open !== null && <HeroMenu slot={open} hero={hero} figures={figures} label={`What line ${open} shows`} onPick={(m) => choose(open, m)} />}
    </div>
  )
}

/**
 * The spend details under the plan, unfolded by default, foldable to one
 * line. The header carries a period chip (session · today · 7d · 30d) and
 * *Chart | Numbers*, both remembered per viewer (owner, 2026-10-12: "you
 * can choose what you see — the chart or the numbers — and which ones").
 * **Chart**, the default since the figures beside the agent carry the
 * numbers (owner, 2026-10-12: "where did you put the chart?"): the
 * period's spend by time, its total on the top line and the stretch under
 * the pointer at its right. **Numbers**: three figures in one row, each
 * label a menu that picks what sits there, never one twice and, for the
 * session, never one of the figures beside the agent again.
 */
function Spend({ s, sessionId, events, now, figures, summary }: { s: SessionSummary; sessionId: string; events: readonly Event[]; now: number; figures: SpendFigures; summary?: Summary }) {
  const { folded, headline, hero, view, period, slots } = useSpendPrefs()
  // Folded, nothing is read: the one line is the session's own.
  const range = usePeriodSummary(folded ? 'session' : period, summary)
  if (!s.stats) return null
  const scope = periodScope(period)
  const pf = periodFigures(period, figures, range)
  return (
    <section aria-label="Spend" data-spend-view={folded ? undefined : view} data-spend-period={folded ? undefined : period} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <button type="button" aria-expanded={!folded} onClick={() => setSpendPrefs({ folded: !folded })}
          title={folded ? 'Show the spend details' : 'Fold the spend details'}
          className="-mx-1 flex min-w-0 flex-1 items-center gap-1.5 rounded-[6px] px-1 py-0.5 text-left outline-none hover:bg-panel-2 focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
          <Chevron open={!folded} />
          {folded ? (
            <span data-spend-folded className="num min-w-0 truncate text-[12.5px] text-fg-muted">{foldedLine(headline, figures)}</span>
          ) : (
            <h4 className="min-w-0 truncate text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-faint">Spend</h4>
          )}
        </button>
        {!folded && (
          <>
            <Segmented label={`Period: ${scope}`} value={period} options={SPEND_PERIODS.map((p) => [p, p, periodScope(p)] as const)} onPick={(p) => setSpendPrefs({ period: p })} />
            <Segmented label="Spend view" value={view} options={VIEW_OPTIONS} onPick={(v) => setSpendPrefs({ view: v })} />
          </>
        )}
      </div>
      {!folded && view === 'numbers' && <SpendNumbers period={period} hero={hero} slots={slots} figures={pf} scope={scope} />}
      {!folded && view === 'chart' && (period === 'session'
        ? <SpendOverTime sessionId={sessionId} events={events} now={now} total={figures.cost} />
        : !range
          ? <p data-spend-time data-spend-empty className="text-[12px] text-fg-muted">Reading {scope.split(' · ')[0]!.toLowerCase()}…</p>
          : !pf.series
            ? <p data-spend-time data-spend-empty className="text-[12px] text-fg-muted">This range’s summary has no spend by time to draw.</p>
            : <SpendChart id={`spend-time-${sessionId}`} bars={pf.series.bars} step={pf.series.step} now={now} total={pf.cost} scope={scope.toLowerCase()} />)}
    </section>
  )
}

/** Chart or Numbers: two small icons, each named for a screen reader and on hover. */
const VIEW_OPTIONS = [
  ['chart', (
    <svg key="c" aria-hidden width="18" height="12" viewBox="0 0 18 12" className="block">
      <rect x="3" y="6" width="3" height="6" rx="0.5" fill="currentColor" opacity="0.7" />
      <rect x="7.5" y="2" width="3" height="10" rx="0.5" fill="currentColor" />
      <rect x="12" y="4.5" width="3" height="7.5" rx="0.5" fill="currentColor" opacity="0.7" />
    </svg>
  ), 'Chart'],
  ['numbers', <span key="n" aria-hidden className="num block w-[18px] text-center text-[10px] font-semibold tracking-[-0.03em]">123</span>, 'Numbers'],
] as const satisfies readonly (readonly [SpendView, ReactNode, string])[]

/**
 * Numbers: three figures in one row for the period. Each label is a menu
 * of what can sit there (spent, burn rate, tokens, cache hit rate, last
 * call, time working, turns, tool calls); picking one another figure shows
 * swaps the two, so none is shown twice. Remembered per viewer.
 */
function SpendNumbers({ period, hero, slots, figures, scope }: { period: SpendPeriod; hero: readonly Metric[]; slots: readonly Metric[]; figures: PeriodFigures; scope: string }) {
  const shown = shownSlots(slots, period, hero)
  const [open, setOpen] = useState<number | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useMenuDismiss(open !== null, box, () => setOpen(null))
  const choose = (i: number, m: Metric) => { setSpendPrefs({ slots: pickSlot(shown, i, m) }); setOpen(null) }
  const when = scope.toLowerCase()
  return (
    <div ref={box} data-spend-numbers className="relative grid min-w-0 grid-cols-[minmax(0,1fr)]">
      <dl className="grid min-w-0 grid-cols-3 gap-2">
        {shown.map((m, i) => {
          const meta = METRICS.find((x) => x.id === m)!
          const value = metricValue(m, figures)
          return (
            <div key={i} className="grid min-w-0 gap-0.5" data-slot={m}>
              <dt className="flex min-w-0">
                <button type="button" aria-haspopup="menu" aria-expanded={open === i} aria-label={`${meta.name}. Choose what this figure shows`}
                  title="Choose what this figure shows" onClick={() => setOpen((o) => (o === i ? null : i))}
                  className="-mx-1 flex min-w-0 items-center gap-0.5 rounded-[4px] px-1 text-[10px] uppercase leading-[14px] tracking-[0.06em] text-fg-faint outline-none hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] aria-expanded:text-fg">
                  <span className="min-w-0 truncate">{meta.label}</span><span aria-hidden className="shrink-0 text-[8px]">▾</span>
                </button>
              </dt>
              <dd aria-label={`${meta.name}, ${when}: ${value}`} title={metricTitle(m, figures, period)}
                className="num min-w-0 max-w-full truncate text-[18px] font-semibold leading-[22px] tracking-[-0.02em] text-fg">{value}</dd>
            </div>
          )
        })}
      </dl>
      {open !== null && (
        <div role="menu" aria-label={`What figure ${open + 1} shows`} onKeyDown={onMenuKey}
          className="absolute inset-x-0 top-full z-30 mt-1 grid gap-px rounded-[9px] border border-border-strong bg-panel p-1 shadow-lg">
          {METRICS.map((x) => {
            const beside = period === 'session' && hero.includes(x.id)
            return (
              <button key={x.id} type="button" role="menuitemradio" aria-checked={x.id === shown[open]} disabled={beside}
                onClick={() => choose(open, x.id)} title={beside ? 'Already one of the figures beside the agent' : x.hint}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2 rounded-[6px] px-2 py-1 text-left outline-none hover:bg-panel-2 focus-visible:bg-panel-2 disabled:opacity-45 disabled:hover:bg-transparent aria-checked:bg-accent/10">
                <span className={`min-w-0 truncate text-[12.5px] ${x.id === shown[open] ? 'font-semibold text-fg' : 'text-fg'}`}>
                  {x.name}{beside ? <span className="text-fg-faint"> · beside the agent</span> : null}
                </span>
                <span className="num text-[12px] text-fg-muted">{metricValue(x.id, figures)}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** A disclosure's mark: pointing right when closed, down when open. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" className={`shrink-0 text-fg-muted transition-transform duration-150 ${open ? 'rotate-90' : ''}`}>
      <path d="M4.5 2.5L8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** A small segmented choice: toggle buttons in one hairline frame, the picked one filled. An option's third field names it. */
function Segmented<T extends string>({ label, value, options, onPick }: { label: string; value: T; options: readonly (readonly [T, ReactNode, string?])[]; onPick: (v: T) => void }) {
  return (
    <div role="group" aria-label={label} className="flex shrink-0 items-center rounded-[6px] border border-[var(--app-hairline)] p-px">
      {options.map(([id, name, title]) => (
        <button key={id} type="button" aria-pressed={id === value} onClick={() => onPick(id)}
          aria-label={typeof name === 'string' ? undefined : title} title={title}
          className={`grid h-[18px] place-items-center rounded-[5px] px-1.5 text-[11px] leading-[16px] outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] ${id === value ? 'bg-panel-2 font-medium text-fg' : 'text-fg-muted hover:text-fg'}`}>
          {name}
        </button>
      ))}
    </div>
  )
}

/** How often a 7d or 30d summary (or today's, when the window does not hold one) is read while shown. */
const PERIOD_SUMMARY_MS = 30_000

/**
 * The summary behind a Caprock-wide period: today's is the one the window
 * already polls (`given`); 7d and 30d are read from `/v1/stats/summary` only
 * while that period is shown, every 30 seconds.
 */
function usePeriodSummary(period: SpendPeriod, given: Summary | undefined): Summary | undefined {
  const own = period === 'today' && given?.range === 'today' ? given : undefined
  const need = period !== 'session' && !own
  const [got, setGot] = useState<{ period: SpendPeriod; s: Summary } | undefined>(undefined)
  useEffect(() => {
    if (period === 'session' || !need) return
    let alive = true
    const load = () => {
      api.summary(period)
        .then((s) => { if (alive && s) setGot({ period, s }) })
        .catch(() => { /* the figures stay dashes */ })
    }
    load()
    const stop = everyWhileVisible(load, PERIOD_SUMMARY_MS)
    return () => { alive = false; stop() }
  }, [need, period])
  if (period === 'session') return undefined
  return own ?? (got?.period === period ? got.s : undefined)
}

function ContextMeter({ s }: { s: SessionSummary }) {
  const ctx = s.context
  if (!ctx) {
    return (
      <section aria-label="Context" className="grid gap-2">
        <SectionLabel right={<span className="text-fg-faint">{s.context_note ?? 'not measured yet'}</span>}>Context</SectionLabel>
      </section>
    )
  }
  const pct = Math.max(0, Math.min(100, ctx.pct))
  const tone = pct >= 85 ? 'danger' : pct >= 60 ? 'warn' : 'ok'
  return (
    <section aria-label="Context" className="grid gap-2">
      <SectionLabel right={<span className="num text-fg-muted"><span className="text-fg">{fmtTokens(ctx.tokens)}</span> / {fmtTokens(ctx.window)}</span>}>Context</SectionLabel>
      <div className="cockpit-track relative h-[9px] overflow-hidden rounded-full" role="meter" aria-label="Context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <div className="cockpit-fill h-full rounded-full" data-tone={tone} style={{ width: `${Math.max(pct, 1.5)}%` }} />
        {[25, 50, 75].map((m) => <span key={m} aria-hidden className="absolute top-0 h-full w-px bg-[var(--app-chrome-bg)] opacity-70" style={{ left: `${m}%` }} />)}
      </div>
      <p className="text-[11.5px] text-fg-muted">
        <span className={`num font-medium ${tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-fg'}`}>{fmtPct(pct)}</span> full
        {ctx.next_call_usd > 0 && <> · every call now re-reads it for <span className="num text-fg">{fmtUSD(ctx.next_call_usd)}</span></>}
      </p>
    </section>
  )
}

function NowDoing({ s, state, running, last, permission, background, now }: {
  s: SessionSummary
  state: CockpitState
  running?: ToolRun
  last?: ToolRun
  permission?: Permission | null
  /** Subagents working after the turn ended (backgroundAgents). */
  background: number
  now: number
}) {
  let icon: ReactNode
  let verb: string
  let detail = ''
  let full = ''
  let right: ReactNode = null
  const waiting = permission?.waiting && permission.waiting.length > 1 ? permission.waiting : undefined
  if (permission && state !== 'ended') {
    // The prompt's own words, naming who asks: a subagent's dialog is drawn
    // in the parent's terminal, and the narrated phrase named neither.
    icon = <KindIcon kind="ask" />
    if (waiting) {
      verb = `${waiting.length} approvals waiting`
      detail = waiting.map((w) => `${requester(w, agentName(s.agent ?? 'claude'))}: ${w.tool}`).join(' · ')
      full = waiting.map((w) => `${askLine(w, agentName(s.agent ?? 'claude'))}\n${w.detail}`).join('\n\n')
    } else {
      verb = askLine(permission, agentName(s.agent ?? 'claude'))
      detail = commandGist(permission.detail).gist
      full = permission.detail
    }
    right = <span className="num text-[11.5px] text-fg-muted">{fmtAgo(permission.since, now)}</span>
  } else if (background > 0 && state === 'working') {
    // The turn ended with subagents still at work. Nothing is wanted from
    // the user: Claude Code picks the session up when they finish. Before
    // the main thread's last call, which "Thinking after …" would name.
    icon = <KindIcon kind="agent" />
    verb = backgroundLabel(background)
    detail = 'resumes when they finish'
  } else if (running) {
    icon = <KindIcon kind={running.kind} />
    verb = running.kind === 'mcp' || running.kind === 'other' ? `${runVerb(running.kind)} ${running.tool.replace(/^mcp__(.+?)__/, '$1·')}` : runVerb(running.kind)
    detail = running.detail
    right = <span className="num text-[11.5px] text-fg-muted">{fmtRun(Math.max(0, now - running.startMs))}</span>
  } else if (state === 'working' && last?.endMs !== undefined) {
    // Between calls: the model is writing its next step. The narrated phrase
    // still names the call that just finished, which read as still running.
    icon = <KindIcon kind="think" />
    verb = 'Thinking'
    detail = `after ${last.tool}${last.detail ? ` ${last.detail}` : ''}`
    right = <span className="num text-[11.5px] text-fg-muted">{fmtRun(Math.max(0, now - last.endMs))}</span>
  } else if (state === 'working') {
    icon = <KindIcon kind="think" />
    verb = capital(s.activity?.phrase || 'working')
  } else if (state === 'waiting') {
    icon = <KindIcon kind="ask" />
    verb = capital(s.activity?.phrase || 'waiting for you')
  } else if (state === 'looping') {
    icon = <KindIcon kind="loop" />
    verb = capital(s.activity?.phrase || 'repeating itself')
  } else if (state === 'ended') {
    icon = <KindIcon kind="stop" />
    verb = 'Process ended'
  } else {
    icon = <KindIcon kind="pause" />
    verb = s.activity?.phrase ? capital(s.activity.phrase) : 'Nothing running'
  }
  const plan = s.activity?.plan
  return (
    <section aria-label="Now" className="grid gap-2">
      <SectionLabel right={plan && plan.total > 0 ? <span className="num text-fg-muted" title={plan.next ? `Next: ${plan.next}` : undefined}>plan {plan.done}/{plan.total}</span> : undefined}>Now</SectionLabel>
      <div className="cockpit-now flex items-center gap-2.5 rounded-[10px] border px-2.5 py-2" data-state={state} data-running={running ? 'true' : undefined}>
        <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[7px] bg-[var(--app-row-active)]">{icon}</span>
        <span className="grid min-w-0 flex-1 leading-tight">
          <span className={`${permission ? 'line-clamp-2' : 'truncate'} text-[12.5px] font-medium text-fg`}>{verb}</span>
          {detail && (
            <span className={`mono text-[11.5px] text-fg-muted ${permission ? 'line-clamp-2 break-all' : 'truncate'}`} title={full || detail}>{detail}</span>
          )}
        </span>
        {right}
      </div>
    </section>
  )
}

/**
 * The subagents at work, one compact row each (WorkingSubagentRow): its
 * type's letter, pulsing while it works, what it is doing now, its calls and
 * cost; under it its current tool, its model and how long it has worked; a
 * badge while it waits on a permission prompt. Those that finished lately
 * are one muted line each: the letter, the task, model, time, cost; "+N
 * finished" opens the rest. A cost is shown only when
 * the daemon knows it — never a $0 standing in for unknown.
 *
 * Every row opens in place, one at a time (owner, 2026-10-12: "can we expand
 * the subagents to look inside?"): its task, its calls, its answer and its
 * numbers (SubagentDetail).
 */
function Subagents({ subs, permission, now, sessionId, open, onOpen, allFinished, onAllFinished, reveal }: {
  subs: SubagentsNow
  permission?: Permission | null
  now: number
  sessionId: string
  /** The row open, by agent id. */
  open: string | null
  onOpen: (id: string | null) => void
  allFinished: boolean
  onAllFinished: (v: boolean) => void
  /** Bumped by a hero chip: bring the open row into view. */
  reveal: number
}) {
  const [allWorking, setAllWorking] = useState(false)
  const box = useRef<HTMLElement>(null)
  const openIdx = open ? subs.working.findIndex((a) => a.agent_id === open) : -1
  const showAllWorking = allWorking || openIdx >= SUBAGENT_ROWS
  const shown = showAllWorking ? subs.working : subs.working.slice(0, SUBAGENT_ROWS)
  const hidden = subs.working.length - shown.length
  const recentAll = subs.recent ?? []
  const openDone = open ? recentAll.findIndex((d) => d.agent_id === open) : -1
  const room = Math.max(0, SUBAGENT_ROWS - shown.length)
  const recent = allFinished ? recentAll : recentAll.slice(0, Math.max(room, openDone + 1))
  const moreDone = subs.finished - recent.length
  useEffect(() => {
    if (!reveal || !open) return
    const row = box.current?.querySelector(`[data-subagent="${CSS.escape(open)}"]`)
    row?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [reveal, open])
  const toggle = (id: string) => onOpen(open === id ? null : id)
  return (
    <section ref={box} aria-label="Subagents" className="grid gap-2">
      <SectionLabel right={
        <>
          {typeof subs.cost_usd === 'number' && <span className="num text-fg-muted" title="What every subagent of this session has cost">{fmtUSD(subs.cost_usd)}</span>}
          {(moreDone > 0 || allFinished) && subs.finished > 0 && (
            <button type="button" onClick={() => onAllFinished(!allFinished)} aria-expanded={allFinished}
              className="rounded-[4px] text-fg-faint outline-none hover:text-fg-muted focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
              {allFinished ? 'fewer finished' : `+${moreDone} finished`}
            </button>
          )}
        </>
      }>
        Subagents · {subs.working.length}
      </SectionLabel>
      {shown.length > 0 && (
        <ul aria-label="Working subagents" className="grid gap-1">
          {shown.map((a) => {
            const isOpen = open === a.agent_id
            const panel = `subagent-${a.agent_id}`
            const waiting = subagentWaiting(a, permission)
            return (
              <li key={a.agent_id} data-subagent={a.agent_id} className="grid rounded-[8px] border border-[var(--app-hairline)]" data-waiting={waiting ? 'true' : undefined} data-open={isOpen ? 'true' : undefined}>
                <WorkingSubagentRow a={a} waiting={waiting} now={now} open={isOpen} panel={panel} onToggle={() => toggle(a.agent_id)} />
                {isOpen && <SubagentDetail id={panel} sessionId={sessionId} agentId={a.agent_id} now={now} />}
              </li>
            )
          })}
        </ul>
      )}
      {hidden > 0 && (
        <button type="button" onClick={() => setAllWorking(true)}
          className="w-fit rounded-[4px] text-[11px] text-fg-faint outline-none hover:text-fg-muted focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
          +{hidden} more working
        </button>
      )}
      {recent.length > 0 && (
        <ul aria-label="Finished subagents" className="grid gap-0.5">
          {recent.map((d) => {
            const isOpen = open === d.agent_id
            const panel = `subagent-${d.agent_id}`
            return (
              <li key={d.agent_id} data-subagent={d.agent_id} className={`grid rounded-[8px] ${isOpen ? 'border border-[var(--app-hairline)]' : ''}`} data-open={isOpen ? 'true' : undefined}>
                <button type="button" onClick={() => toggle(d.agent_id)} aria-expanded={isOpen} aria-controls={isOpen ? panel : undefined}
                  className="flex min-w-0 items-center gap-1.5 rounded-[8px] px-2 py-[3px] text-left text-[11.5px] text-fg-faint outline-none hover:bg-[var(--app-row-hover)] focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
                  title={[d.agent_type, d.description].filter(Boolean).join(' — ')}>
                  <TypeChip type={d.agent_type} state="done" />
                  {d.description && <span className="min-w-0 truncate">{d.description}</span>}
                  <span className="num ml-auto shrink-0">
                    {[d.model_display, d.stopped_at > d.started_at ? fmtRun(d.stopped_at - d.started_at) : '', typeof d.cost_usd === 'number' ? fmtUSD(d.cost_usd) : ''].filter(Boolean).join(' · ')}
                  </span>
                  <Chevron open={isOpen} />
                </button>
                {isOpen && <SubagentDetail id={panel} sessionId={sessionId} agentId={d.agent_id} now={now} />}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/**
 * A subagent's type as one letter in its tint — the hero strip's chip, so a
 * row and its chip read as the same agent; the full type on hover.
 */
function TypeChip({ type, state }: { type?: string; state: 'working' | 'waiting' | 'done' }) {
  const name = type || 'subagent'
  return (
    <span title={name} aria-label={name} data-state={state} data-tone={subagentTone(type)}
      className="cockpit-subchip num relative grid h-[16px] w-[16px] shrink-0 place-items-center rounded-[4px] text-[9.5px] font-semibold">
      {subagentInitial(type)}
    </span>
  )
}

/**
 * One working subagent: its type as a letter, then what it is doing now in
 * words (`subagentDoing`: the call's own description, its tool and target,
 * or its task — Claude Code's own activity line is not written anywhere to
 * read), how many calls it has made and what it has cost; under it, dimmer,
 * its current tool and how long that has run, its model and how long it has
 * worked. The raw command or file is left out when the phrase already says
 * it (owner, 2026-10-13: picked over a layout that kept it under the phrase).
 */
function WorkingSubagentRow({ a, waiting, now, open, panel, onToggle }: {
  a: Subagent
  waiting: boolean
  now: number
  open: boolean
  panel: string
  onToggle: () => void
}) {
  const doing = subagentDoing(a)
  const tool = a.tool?.replace(/^mcp__(.+?)__/, '$1·') ?? ''
  const since = a.running && a.tool_at ? fmtRun(Math.max(0, now - a.tool_at)) : ''
  const model = [a.model_display, a.started_at ? fmtRun(Math.max(0, now - a.started_at)) : ''].filter(Boolean).join(' · ')
  const calls = (
    <>
      {a.tool_calls} {a.tool_calls === 1 ? 'call' : 'calls'}
      {typeof a.cost_usd === 'number' && <> · {fmtUSD(a.cost_usd)}</>}
    </>
  )
  // The raw line is left out when the phrase already says it: the call's own
  // description, or a phrase that names the same file or pattern.
  const showDetail = doing.from !== 'call' && !(a.detail && doing.text.includes(a.detail))
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={open ? panel : undefined}
      className="grid gap-0.5 rounded-[8px] px-2 py-1.5 text-left outline-none hover:bg-[var(--app-row-hover)] focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
      title={[a.agent_type, a.description, a.tool && `${a.tool}${a.detail ? ` ${a.detail}` : ''}`].filter(Boolean).join(' — ')}>
      <span className="flex min-w-0 items-center gap-1.5 text-[12px]">
        <TypeChip type={a.agent_type} state={waiting ? 'waiting' : 'working'} />
        <span data-doing={doing.from || undefined} className={`min-w-0 truncate ${doing.text ? 'text-fg' : 'text-fg-faint'}`}>{doing.text || 'starting'}</span>
        {waiting
          ? <span className="ml-auto shrink-0 rounded-[4px] bg-accent/15 px-1.5 text-[10.5px] font-medium text-accent">waiting on you</span>
          : <span className="num ml-auto shrink-0 pl-1 text-[11px] text-fg-faint">{calls}</span>}
        <Chevron open={open} />
      </span>
      <span className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-1.5 text-[11px] text-fg-faint">
        {a.tool ? <span className={`grid place-items-center ${a.running ? 'text-ok' : ''}`}><KindIcon kind={toolKind(a.tool)} size={11} /></span> : <span />}
        <span className="min-w-0 truncate">
          {a.tool && (
            <>
              <span className="text-fg-muted">{tool}</span>
              {showDetail && a.detail && <span className="mono ml-1 text-[10.5px]">{a.detail}</span>}
              {since && <span className="num ml-1 text-ok">{since}</span>}
            </>
          )}
        </span>
        <span className="num">{model}</span>
      </span>
    </button>
  )
}

function capital(t: string): string {
  return t ? t[0]!.toUpperCase() + t.slice(1) : t
}

function LoopWarning({ s, now }: { s: SessionSummary; now: number }) {
  const l = s.loop!
  return (
    <section aria-label="Loop alert" role="alert" className="grid gap-1 rounded-[10px] border border-danger/40 bg-danger/[0.07] px-3 py-2.5">
      <p className="flex items-baseline gap-2 text-[12.5px] font-medium text-danger">
        <span>Same {l.tool} call ×{l.count}</span>
        <span className="ml-auto text-[11px] font-normal text-fg-faint">{fmtAgo(l.last_ts || l.ts, now)}</span>
      </p>
      {l.sample && <p className="mono truncate text-[11.5px] text-fg-muted" title={l.sample}>{l.sample}</p>}
      <p className="text-[11.5px] text-fg-muted">
        within {l.window_min} min{typeof l.tax_usd === 'number' && l.tax_usd > 0 ? <> · re-reading the context for them cost <span className="num text-fg">{fmtUSD(l.tax_usd)}</span></> : null}
      </p>
    </section>
  )
}

function PlanWindows({ limits, agent, now, acct }: { limits: NonNullable<Summary['rate_limits']>; agent?: string; now: number; acct: SessionPlan }) {
  const source = acct.account && !acct.account.default ? `${agent === 'codex' ? 'Codex' : 'Claude Code'} (${acct.account.label})` : agent === 'codex' ? 'Codex' : 'Claude Code'
  const { plan, save: savePlan } = acct
  return (
    <section aria-label="Plan limits" className="grid gap-2.5">
      {/* Which plan these are — and a click to correct it (owner, 2026-10-11:
        * "and you can confirm the plan there: is it really this one?"). */}
      <SectionLabel right={agent === 'codex' ? <span className="text-fg-faint">{acct.account && !acct.account.default ? acct.account.label : 'all Codex sessions'}</span> : <PlanChip plan={plan} onSave={savePlan} account={acct.account} />}>Plan</SectionLabel>
      {limits.five_hour && <WindowBar label="5 hours" w={limits.five_hour} lenMs={WINDOW_MS.five_hour} now={now} source={source} forecasts={agent !== 'codex'} />}
      {limits.seven_day && <WindowBar label="Week" w={limits.seven_day} lenMs={WINDOW_MS.seven_day} now={now} source={source} forecasts={agent !== 'codex'} />}
    </section>
  )
}

/**
 * One window at a glance: the bar, a tick where an even pace would be by
 * the clock (fill past it = spending faster than time passes), the percentage
 * large, and one line — when it resets and whether it lasts. Green *enough*,
 * amber *out at 23:50*, red when that is under half an hour away; a click
 * shows the exact reset time and the forecast in words.
 */
function WindowBar({ label, w, lenMs, now, source, forecasts }: { label: string; w: RateWindow; lenMs: number; now: number; source: string; forecasts: boolean }) {
  const { stale } = readWindow(w, now)
  const p = pace(w, lenMs, now, { forecasts, stale })
  const [more, setMore] = useState(false)
  const tone = p.verdict === 'out' ? (p.urgent ? 'danger' : 'warn') : p.pct > 85 ? 'danger' : 'ok'
  const ink = tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-fg'
  const observed = w.observed_at ? ` · read ${fmtAgo(w.observed_at, now)}` : ''
  return (
    <div className="grid gap-1" data-window={label}>
      <div className="grid grid-cols-[56px_minmax(0,1fr)_auto] items-center gap-x-2.5">
        <span className="text-[12.5px] text-fg-muted">{label}</span>
        <div className="cockpit-track relative h-[8px] overflow-visible rounded-full" role="meter" aria-label={`${label} window used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.pct}>
          <div className="cockpit-fill h-full rounded-full" data-tone={tone === 'ok' ? 'accent' : tone} style={{ width: `${Math.max(1.5, Math.min(100, p.pct))}%` }} />
          {!stale && (
            <span aria-hidden data-pace-tick title={`Even pace: ${Math.round(p.elapsed)}% of the window has passed`}
              className="absolute -top-[3px] h-[14px] w-[2px] rounded-full bg-fg" style={{ left: `calc(${p.elapsed}% - 1px)` }} />
          )}
        </div>
        <span className={`num text-right text-[15px] font-semibold ${ink}`}>{p.pct}%</span>
      </div>
      <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more}
        className="ml-[66px] flex flex-wrap items-baseline gap-x-2 text-left text-[12.5px]"
        title={stale ? `${source} has not refreshed this window recently` : 'Click for the exact time and the forecast'}>
        {stale ? <span className="text-fg-faint">not reported lately{observed}</span> : (
          <>
            <span className="text-fg-muted">resets in <span className="num text-fg">{countdown(p.resetMs - now)}</span></span>
            {p.verdict === 'ok' && <span data-verdict="ok" className="font-medium text-ok">✓ enough</span>}
            {p.verdict === 'out' && <span data-verdict="out" className={`font-medium ${p.urgent ? 'text-danger' : 'text-warn'}`}>⚠ out {p.outAt ? `at ${resetClock(p.outAt, now)}` : 'now'}</span>}
          </>
        )}
      </button>
      {more && !stale && (
        <p className="ml-[66px] text-[11.5px] leading-relaxed text-fg-faint">
          Resets {resetClock(p.resetMs, now)}{observed}. {w.forecast ? `At this pace: ${w.forecast.replace(/^~/, 'about ')}.` : forecasts ? 'At this pace it lasts until the reset.' : `${source} limits are not forecast.`} The tick is where an even pace would be.
        </p>
      )}
    </div>
  )
}

function Timeline({ runs, total, now }: { runs: ToolRun[]; total?: number; now: number }) {
  const rows = runs.slice(-TIMELINE_ROWS).reverse()
  const durations = rows.map((r) => Math.max(0, (r.endMs ?? now) - r.startMs))
  const max = Math.max(...durations, 1)
  return (
    <section aria-label="Recent tool calls" className="grid gap-2">
      <SectionLabel right={typeof total === 'number' && total > 0 ? <span className="num text-fg-faint">{total} in all</span> : undefined}>Recent tools</SectionLabel>
      {rows.length === 0 ? (
        <p className="text-[11.5px] text-fg-faint">No tool calls yet.</p>
      ) : (
        <ol className="grid">
          {rows.map((r, i) => {
            const ms = durations[i]!
            const live = r.endMs === undefined
            return (
              <li key={r.id} className="cockpit-row grid grid-cols-[18px_minmax(0,1fr)_34px_42px] items-center gap-2 py-[5px]" data-live={live ? 'true' : undefined} title={`${r.tool}${r.detail ? ` — ${r.detail}` : ''} · ${new Date(r.startMs).toLocaleTimeString()}`}>
                <span className={`grid place-items-center ${r.failed ? 'text-danger' : r.kind === 'edit' ? 'text-accent' : 'text-fg-muted'}`}><KindIcon kind={r.kind} size={14} /></span>
                <span className="min-w-0 truncate text-[12px]">
                  <span className={r.failed ? 'text-danger' : 'text-fg'}>{r.tool.startsWith('mcp__') ? r.tool.replace(/^mcp__(.+?)__/, '$1·') : r.tool}</span>
                  {r.detail && <span className="mono ml-1.5 text-[11px] text-fg-muted">{r.detail}</span>}
                </span>
                <span className="h-[3px] overflow-hidden rounded-full bg-[var(--app-hairline)]" aria-hidden>
                  <span className={`block h-full rounded-full ${r.failed ? 'bg-danger' : live ? 'cockpit-bar-live bg-ok' : 'bg-fg-faint'}`} style={{ width: `${runShare(ms, max) * 100}%` }} />
                </span>
                <span className={`num text-right text-[11px] ${live ? 'text-ok' : r.failed ? 'text-danger' : 'text-fg-muted'}`}>{live ? fmtRun(ms) : r.failed ? 'failed' : fmtRun(ms)}</span>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
