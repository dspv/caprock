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
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react'
import { api, type Event, type Permission, type RateWindow, type SessionSummary, type Subagent, type SubagentDone, type SubagentsNow, type Summary } from '@/lib/api'
import { usePermission } from './PermissionPrompt'
import { live } from '@/lib/live'
import { useSessionEvents } from '@/lib/sessionEvents'
import { fmtAgo, fmtPct, fmtTokens, fmtUSD } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { countdown, resetClock } from '@/lib/limitclock'
import { readWindow } from './PlanLimits'
import { PlanChip } from './PlanPicker'
import { setLook, useLooks } from '@/lib/cockpitlooks'
import { DEFAULT_ORDER, SECTION_NAMES, isDefaultOrder, moveSection, setOrder, useSectionOrder, type CockpitSection } from '@/lib/cockpitorder'
import { useSessionPlan, windowsOf, type SessionPlan } from './AccountPlan'
import { WINDOW_MS, pace } from '@/lib/pace'
import { SessionChart, SpendBars, SpendChart, useSessionBars } from './SpendScrub'
import { callsFromEvents } from '@/lib/scrub'
import { everyWhileVisible } from '@/lib/visible'
import { CHART_METRICS, HEADLINES, METRICS, SPEND_PERIODS, chartTotal, chartValueText, foldedFigures, metricTitle, metricValue, periodFigures, periodScope, pickHero, pickSlot, setSpendPrefs, shownSlots, spendFigures, useSpendPrefs, type ChartMetric, type Metric, type PeriodFigures, type SpendBar, type SpendFigures, type SpendPeriod, type SpendView } from '@/lib/spendview'
import { UsualDelta } from './HeroUsual'
import { paceOf, versus, type Usual } from '@/lib/usual'
import { agentName } from './Characters'
import { PickableFace, SessionCharacter } from './SessionFace'
import { SubscriptionTag } from './SubscriptionPicker'
import { TodoBlock } from './SessionTodos'
import { PermissionModeChip } from './PermissionModeChip'
import { KindIcon } from './KindIcon'
import { OverlapLine } from './OverlapLine'
import { LoopAlertCard } from './LoopAlertCard'
import { useLoopHidden } from '@/lib/loopalert'
import { overlapChip, useOverlap } from '@/lib/overlap'
import { sessionTitle } from '@/lib/sidebar'
import { orderSubagents, presetOf, setSubagentFields, useSubagentFields, SUBAGENT_FIELDS, SUBAGENT_PRESETS, type SubagentFields } from '@/lib/subagentview'
import { SubagentDetail } from './SubagentDetail'
import { SectionFrames } from './SectionFrames'
import {
  askLine, backgroundAgents, chipGroups, chipLayout, subagentChips, subagentDoing, subagentInitial, subagentTone, backgroundLabel, cockpitState, commandGist, fmtAge, fmtRun, planWindowsFor, requester, runningTool, runVerb, subagentWaiting, toolGroups, toolKind, toolRuns, RUNNING_STALE_MS, SLOW_MS,
  type CockpitState, type SubagentChip, type ToolGroup, type ToolRun,
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

/** The cockpit's subagent read (useSubagents), handed to the Release section so it reads nothing again. */
export const SessionSubagents = createContext<SubagentsNow | undefined>(undefined)

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
export function Cockpit({ s, sessionId, hasPermission, summary, changes, ci, release, processes }: {
  s: SessionSummary
  sessionId: string
  hasPermission: boolean
  summary?: Summary
  /** The working tree's changes, drawn by the inspector (it owns the diff fetch). */
  changes?: ReactNode
  /** The session's pull requests and their checks (CockpitCI), placed and folded with the rest. */
  ci?: ReactNode
  /** The repository's next release (ReleasePlan's CockpitRelease), likewise. */
  release?: ReactNode
  /** The session's busiest processes (ResourceMeter's Processes), likewise. */
  processes?: ReactNode
}) {
  // Held once per session and shared with the session deck (lib/sessionEvents.ts).
  const main = useSessionEvents(sessionId)
  const [permission] = usePermission(sessionId)
  const state = cockpitState(s, hasPermission || !!permission)
  // Seconds count only while something runs or waits (a call, the model
  // thinking, a prompt); an idle or ended agent shows minutes and hours, and
  // redrawing the cockpit every second for those kept an idle window busy.
  const now = useNow(state === 'working' || state === 'looping' || permission ? 1000 : 30_000)
  const runs = useMemo(() => toolRuns(main), [main])
  // The subagent row opened in place (one at a time), and whether "+N
  // finished" is open — which asks the daemon for more than three of them.
  const [openSub, setOpenSub] = useState<string | null>(null)
  const [allFinished, setAllFinished] = useState(false)
  const [reveal, setReveal] = useState(0)
  // Claude Code is the agent with subagents Caprock hears from.
  const subs = useSubagents(sessionId, state !== 'ended' && (s.agent ?? 'claude') === 'claude', allFinished ? FINISHED_OPEN : 0)
  // A chip opens its subagent's row, unfolding the section if it was folded.
  const openFromChip = (id: string) => { setLook('subagents', 'full'); setOpenSub(id); setReveal((n) => n + 1) }
  const running = state === 'working' || state === 'looping' ? runningTool(runs, now) : undefined
  // A session on one of the user's subscriptions shows that account's
  // windows and plan; the day's summary carries the own sign-in's.
  const acct = useSessionPlan(s.agent, s.subscription)
  const plan = s.subscription ? windowsOf(acct.account) : planWindowsFor(s.agent, summary)
  const calls = useMemo(() => callsFromEvents(main), [main])
  const figures = spendFigures(s, calls)
  // The order is what the people using it look at (owner, 2026-10-12): the
  // agent and its headline figure, what it is doing now, then the context
  // and the plan limits, compact by default (owner, 2026-10-14: "you moved
  // the context window size too far down — it's needed info; make it
  // compact or like now, plan and limits too", translated), then the spend
  // chart (owner, 2026-10-13: "I like looking at it", picked from three
  // places), its subagents, its task list.
  // That is the default; each viewer can put the sections in another order
  // in Arrange mode (owner, 2026-10-14, translated: "so everyone sets up
  // what interests them"), or by a section's own grip — drag, ⌥⇧↑ ⌥⇧↓,
  // its menu (SectionFrames; owner, 2026-10-15). The agent's own block
  // stays on top.
  const order = useSectionOrder()
  const [arranging, setArranging] = useState(false)
  const sections: Record<CockpitSection, ReactNode> = {
    now: (
      <>
        <Foldable id="now"><NowDoing s={s} state={state} running={running} last={runs[runs.length - 1]} permission={permission} background={backgroundAgents(s)} now={now} /></Foldable>
        {s.loop && state !== 'ended' && <LoopWarning s={s} now={now} />}
        <CheckoutShared s={s} live={state !== 'ended'} />
      </>
    ),
    context: <ContextMeter s={s} />,
    limits: plan ? <PlanWindows limits={plan} agent={s.agent} now={now} acct={acct} /> : null,
    spend: <Spend s={s} sessionId={sessionId} events={main} now={now} figures={figures} summary={summary} />,
    subagents: subs && (subs.working.length > 0 || (subs.recent?.length ?? 0) > 0) ? (
      <Subagents subs={subs} permission={permission} now={now} sessionId={sessionId} open={openSub} onOpen={setOpenSub}
        allFinished={allFinished} onAllFinished={setAllFinished} reveal={reveal} />
    ) : null,
    tasks: <Foldable id="tasks"><TodoBlock sessionId={sessionId} /></Foldable>,
    tools: <Timeline runs={runs} total={s.stats?.tool_calls} now={now} cwd={s.cwd} />,
    changes: changes ? <Foldable id="changes">{changes}</Foldable> : null,
    ci: ci ? <Foldable id="ci">{ci}</Foldable> : null,
    // The Release section lists the working subagents too, from this one read.
    release: release ? <SessionSubagents.Provider value={subs}><Foldable id="release">{release}</Foldable></SessionSubagents.Provider> : null,
    processes: processes ? <Foldable id="processes">{processes}</Foldable> : null,
  }
  return (
    <>
      <Hero s={s} sessionId={sessionId} state={state} asking={hasPermission || !!permission} now={now} background={hasPermission || permission ? 0 : backgroundAgents(s)} subs={subs} permission={permission} figures={figures} usual={summary?.usual} onChip={openFromChip} />
      {arranging
        ? <ArrangeSections order={order} onDone={() => setArranging(false)} />
        : <SectionFrames order={order} sections={sections} />}
      {!arranging && <ArrangeButton onArrange={() => setArranging(true)} />}
    </>
  )
}

/**
 * The quiet way into Arrange mode, under the last section: the order never
 * changes from a stray click or a drag on a heading, only here.
 */
function ArrangeButton({ onArrange }: { onArrange: () => void }) {
  return (
    <div className="flex justify-end">
      <button type="button" onClick={onArrange} data-arrange-open title="Change the order of the cockpit's sections"
        className="flex items-center gap-1 rounded-[5px] px-1 text-[11px] leading-[16px] text-fg-faint outline-none hover:bg-panel-2 hover:text-fg-muted focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
        <svg aria-hidden width="11" height="11" viewBox="0 0 12 12" className="shrink-0">
          <path d="M4 1.5v9M4 1.5L2 3.5M4 1.5l2 2M8 10.5v-9M8 10.5l-2-2M8 10.5l2-2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Arrange sections
      </button>
    </div>
  )
}

/**
 * Arrange mode: the sections under the agent as a short list, each with ↑
 * and ↓, *Reset to default order* and *Done* (Esc too). No dragging: a
 * section moves one place per press, with the keyboard as with the
 * pointer, and the focus stays on the button pressed so pressing it again
 * moves it on. Every move is kept at once, per viewer (lib/cockpitorder).
 */
function ArrangeSections({ order, onDone }: { order: readonly CockpitSection[]; onDone: () => void }) {
  const box = useRef<HTMLElement>(null)
  // The button to give the focus back to after a move re-orders the list.
  const refocus = useRef<{ id: CockpitSection; by: -1 | 1 } | null>(null)
  useLayoutEffect(() => {
    const want = refocus.current
    refocus.current = null
    if (!want) return
    const row = box.current?.querySelector(`[data-arrange-row="${want.id}"]`)
    const same = row?.querySelector<HTMLButtonElement>(`[data-move="${want.by}"]`)
    const other = row?.querySelector<HTMLButtonElement>(`[data-move="${-want.by}"]`)
    ;(same && !same.disabled ? same : other)?.focus()
  }, [order])
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('[data-move]:not(:disabled)')?.focus()
  }, [])
  const move = (id: CockpitSection, by: -1 | 1) => {
    refocus.current = { id, by }
    setOrder(moveSection(order, id, by))
  }
  const btn = 'grid h-[22px] w-[24px] place-items-center rounded-[5px] text-[12px] text-fg-muted outline-none hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] disabled:opacity-30 disabled:hover:bg-transparent'
  return (
    <section ref={box} aria-label="Arrange sections" data-arranging className="grid gap-2 rounded-[10px] border border-[var(--app-hairline)] p-2.5"
      onKeyDown={(e) => { if (e.code === 'Escape') { e.preventDefault(); onDone() } }}>
      <div className="flex items-baseline gap-2">
        <h4 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-faint">Arrange sections</h4>
        <span className="ml-auto text-[11px] text-fg-faint">kept for you on this computer</span>
      </div>
      <ol aria-label="Section order" className="grid">
        {order.map((id, i) => (
          <li key={id} data-arrange-row={id} className="cockpit-row flex items-center gap-1 py-[3px]">
            <span className="num w-[16px] shrink-0 text-[11px] text-fg-faint">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{SECTION_NAMES[id]}</span>
            <button type="button" data-move="-1" disabled={i === 0} onClick={() => move(id, -1)} aria-label={`Move ${SECTION_NAMES[id]} up`} title="Move up" className={btn}>↑</button>
            <button type="button" data-move="1" disabled={i === order.length - 1} onClick={() => move(id, 1)} aria-label={`Move ${SECTION_NAMES[id]} down`} title="Move down" className={btn}>↓</button>
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-2">
        <button type="button" disabled={isDefaultOrder(order)} onClick={() => setOrder(DEFAULT_ORDER)}
          className="rounded-[5px] px-1 text-[11.5px] text-fg-muted outline-none hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] disabled:opacity-40 disabled:hover:bg-transparent">
          Reset to default order
        </button>
        <button type="button" onClick={onDone}
          className="ml-auto rounded-[6px] border border-[var(--app-hairline)] px-2.5 py-0.5 text-[12px] font-medium text-fg outline-none hover:bg-panel-2 focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
          Done
        </button>
      </div>
    </section>
  )
}

/** A section the cockpit folds for it: its SectionLabel becomes the chevron that folds it. */
const FoldCtx = createContext<{ full: boolean; toggle: () => void } | null>(null)

/**
 * Folds a section that has no fold of its own (Now, Tasks, Changes, CI,
 * Processes) the way Context and Plan fold: its label turns into the same
 * chevron button, and folded, everything under the label row is hidden by
 * `[data-folded]` in tokens.css, so the figures the label carries at its
 * right (*3 of 7 done*, *4 min ago*, *12% · 210 MB*) are its one line.
 * Kept per viewer with the other looks (lib/cockpitlooks).
 */
function Foldable({ id, children }: { id: 'now' | 'tasks' | 'changes' | 'ci' | 'release' | 'processes'; children: ReactNode }) {
  const looks = useLooks()
  const full = looks[id] === 'full'
  const ctx = useMemo(() => ({ full, toggle: () => setLook(id, full ? 'compact' : 'full') }), [id, full])
  return (
    <FoldCtx.Provider value={ctx}>
      <div data-fold={id} data-folded={full ? undefined : ''} className="grid min-w-0 grid-cols-[minmax(0,1fr)]">{children}</div>
    </FoldCtx.Provider>
  )
}

/** Whether the section this is drawn in is folded by the cockpit: what its label carries then. */
export function useFolded(): boolean {
  const fold = useContext(FoldCtx)
  return !!fold && !fold.full
}

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  const fold = useContext(FoldCtx)
  if (fold) {
    return (
      <div data-section-head className="flex min-w-0 items-center gap-2">
        <button type="button" aria-expanded={fold.full} onClick={fold.toggle} title={fold.full ? 'Fold this section to one line' : 'Show the whole section'}
          className="-mx-1 flex min-w-0 shrink-0 items-center gap-1 rounded-[6px] px-1 py-0.5 text-left outline-none hover:bg-panel-2 focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
          <Chevron open={fold.full} />
          <h4 className="truncate text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-faint">{children}</h4>
        </button>
        {right && <div className="ml-auto flex min-w-0 items-baseline gap-2 text-[11.5px]">{right}</div>}
      </div>
    )
  }
  return (
    <div className="flex items-baseline gap-2">
      <h4 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-faint">{children}</h4>
      {right && <div className="ml-auto flex items-baseline gap-2 text-[11.5px]">{right}</div>}
    </div>
  )
}

/**
 * How the hero's subagent chips sit in the width beside "N working": full
 * size or compact, and how many to draw (lib/cockpit chipLayout). Measured
 * from that width and the working count only, never from which chips show;
 * until laid out, a 324px inspector's width.
 */
function useChipLayout(box: RefObject<HTMLDivElement | null>, working: number): { compact: boolean; room: number } {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver !== 'function') return
    const read = () => { if (el.clientWidth > 0) setWidth(el.clientWidth) }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [box])
  return chipLayout(width > 0 ? width : 230, working)
}

/**
 * The agent, its figures and its subagents, in one grid that never changes
 * shape when the state does (owner, 2026-10-13: "restore the awesome look —
 * both when work is going on and when it waits"). Three rows:
 *
 * - **The agent's row**, as tall as the avatar: the character, whose ring
 *   carries the state's colour; the agent, its model on a line of its own
 *   (never cut to make room for the figure), and when it started. At its
 *   right, in a place of its own, the headline figure and what it is
 *   (owner, 2026-10-12: "put it to the right of the agent").
 * - **The detail row**: under the portrait, centred, the state line (dot and
 *   word, in the state's colour) and the permission mode under it (owner,
 *   2026-10-14: "status and mode can both go under the portrait — then the
 *   figures get better visibility", translated); the two smaller figures at
 *   the right, with the rest of the row to themselves.
 * - **The subagents' row**: a chip per subagent in groups of five, in the
 *   order they started, wrapping onto a second line; compact chips when two
 *   lines of full ones would not hold them (lib/cockpit chipLayout); or *no
 *   subagents running*.
 *
 * A state change recolours the ring, the dot and the state line and changes
 * the chips; nothing moves. A longer figure takes room from the agent's
 * lines, which are left-aligned and cut rather than wrapped; a narrower
 * inspector steps the headline down (.cockpit-hero, a container query). A
 * click on Claude's portrait picks this session's face (SessionFace).
 * Now and then, idle or waiting with no prompt up, a small "try a duck?"
 * line beside the portrait points at the rubber ducks (SessionFace).
 */
function Hero({ s, sessionId, state, asking, now, background, subs, permission, figures, usual, onChip }: { s: SessionSummary; sessionId: string; state: CockpitState; asking: boolean; now: number; background: number; subs?: SubagentsNow; permission?: Permission | null; figures: SpendFigures; usual?: Usual; onChip: (id: string) => void }) {
  const since = s.worked_at || s.last_event_at
  const saysBackground = background > 0 && state === 'working'
  const working = subs?.working.length ?? 0
  const chipBox = useRef<HTMLDivElement>(null)
  const layout = useChipLayout(chipBox, working)
  const strip = subagentChips(subs, permission, layout.room)
  const count = working || (strip.chips.length === 0 ? s.live_subagents ?? 0 : 0) || (saysBackground ? background : 0)
  const model = s.model_display || s.model
  // One word under the portrait: "Background agents" wrapped to two lines in
  // the narrow column (owner, 2026-10-22). The full phrase is the tooltip and
  // what a screen reader announces.
  const label = saysBackground ? 'Background' : STATE_LABEL[state]
  const ago = (state === 'idle' || state === 'ended') && since ? fmtAgo(since, now) : ''
  return (
    <div className="@container min-w-0">
      <div className="cockpit-hero" data-state={state}>
        <PickableFace agent={s.agent} sessionId={sessionId} hint={!asking && (state === 'idle' || state === 'waiting')}
          className="cockpit-avatar relative grid place-items-center justify-self-center rounded-[15px] [grid-area:av]" data-state={state}>
          <SessionCharacter agent={s.agent} sessionId={sessionId} size={46} className="cockpit-character" />
        </PickableFace>
        {/* Name, model, since when: the state moved under the portrait, so
          * the name and the model have the column to themselves. */}
        <div className="grid min-w-0 content-start [grid-area:info]">
          <p className="truncate whitespace-nowrap text-[13px] font-semibold leading-[19px] text-fg">{agentName(s.agent ?? 'claude')}</p>
          {model ? (
            <p data-hero-model className="flex min-w-0 items-baseline whitespace-nowrap text-[12px] leading-[17px] text-fg-muted" title={model}>
              <span className="truncate">{model}</span>
              <SubscriptionTag id={s.subscription} agent={s.agent ?? 'claude'} className="min-w-0 shrink truncate text-[12px] text-fg-muted" />
            </p>
          ) : null}
          {s.started_at > 0 && state !== 'ended' && (
            <p data-hero-started className="truncate text-[11px] leading-[16px] text-fg-faint">started {fmtAgo(s.started_at, now)}</p>
          )}
        </div>
        {s.stats && <div data-hero-fig className="min-w-0 justify-self-end [grid-area:fig]"><HeadlineFigure figures={figures} usual={usual} /></div>}
        {/* Under the portrait: the state, then the permission mode and, for
          * a session Caprock started, the way to change it while it runs
          * (ADR-054). */}
        <div data-hero-lead className="grid min-w-0 content-start justify-items-center gap-[4px] text-center [grid-area:lead]">
          {/* The dot inline with the word, so a label that wraps ("Waiting /
            * on you" in a narrow inspector) keeps it beside its first line. */}
          <p data-hero-state className={`max-w-full text-[11.5px] font-medium leading-[14px] ${saysBackground ? 'whitespace-nowrap' : '[text-wrap:balance]'} ${STATE_TEXT[state]}`} role="status"
            title={saysBackground ? backgroundLabel(background) : undefined} aria-label={saysBackground ? backgroundLabel(background) : undefined}>
            <span className="cockpit-dot mr-1.5 inline-block h-[7px] w-[7px] rounded-full align-[1px]" data-state={state} />
            {label}{ago ? <span className="block font-normal text-fg-faint">{ago}</span> : null}
          </p>
          {state !== 'ended' && <p data-hero-mode className="flex max-w-full justify-center"><PermissionModeChip sessionId={sessionId} agent={s.agent} /></p>}
        </div>
        {s.stats && <div data-hero-sec className="min-w-0 justify-self-end [grid-area:sec]"><HeroSecondaries figures={figures} /></div>}
        {/* Always there, at least one line high, so nothing above it moves
          * when subagents start or finish (owner, 2026-10-13: "fix its
          * position and mark the subagents' place when nothing runs"). */}
        <div data-hero-chips className="flex min-w-0 items-start [grid-area:chips]">
          {count > 0 && state !== 'ended' && (
            <span data-hero-count className="mr-2.5 shrink-0 text-[11px] leading-[22px] text-fg-muted" title={`${count} ${count === 1 ? 'subagent' : 'subagents'} working`}>{count} working</span>
          )}
          <div ref={chipBox} className="flex min-w-0 flex-1 items-center">
            {strip.chips.length > 0
              ? <SubagentStrip chips={strip.chips} more={strip.more} compact={layout.compact} onChip={onChip} />
              : state !== 'ended' && <span data-hero-nosubs className="text-[11px] leading-[22px] text-fg-faint">no subagents running</span>}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * One mini-avatar per subagent on the hero's last row: its type's initial
 * in a tint fixed per type, pulsing while it works, accent while it waits
 * on you, muted once finished. In groups of five, a wider gap between
 * groups, wrapping between groups onto a second line, so the count reads by
 * fives (owner, 2026-10-14). Compact, when there are more than two full
 * lines' worth: a smaller square with no letter, its tint and state kept.
 * Then "+N" for the working left out. A chip opens its subagent's row in
 * the Subagents section below.
 */
function SubagentStrip({ chips, more, compact, onChip }: { chips: SubagentChip[]; more: number; compact: boolean; onChip: (id: string) => void }) {
  const groups = chipGroups(chips)
  const box = compact ? 'h-[10px] w-[10px] rounded-[3px]' : 'h-[18px] w-[18px] rounded-[5px] text-[10px] font-semibold'
  return (
    <div role="group" aria-label={`Subagents${more > 0 ? `, and ${more} more working` : ''}`} data-compact={compact || undefined}
      className={`flex min-w-0 flex-wrap items-center p-[2px] ${compact ? 'gap-x-[6px] gap-y-[6px]' : 'gap-x-2 gap-y-[4px]'}`} data-chips={chips.length}>
      {groups.map((g, i) => (
        <span key={i} data-chip-group className={`flex shrink-0 ${compact ? 'gap-[2px]' : 'gap-[3px]'}`}>
          {g.map((c) => (
            <button key={c.id} type="button" title={c.label} aria-label={`${c.label}. Open`} data-state={c.state} data-tone={c.tone}
              onClick={() => onChip(c.id)}
              className={`cockpit-subchip num relative grid place-items-center outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] ${box}`}>
              {compact ? null : c.initial}
            </button>
          ))}
          {i === groups.length - 1 && more > 0 && (
            <span title={`${more} more working`} className={`cockpit-subchip num relative ml-1 grid min-w-[18px] place-items-center rounded-[5px] px-1 text-[10px] font-medium ${compact ? 'h-[14px] leading-[14px]' : 'h-[18px]'}`} data-state="more">+{more}</span>
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
export function useMenuDismiss(open: boolean, box: RefObject<HTMLElement | null>, close: () => void) {
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
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)'))
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
function HeadlineFigure({ figures, usual }: { figures: SpendFigures; usual?: Usual }) {
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
  const vs = versus(headline, figures, usual)
  const days = usual?.days ?? 30
  return (
    <div ref={box} className="relative grid min-w-0 justify-items-end gap-[5px]" data-headline={headline}>
      <span className="cockpit-hero-num num whitespace-nowrap font-semibold leading-none tracking-[-0.03em] text-fg" data-long={num.length >= 8 ? '' : undefined}
        aria-label={`${meta.name} ${metricValue(headline, figures)}`} title={metricTitle(headline, figures)}>
        {num}{unit && <span className="text-[16px] font-medium text-fg-muted">{unit}</span>}
      </span>
      {/* How the headline compares with the viewer's own usual, left of
        * its name; under 340px a long name steps down to its short word
        * beside it, so the agent's name is never the one cut. */}
      <span className="flex items-center gap-1.5" data-usual-on={vs ? '' : undefined}>
      {vs && <UsualDelta v={vs} days={days} />}
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={`Headline: ${meta.name}. Choose what it shows`}
        onClick={() => setOpen((o) => !o)}
        title="Choose what this figure shows"
        className="-mr-1 inline-flex items-center gap-1 rounded-[5px] px-1 text-[11.5px] leading-[16px] text-fg-faint outline-none hover:bg-panel-2 hover:text-fg-muted focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] aria-expanded:bg-panel-2">
        <span data-label-long>{meta.name.toLowerCase()}</span><span data-label-short>{meta.short}</span><span aria-hidden className="text-[9px]">▾</span>
      </button>
      </span>
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
 * The spend details under Now, unfolded by default, foldable to one strip
 * (FoldSpark). The header carries a period chip (session · today · 7d · 30d) and
 * *Chart | Numbers*, both remembered per viewer (owner, 2026-10-12: "you
 * can choose what you see — the chart or the numbers — and which ones").
 * **Chart**, the default since the figures beside the agent carry the
 * numbers (owner, 2026-10-12: "where did you put the chart?"): the
 * period's spend by time, its total on the top line and the stretch under
 * the pointer at its right, and what the bars measure — cost, burn rate,
 * tokens or turns — picked from the ▾ after the total (ChartChooser), with
 * a dashed pace line for the usual stretch. **Numbers**: three figures in one row, each
 * label a menu that picks what sits there, never one twice and, for the
 * session, never one of the figures beside the agent again.
 */
function Spend({ s, sessionId, events, now, figures, summary }: { s: SessionSummary; sessionId: string; events: readonly Event[]; now: number; figures: SpendFigures; summary?: Summary }) {
  const { folded, hero, view, period, slots, chartBy } = useSpendPrefs()
  // Folded, the strip shows the period and the metric the chart shows.
  const range = usePeriodSummary(period, summary)
  // The session's bars, read once for the chart, the folded strip and the
  // menu's burn rate; nothing is read for Numbers.
  const own = useSessionBars(sessionId, events, chartBy, period === 'session' && (folded || view === 'chart'))
  if (!s.stats) return null
  const scope = periodScope(period)
  const pf: PeriodFigures = period === 'session'
    ? { ...figures, series: { step: own.step, bars: own.bars }, activeBurn: own.burn }
    : periodFigures(period, figures, range)
  // The usual is the last 30 days whatever the period; today's summary carries it.
  const usual = range?.usual ?? summary?.usual
  const chooser = <ChartChooser metric={chartBy} figures={pf} />
  return (
    <section aria-label="Spend" data-spend-view={folded ? undefined : view} data-spend-period={folded ? undefined : period} className="@container grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <button type="button" aria-expanded={!folded} onClick={() => setSpendPrefs({ folded: !folded })}
          aria-label={folded ? `Spend ${foldedFigures(chartBy, pf).map((f) => (foldWord(f.id) ? `${f.value} ${foldWord(f.id)}` : f.value)).join(' · ')}` : undefined}
          title={folded ? `Show the spend details · ${scope}` : 'Fold the spend details'}
          className={`-mx-1 flex min-w-0 flex-1 items-center gap-1.5 rounded-[6px] px-1 text-left outline-none hover:bg-panel-2 focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] ${folded ? 'py-1' : 'py-0.5'}`}>
          <Chevron open={!folded} />
          {folded ? (
            <FoldSpark bars={pf.series?.bars} metric={chartBy} figures={pf} period={period} usual={usual} />
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
        ? <SessionChart sessionId={sessionId} bars={own.bars} step={own.step} now={now} total={chartTotal(chartBy, pf)} metric={chartBy} chooser={chooser} usual={usual} />
        : !range
          ? <p data-spend-time data-spend-empty className="text-[12px] text-fg-muted">Reading {scope.split(' · ')[0]!.toLowerCase()}…</p>
          : !pf.series
            ? <p data-spend-time data-spend-empty className="text-[12px] text-fg-muted">This range’s summary has no spend by time to draw.</p>
            : <SpendChart id={`spend-time-${sessionId}`} bars={pf.series.bars} step={pf.series.step} now={now} total={chartTotal(chartBy, pf)} scope={scope.toLowerCase()} metric={chartBy} chooser={chooser} usual={usual} />)}
    </section>
  )
}

/**
 * The chart's ▾, after its figure on the top line: what the bars measure,
 * in the hero's own style (*$1,320.49 cost ▾*). Remembered per viewer.
 */
function ChartChooser({ metric, figures }: { metric: ChartMetric; figures: PeriodFigures }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  useMenuDismiss(open, box, () => setOpen(false))
  const meta = CHART_METRICS.find((m) => m.id === metric)!
  return (
    <span ref={box} className="shrink-0">
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={`The bars show ${meta.name.toLowerCase()}. Choose what they show`}
        title="Choose what the bars show" onClick={() => setOpen((o) => !o)}
        className="inline-flex items-baseline gap-1 whitespace-nowrap rounded-[5px] px-1 text-[12px] leading-[16px] text-fg-faint outline-none hover:bg-panel-2 hover:text-fg-muted focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] aria-expanded:bg-panel-2">
        {meta.short}<span aria-hidden className="text-[9px]">▾</span>
      </button>
      {open && (
        <div role="menu" aria-label="What the bars show" onKeyDown={onMenuKey}
          className="absolute inset-x-0 top-full z-30 mt-1 grid gap-0.5 rounded-[9px] border border-border-strong bg-panel p-1.5 shadow-lg">
          {CHART_METRICS.map((m) => (
            <button key={m.id} type="button" role="menuitemradio" aria-checked={m.id === metric}
              onClick={() => { setSpendPrefs({ chartBy: m.id }); setOpen(false) }} title={m.hint}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2 rounded-[6px] px-2 py-1.5 text-left outline-none hover:bg-panel-2 focus-visible:bg-panel-2 aria-checked:bg-accent/10">
              <span className={`truncate text-[13px] text-fg ${m.id === metric ? 'font-semibold' : ''}`}>{m.name}</span>
              <span className="num text-[12px] text-fg-muted">{chartValueText(m.id, chartTotal(m.id, figures))}</span>
              <span className="col-span-2 truncate text-[11.5px] text-fg-muted">{m.hint}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

/** "7d" before a folded strip's figures, when they are not the session's own. */
function FoldPeriod({ period }: { period: SpendPeriod }) {
  if (period === 'session') return null
  return <span className="num shrink-0 rounded-[4px] border border-[var(--app-hairline)] px-1 text-[10.5px] leading-[14px] text-fg-muted">{period}</span>
}

/** The short word after a folded figure: none for dollars, which say what they are. */
function foldWord(m: Metric): string {
  return m === 'cost' ? '' : HEADLINES.find((h) => h.id === m)?.short ?? ''
}

/**
 * The folded Spend: the chart's bars, 20px tall, with its pace line and
 * tones, and three figures beside them — the chart's metric first in 13px
 * semibold, two quieter after it;
 * the third gives way in a cockpit under 340px (a container query on the
 * section). It replaced a faint one-line sentence that a 330px cockpit cut
 * off (owner, 2026-10-13: "folded, a more noticeable line with metrics").
 */
function FoldSpark({ bars, metric, figures, period, usual }: { bars?: readonly SpendBar[]; metric: ChartMetric; figures: PeriodFigures; period: SpendPeriod; usual?: Usual }) {
  const figs = foldedFigures(metric, figures)
  const pace = bars ? paceOf(metric, bars, usual) : undefined
  return (
    <span data-spend-folded className="flex min-w-0 flex-1 items-center gap-2.5">
      <FoldPeriod period={period} />
      <span className="h-[20px] min-w-[40px] flex-1 border-b border-[var(--app-hairline)]">
        {bars && bars.length > 0 && <SpendBars bars={bars} metric={metric} height={20} pace={pace} />}
      </span>
      {figs.map((f, i) => (
        <span key={f.id} data-fold-fig={f.id} className={`num shrink-0 whitespace-nowrap text-[13px] leading-[18px] ${i === 0 ? 'font-semibold text-fg' : 'font-medium text-fg-muted'} ${i === 2 ? '@max-[340px]:hidden' : ''}`}>
          {f.value}{foldWord(f.id) && <span className="ml-0.5 text-[11.5px] font-normal text-fg-faint">{foldWord(f.id)}</span>}
        </span>
      ))}
    </span>
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

/**
 * A section label that switches its section between its two looks:
 * compact (one line) and full; the chevron points down when full.
 */
function LookLabel({ name, full, onToggle, children }: { name: string; full: boolean; onToggle: () => void; children?: ReactNode }) {
  return (
    <button type="button" aria-expanded={full} onClick={onToggle}
      title={full ? `Compact ${name.toLowerCase()}: one line` : `Show the full ${name.toLowerCase()}`}
      className="-mx-1 flex shrink-0 items-center gap-1 rounded-[6px] px-1 py-0.5 text-left outline-none hover:bg-panel-2 focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
      <Chevron open={full} />
      <h4 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-faint">{children ?? name}</h4>
    </button>
  )
}

/**
 * How full the context is. Compact: one line, the label, a thin bar and
 * *14% · 140k / 1M*. Full: the meter with quarter marks and what every call
 * now pays to re-read it. Switched on the label, remembered per viewer.
 */
function ContextMeter({ s }: { s: SessionSummary }) {
  const { context: look } = useLooks()
  const full = look === 'full'
  const toggle = () => setLook('context', full ? 'compact' : 'full')
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
  const ink = tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-fg'
  const meter = (h: string) => (
    <div className={`cockpit-track relative ${h} overflow-hidden rounded-full`} role="meter" aria-label="Context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      <div className="cockpit-fill h-full rounded-full" data-tone={tone} style={{ width: `${Math.max(pct, 1.5)}%` }} />
      {[25, 50, 75].map((m) => <span key={m} aria-hidden className="absolute top-0 h-full w-px bg-[var(--app-chrome-bg)] opacity-70" style={{ left: `${m}%` }} />)}
    </div>
  )
  if (!full) {
    return (
      <section aria-label="Context" data-look="compact" className="flex min-w-0 items-center gap-2"
        title={ctx.next_call_usd > 0 ? `Every call now re-reads it for ${fmtUSD(ctx.next_call_usd)}` : undefined}>
        <LookLabel name="Context" full={false} onToggle={toggle} />
        <div className="min-w-[24px] flex-1">{meter('h-[5px]')}</div>
        <span className="num shrink-0 whitespace-nowrap text-[11.5px] text-fg-muted">
          <span className={`font-medium ${ink}`}>{fmtPct(pct)}</span> · <span className="text-fg">{fmtTokens(ctx.tokens)}</span> / {fmtTokens(ctx.window)}
        </span>
      </section>
    )
  }
  return (
    <section aria-label="Context" data-look="full" className="grid gap-2">
      <div className="flex items-center gap-2">
        <LookLabel name="Context" full onToggle={toggle} />
        <span className="num ml-auto text-[11.5px] text-fg-muted"><span className="text-fg">{fmtTokens(ctx.tokens)}</span> / {fmtTokens(ctx.window)}</span>
      </div>
      {meter('h-[9px]')}
      <p className="text-[11.5px] text-fg-muted">
        <span className={`num font-medium ${ink}`}>{fmtPct(pct)}</span> full
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
  const folded = useFolded()
  return (
    <section aria-label="Now" className="grid gap-2">
      <SectionLabel right={(
        <>
          {/* Folded, the section's one line: what it is doing. */}
          {folded && <span data-fold-only className="min-w-0 truncate text-fg-muted" title={detail || verb}>{verb}</span>}
          {plan && plan.total > 0 ? <span className="num shrink-0 text-fg-muted" title={plan.next ? `Next: ${plan.next}` : undefined}>plan {plan.done}/{plan.total}</span> : null}
        </>
      )}>Now</SectionLabel>
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
 * The subagents, one row each (SubagentRow), in a fixed order: by when each
 * started, first on top, a new one appended, a finished one dimmed with ✓ in
 * the place it held (`orderSubagents`; owner, 2026-10-14: "their order jumps
 * too, bad, I want fixed positions", translated). A row leads with its
 * type's letter, pulsing while it works, then what it is doing now across
 * the row's whole width, up to two lines, the full text on hover; under it,
 * dimmer, its current tool and the figures this viewer picked in *Show*
 * (calls, cost, model, time; cost and time until one picks); a badge while
 * it waits on a permission prompt. "+N finished" lists the rest of the
 * finished, "+N more working" the working past five. A cost is shown only
 * when the daemon knows it — never a $0 standing in for unknown.
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
  const fields = useSubagentFields()
  const box = useRef<HTMLElement>(null)
  // Each subagent's start as first seen, for this session: its row's place.
  const seen = useRef({ session: sessionId, starts: new Map<string, number>() })
  if (seen.current.session !== sessionId) seen.current = { session: sessionId, starts: new Map() }
  const working = orderSubagents(subs.working, seen.current.starts)
  const openIdx = open ? working.findIndex((a) => a.agent_id === open) : -1
  const showAllWorking = allWorking || openIdx >= SUBAGENT_ROWS
  const shown = showAllWorking ? working : working.slice(0, SUBAGENT_ROWS)
  const hidden = working.length - shown.length
  const recentAll = subs.recent ?? []
  const openDone = open ? recentAll.findIndex((d) => d.agent_id === open) : -1
  const room = Math.max(0, SUBAGENT_ROWS - shown.length)
  const recent = allFinished ? recentAll : recentAll.slice(0, Math.max(room, openDone + 1))
  const moreDone = subs.finished - recent.length
  const rows = orderSubagents<SubagentRowItem>([
    ...shown.map((a) => ({ agent_id: a.agent_id, started_at: a.started_at, a })),
    ...recent.map((d) => ({ agent_id: d.agent_id, started_at: d.started_at, d })),
  ], seen.current.starts)
  useEffect(() => {
    if (!reveal || !open) return
    const row = box.current?.querySelector(`[data-subagent="${CSS.escape(open)}"]`)
    row?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [reveal, open])
  const toggle = (id: string) => onOpen(open === id ? null : id)
  const { subagents: look } = useLooks()
  const cost = typeof subs.cost_usd === 'number' && <span className="num text-fg-muted" title="What every subagent of this session has cost">{fmtUSD(subs.cost_usd)}</span>
  if (look === 'compact') {
    // Folded: the heading and one line of what is in it.
    return (
      <section aria-label="Subagents" data-look="compact" className="flex min-w-0 items-center gap-2">
        <LookLabel name="Subagents" full={false} onToggle={() => setLook('subagents', 'full')}>Subagents · {subs.working.length}</LookLabel>
        <span data-fold-summary className="num ml-auto flex min-w-0 items-baseline gap-2 truncate whitespace-nowrap text-[11.5px] text-fg-faint">
          {subs.finished > 0 && <span>{subs.finished} finished</span>}
          {cost}
        </span>
      </section>
    )
  }
  return (
    <section ref={box} aria-label="Subagents" data-look="full" className="grid gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <LookLabel name="Subagents" full onToggle={() => setLook('subagents', 'compact')}>Subagents · {subs.working.length}</LookLabel>
        <div className="ml-auto flex items-baseline gap-2 text-[11.5px]">
          {cost}
          {(moreDone > 0 || allFinished) && subs.finished > 0 && (
            <button type="button" onClick={() => onAllFinished(!allFinished)} aria-expanded={allFinished}
              className="rounded-[4px] text-fg-faint outline-none hover:text-fg-muted focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
              {allFinished ? 'fewer finished' : `+${moreDone} finished`}
            </button>
          )}
          <SubagentShow fields={fields} />
        </div>
      </div>
      {rows.length > 0 && (
        <ul aria-label="Subagent rows" className="grid gap-1">
          {rows.map((r) => {
            const isOpen = open === r.agent_id
            const panel = `subagent-${r.agent_id}`
            const waiting = r.a ? subagentWaiting(r.a, permission) : false
            return (
              <li key={r.agent_id} data-subagent={r.agent_id} data-done={r.d ? 'true' : undefined}
                className={`grid rounded-[8px] border ${r.d && !isOpen ? 'border-transparent' : 'border-[var(--app-hairline)]'}`}
                data-waiting={waiting ? 'true' : undefined} data-open={isOpen ? 'true' : undefined}>
                <SubagentRow item={r} waiting={waiting} now={now} fields={fields} open={isOpen} panel={panel} onToggle={() => toggle(r.agent_id)} />
                {isOpen && <SubagentDetail id={panel} sessionId={sessionId} agentId={r.agent_id} now={now} />}
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
    </section>
  )
}

/** One row of the Subagents list: a working subagent (`a`) or a finished one (`d`). */
interface SubagentRowItem {
  agent_id: string
  started_at: number
  a?: Subagent
  d?: SubagentDone
}

/**
 * *Show ▾* in the Subagents header: what every row shows under its phrase —
 * a preset (Compact: the phrase alone; Cost: cost and time; Full: calls,
 * cost, model and time) or each figure on its own. Remembered per viewer.
 */
function SubagentShow({ fields }: { fields: SubagentFields }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useMenuDismiss(open, box, () => setOpen(false))
  const preset = presetOf(fields)
  const name = SUBAGENT_PRESETS.find((p) => p.id === preset)?.name ?? 'Custom'
  const item = 'flex items-center gap-2 rounded-[6px] px-2 py-1 text-left text-[12px] text-fg outline-none hover:bg-panel-2 focus-visible:bg-panel-2'
  return (
    <div ref={box} className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={`Show: ${name}. Choose what each subagent row shows`}
        title={`Each row shows: ${name}`} onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-0.5 rounded-[4px] text-fg-faint outline-none hover:text-fg-muted focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] aria-expanded:text-fg">
        Show<span aria-hidden className="text-[8px]">▾</span>
      </button>
      {open && (
        <div role="menu" aria-label="What each subagent row shows" onKeyDown={onMenuKey}
          className="absolute right-0 top-full z-30 mt-1 grid w-[150px] gap-px rounded-[9px] border border-border-strong bg-panel p-1 shadow-lg">
          {SUBAGENT_PRESETS.map((p) => (
            <button key={p.id} type="button" role="menuitemradio" aria-checked={p.id === preset}
              onClick={() => { setSubagentFields(p.fields); setOpen(false) }} className={`${item} aria-checked:bg-accent/10 aria-checked:font-semibold`}>
              {p.name}
            </button>
          ))}
          <div role="separator" className="my-0.5 h-px bg-[var(--app-hairline)]" />
          {SUBAGENT_FIELDS.map((f) => (
            <button key={f.id} type="button" role="menuitemcheckbox" aria-checked={fields[f.id]} title={f.hint}
              onClick={() => setSubagentFields({ [f.id]: !fields[f.id] })} className={item}>
              <span aria-hidden className={`grid h-[12px] w-[12px] place-items-center rounded-[3px] border text-[9px] leading-none ${fields[f.id] ? 'border-accent bg-accent text-[var(--color-bg)]' : 'border-border-strong'}`}>{fields[f.id] ? '✓' : ''}</span>
              {f.name}
            </button>
          ))}
        </div>
      )}
    </div>
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

/** A row's figures, in the menu's order, only those picked and known. */
function subagentFigures(f: SubagentFields, x: { tool_calls: number; cost_usd?: number; model_display?: string }, ranMs: number): string {
  return [
    f.calls ? `${x.tool_calls} ${x.tool_calls === 1 ? 'call' : 'calls'}` : '',
    f.cost && typeof x.cost_usd === 'number' ? fmtUSD(x.cost_usd) : '',
    f.model ? x.model_display ?? '' : '',
    f.time && ranMs > 0 ? fmtRun(ranMs) : '',
  ].filter(Boolean).join(' · ')
}

/**
 * One subagent: its type as a letter, then what it is doing now in words
 * (`subagentDoing`: the call's own description, its tool and target, or its
 * task — Claude Code's own activity line is not written anywhere to read)
 * across the whole row, up to two lines, the rest on hover; a finished one
 * its task, dimmed, with ✓. Under it, dimmer, its current tool and how long
 * that has run, then the figures picked in *Show*; with none picked the row
 * is the letter and the phrase alone. The raw command or file is left out
 * when the phrase already says it (owner, 2026-10-13: picked over a layout
 * that kept it under the phrase).
 */
function SubagentRow({ item, waiting, now, fields, open, panel, onToggle }: {
  item: SubagentRowItem
  waiting: boolean
  now: number
  fields: SubagentFields
  open: boolean
  panel: string
  onToggle: () => void
}) {
  const { a, d } = item
  const doing = a ? subagentDoing(a) : { text: d?.description ?? '', from: undefined }
  const phrase = doing.text || (a ? 'starting' : d?.agent_type ?? 'subagent')
  const tool = a?.tool?.replace(/^mcp__(.+?)__/, '$1·') ?? ''
  const since = a?.running && a.tool_at ? fmtRun(Math.max(0, now - a.tool_at)) : ''
  const figures = a
    ? subagentFigures(fields, a, a.started_at ? Math.max(0, now - a.started_at) : 0)
    : d ? subagentFigures(fields, d, d.stopped_at - d.started_at) : ''
  const anyField = SUBAGENT_FIELDS.some(({ id }) => fields[id])
  // The raw line is left out when the phrase already says it: the call's own
  // description, or a phrase that names the same file or pattern.
  const showDetail = !!a && doing.from !== 'call' && !(a.detail && doing.text.includes(a.detail))
  const meta = waiting || (anyField && (!!figures || !!tool))
  const type = a?.agent_type ?? d?.agent_type
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={open ? panel : undefined}
      className={`grid gap-0.5 rounded-[8px] px-2 py-1.5 text-left outline-none hover:bg-[var(--app-row-hover)] focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] ${d ? 'opacity-70' : ''}`}
      title={[type, phrase, a?.description !== phrase ? a?.description : '', a?.tool && `${a.tool}${a.detail ? ` ${a.detail}` : ''}`, d && 'finished'].filter(Boolean).join(' — ')}>
      <span className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-1.5 text-[12px] leading-[16px]">
        <TypeChip type={type} state={d ? 'done' : waiting ? 'waiting' : 'working'} />
        <span data-doing={doing.from || undefined} className={`min-w-0 break-words line-clamp-2 ${d ? 'text-fg-muted' : doing.text ? 'text-fg' : 'text-fg-faint'}`}>{phrase}</span>
        <span className="flex h-[16px] items-center gap-1">
          {d && <span aria-label="finished" className="text-[11px] text-ok">✓</span>}
          <Chevron open={open} />
        </span>
      </span>
      {meta && (
        <span data-subagent-meta className="flex min-w-0 flex-wrap items-center gap-x-1.5 pl-[22px] text-[11px] text-fg-faint">
          {!waiting && a?.tool && (
            <span className="flex min-w-[11px] flex-[1_1_0%] items-center gap-1 overflow-hidden">
              <span className={`grid shrink-0 place-items-center ${a.running ? 'text-ok' : ''}`}><KindIcon kind={toolKind(a.tool)} size={11} /></span>
              <span className="min-w-0 truncate">
                <span className="text-fg-muted">{tool}</span>
                {showDetail && a.detail && <span className="mono ml-1 text-[10.5px]">{a.detail}</span>}
                {since && <span className="num ml-1 text-ok">{since}</span>}
              </span>
            </span>
          )}
          {waiting && <span className="shrink-0 rounded-[4px] bg-accent/15 px-1.5 text-[10.5px] font-medium text-accent">waiting on you</span>}
          {figures && <span data-figures className="num ml-auto max-w-full shrink-0 truncate" title={figures}>{figures}</span>}
        </span>
      )}
    </button>
  )
}

function capital(t: string): string {
  return t ? t[0]!.toUpperCase() + t.slice(1) : t
}

/**
 * One line when another live session works in this one's checkout — a
 * warning when both edited the same files in the last half hour — the same
 * chip as the Live pulse row (lib/overlap.ts), where the work is watched.
 */
function CheckoutShared({ s, live: running }: { s: SessionSummary; live: boolean }) {
  const chip = overlapChip(useOverlap(running), s, sessionTitle(s))
  return chip ? <OverlapLine chip={chip} /> : null
}

/**
 * The loop alert, as on Now (components/LoopAlertCard.tsx) minus "Open
 * session": this is the session. Dismissed or muted here, it is gone on Now
 * too, and the other way round.
 */
function LoopWarning({ s, now }: { s: SessionSummary; now: number }) {
  const hidden = useLoopHidden()
  if (!s.loop || hidden(s.loop)) return null
  return <LoopAlertCard alert={s.loop} project="" owned={s.owned} now={now} onDismiss={() => live.dismissAlert(s.session_id)} />
}

/**
 * The plan's 5-hour and weekly windows. Compact: one line, *5h ▮ 12% ·
 * 05:40  Week ▮ 24% · Mon 13:00*, each with a tiny bar, the reset times
 * cut first when the line is narrow, never wrapped. Full: the plan chip and
 * a WindowBar per window. Switched on the label, remembered per viewer.
 */
function PlanWindows({ limits, agent, now, acct }: { limits: NonNullable<Summary['rate_limits']>; agent?: string; now: number; acct: SessionPlan }) {
  const source = acct.account && !acct.account.default ? `${agent === 'codex' ? 'Codex' : 'Claude Code'} (${acct.account.label})` : agent === 'codex' ? 'Codex' : 'Claude Code'
  const { plan, save: savePlan } = acct
  const { limits: look } = useLooks()
  const full = look === 'full'
  const toggle = () => setLook('limits', full ? 'compact' : 'full')
  const forecasts = agent !== 'codex'
  if (!full) {
    return (
      <section aria-label="Plan limits" data-look="compact" className="@container flex min-w-0 items-center gap-2">
        <LookLabel name="Plan limits" full={false} onToggle={toggle}>Plan</LookLabel>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2.5">
          {limits.five_hour && <WindowInline label="5h" name="5 hours" w={limits.five_hour} lenMs={WINDOW_MS.five_hour} now={now} source={source} forecasts={forecasts} />}
          {limits.seven_day && <WindowInline label="Week" name="Week" w={limits.seven_day} lenMs={WINDOW_MS.seven_day} now={now} source={source} forecasts={forecasts} />}
        </div>
      </section>
    )
  }
  return (
    <section aria-label="Plan limits" data-look="full" className="grid gap-2.5">
      {/* Which plan these are — and a click to correct it (owner, 2026-10-11:
        * "and you can confirm the plan there: is it really this one?"). */}
      <div className="flex items-center gap-2">
        <LookLabel name="Plan limits" full onToggle={toggle}>Plan</LookLabel>
        <div className="ml-auto flex items-baseline gap-2 text-[11.5px]">
          {agent === 'codex' ? <span className="text-fg-faint">{acct.account && !acct.account.default ? acct.account.label : 'all Codex sessions'}</span> : <PlanChip plan={plan} onSave={savePlan} account={acct.account} />}
        </div>
      </div>
      {limits.five_hour && <WindowBar label="5 hours" w={limits.five_hour} lenMs={WINDOW_MS.five_hour} now={now} source={source} forecasts={forecasts} />}
      {limits.seven_day && <WindowBar label="Week" w={limits.seven_day} lenMs={WINDOW_MS.seven_day} now={now} source={source} forecasts={forecasts} />}
    </section>
  )
}

/**
 * One window in the compact line: its short name, a tiny bar, the
 * percentage in its tone (amber or red when it runs out before the reset,
 * as the full bar), and when it resets — the part that gives way when
 * narrow: a weekly reset reads as its weekday alone under 22rem, then cuts.
 */
function weekday(ms: number): string {
  return new Date(ms).toLocaleDateString([], { weekday: 'short' })
}

function WindowInline({ label, name, w, lenMs, now, source, forecasts }: { label: string; name: string; w: RateWindow; lenMs: number; now: number; source: string; forecasts: boolean }) {
  const { stale } = readWindow(w, now)
  const p = pace(w, lenMs, now, { forecasts, stale })
  const clock = resetClock(p.resetMs, now)
  const long = p.resetMs - now > 24 * 3600 * 1000
  const tone = p.verdict === 'out' ? (p.urgent ? 'danger' : 'warn') : p.pct > 85 ? 'danger' : 'ok'
  const ink = stale ? 'text-fg-faint' : tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-fg'
  const title = stale
    ? `${name}: ${p.pct}% · ${source} has not refreshed this window recently`
    : `${name}: ${p.pct}% used · resets ${resetClock(p.resetMs, now)}${p.verdict === 'out' ? ` · out ${p.outAt ? `at ${resetClock(p.outAt, now)}` : 'now'}` : ''}`
  return (
    <span data-window={name} title={title} className="flex min-w-0 items-center gap-1 text-[11.5px]">
      <span className="shrink-0 text-fg-muted">{label}</span>
      <span aria-hidden className="cockpit-track relative h-[5px] w-[20px] shrink-0 overflow-hidden rounded-full">
        <span className="cockpit-fill block h-full rounded-full" data-tone={tone === 'ok' ? 'accent' : tone} style={{ width: `${Math.max(4, Math.min(100, p.pct))}%` }} />
      </span>
      <span className={`num shrink-0 font-medium ${ink}`}>{p.pct}%</span>
      {/* The reset clock gives way first: a weekday alone in a narrow panel, cut after that. */}
      {!stale && (
        <span className="num min-w-0 truncate text-fg-faint">
          {long ? <><span className="@[22rem]:hidden">{weekday(p.resetMs)}</span><span className="hidden @[22rem]:inline">{clock}</span></> : clock}
        </span>
      )}
    </span>
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

/** A tool's name as the list writes it: an MCP tool as *server·tool*. */
function toolName(tool: string): string {
  return tool.startsWith('mcp__') ? tool.replace(/^mcp__(.+?)__/, '$1·') : tool
}

type OutcomeState = 'running' | 'lost' | 'failed' | 'stopped' | 'slow' | 'ok'

/** How a call ended, in the words and tone the list uses for it. */
function outcomeOf(r: ToolRun, now: number): { text: string; words: string; tone: string; state: OutcomeState } {
  if (r.endMs === undefined) {
    const ms = Math.max(0, now - r.startMs)
    return ms < RUNNING_STALE_MS
      ? { text: fmtRun(ms), words: `running for ${fmtRun(ms)}`, tone: 'text-ok', state: 'running' }
      : { text: 'no result', words: 'no result was recorded', tone: 'text-fg-faint', state: 'lost' }
  }
  const ms = Math.max(0, r.endMs - r.startMs)
  if (r.failed) {
    const text = r.exit !== undefined ? `exit ${r.exit}` : 'error'
    return { text, words: `failed${r.exit !== undefined ? ` with exit code ${r.exit}` : ''} after ${fmtRun(ms)}`, tone: 'text-danger', state: 'failed' }
  }
  if (r.interrupted) return { text: 'stopped', words: `stopped after ${fmtRun(ms)}`, tone: 'text-fg-muted', state: 'stopped' }
  if (ms >= SLOW_MS) return { text: fmtRun(ms), words: `succeeded in ${fmtRun(ms)}`, tone: 'text-fg-muted', state: 'slow' }
  return { text: '✓', words: `succeeded in ${fmtRun(ms)}`, tone: 'text-fg-faint', state: 'ok' }
}

/** A row's hover: the call in full, what Claude said it does, how it went, and when. */
function groupTitle(g: ToolGroup, now: number): string {
  const r = g.run
  const input = (r.input && typeof r.input === 'object' ? r.input : {}) as Record<string, unknown>
  const full = typeof input.command === 'string' ? input.command.split('\n')[0]! : typeof input.file_path === 'string' ? input.file_path : r.detail
  const said = typeof input.description === 'string' && input.description !== full ? input.description : ''
  const times = g.count > 1 ? ` · ${g.count} times in a row, ${fmtRun(g.totalMs)} in all` : ''
  return [`${toolName(r.tool)} ${full}`.trim(), said, `${outcomeOf(r, now).words}${times} · ${new Date(r.startMs).toLocaleTimeString()}`].filter(Boolean).join('\n')
}

/**
 * The main thread's newest calls, newest first, one row each: the kind's
 * glyph, the tool and what it acted on — a file relative to the session's
 * folder, a command's program and first words past its `cd` and variable
 * assignments (lib/cockpit toolTarget) — then how it ended and how long
 * ago. How it ended is the column that says something (owner, 2026-10-14,
 * translated: "honestly gives little information — the indicators say
 * nothing"): a faint ✓ for a quick success, the duration for a call of five
 * seconds or more, *exit 1* or *error* in red for a failure, *stopped*, the
 * running time in green for the call running now. The same call repeated in
 * a row is one row with ×N. The heading counts the failures among the rows
 * and every call the session has made (its subagents' included). It folds
 * on its label to one line, the newest call, like Context and Plan.
 */
function Timeline({ runs, total, now, cwd }: { runs: ToolRun[]; total?: number; now: number; cwd?: string }) {
  const { tools: look } = useLooks()
  const groups = useMemo(() => toolGroups(runs, TIMELINE_ROWS, cwd), [runs, cwd])
  const failed = groups.reduce((n, g) => n + (g.run.failed ? g.count : 0), 0)
  const scope = typeof total === 'number' && total > 0
    ? <span data-tools-total className="num text-fg-faint" title="Every tool call this session has made, its subagents' included">{total.toLocaleString('en-US')} this session</span>
    : null
  if (look === 'compact') {
    const g = groups[0]
    const how = g ? outcomeOf(g.run, now) : undefined
    return (
      <section aria-label="Recent tool calls" data-look="compact" className="flex min-w-0 items-center gap-2">
        <LookLabel name="Recent tools" full={false} onToggle={() => setLook('tools', 'full')} />
        {g && how ? (
          <span data-fold-summary className="flex min-w-0 flex-1 items-baseline justify-end gap-1.5 whitespace-nowrap text-[11.5px]" title={groupTitle(g, now)}>
            <span className="min-w-0 truncate text-fg-muted">{toolName(g.run.tool)}{g.target && <span className="mono ml-1 text-[11px] text-fg-faint">{g.target}</span>}</span>
            <span className={`num shrink-0 ${how.tone}`}>{how.text}</span>
            <span className="num shrink-0 text-fg-faint">{fmtAge(now - (g.run.endMs ?? g.run.startMs))}</span>
          </span>
        ) : <span className="ml-auto text-[11.5px] text-fg-faint">none yet</span>}
      </section>
    )
  }
  return (
    <section aria-label="Recent tool calls" data-look="full" className="grid gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <LookLabel name="Recent tools" full onToggle={() => setLook('tools', 'compact')} />
        <span className="ml-auto flex items-baseline gap-2 text-[11.5px]">
          {failed > 0 && <span data-tools-failed className="num text-danger" title="Failed calls among the rows below">{failed} failed</span>}
          {scope}
        </span>
      </div>
      {groups.length === 0 ? (
        <p className="text-[11.5px] text-fg-faint">No tool calls yet.</p>
      ) : (
        <ol className="grid">
          {groups.map((g) => {
            const r = g.run
            const how = outcomeOf(r, now)
            const live = how.state === 'running'
            return (
              <li key={r.id} data-tool-row={how.state} className="cockpit-row grid grid-cols-[14px_minmax(0,1fr)_auto_28px] items-center gap-2 py-[4px]"
                data-live={live ? 'true' : undefined} title={groupTitle(g, now)}>
                <span className={`grid place-items-center ${how.state === 'failed' ? 'text-danger' : live ? 'text-ok' : 'text-fg-faint'}`}><KindIcon kind={r.kind} size={13} /></span>
                <span className="flex min-w-0 items-baseline gap-1.5 text-[12px]">
                  <span className={`shrink-0 ${how.state === 'failed' ? 'text-danger' : 'text-fg'}`}>{toolName(r.tool)}</span>
                  {g.target && <span data-tool-target className="mono min-w-0 truncate text-[11px] text-fg-muted">{g.target}</span>}
                  {g.count > 1 && <span data-tool-repeat className="num shrink-0 text-[11px] text-fg-faint">×{g.count}</span>}
                </span>
                <span data-tool-outcome aria-label={how.words} className={`num whitespace-nowrap text-right text-[11px] ${how.tone}`}>{how.text}</span>
                <span data-tool-age className="num text-right text-[11px] text-fg-faint">{fmtAge(now - (r.endMs ?? r.startMs))}</span>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
