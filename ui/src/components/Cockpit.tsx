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
import { contextSize } from '@/lib/gaps'
import { isUnpricedTurn } from '@/lib/sessionCost'
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
import { CHART_METRICS, HEADLINES, costNote, costText, METRICS, SCOPE_NAMES, SPEND_SCOPES, WINDOW_NAMES, chartTotal, chartValueText, foldedFigures, isWholeSession, metricTitle, metricValue, periodChip, pickHero, pickSlot, rangeFigures, setSpendPrefs, setSpendScope, setSpendWindow, shownPick, shownSlots, spendFigures, spendLabel, useSpendPick, useSpendPrefs, windowFigures, windowPhrase, windowStart, windowsFor, type ChartMetric, type Metric, type PeriodFigures, type RangeWindow, type SpendBar, type SpendFigures, type SpendPick, type SpendScope, type SpendView } from '@/lib/spendview'
import { UsualDelta } from './HeroUsual'
import { paceOf, versus, type Usual } from '@/lib/usual'
import { agentName } from './Characters'
import { HourChart, MatrixControls, SubFace, SubagentChipsLine, SubagentMatrix, SubagentStripLine, anySubagents } from './SubagentFaces'
import { matrixRoom, subagentFace, useSubagentLook } from '@/lib/subagentfaces'
import { useFaceDefault } from '@/lib/faces'
import { PickableFace, SessionCharacter } from './SessionFace'
import { AgentGlyph } from './AgentMarks'
import { SubscriptionTag } from './SubscriptionPicker'
import { TodoBlock } from './SessionTodos'
import { PermissionModeChip } from './PermissionModeChip'
import { KindIcon } from './KindIcon'
import { OverlapLine } from './OverlapLine'
import { LoopAlertCard } from './LoopAlertCard'
import { useLoopHidden } from '@/lib/loopalert'
import { overlapChip, useOverlap } from '@/lib/overlap'
import { sessionTitle } from '@/lib/sidebar'
import { presetOf, setSubagentFields, useSubagentFields, SUBAGENT_FIELDS, SUBAGENT_PRESETS, type SubagentFields } from '@/lib/subagentview'
import { buildSubagentTree, nodeTool, setNowView, useNowView, type NowView, type TreeNode } from '@/lib/subagentTree'
import { SubagentDetail, SubagentSteps } from './SubagentDetail'
import { SectionFrames } from './SectionFrames'
import { CompactAction, CompactIcon, CompactingLine, ContextBar, useCompact } from './CompactContext'
import { shownContext, tokShort } from '@/lib/compact'
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
export function useSubagents(sessionId: string, enabled: boolean, recent = 0, hour = false): SubagentsNow | undefined {
  const [data, setData] = useState<SubagentsNow | undefined>(undefined)
  const [tick, setTick] = useState(0)
  const last = useRef(0)
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    last.current = Date.now()
    api.subagents(sessionId, recent, hour)
      .then((r) => { if (alive && r && Array.isArray(r.working)) setData(r) })
      .catch(() => { /* an older daemon: no section */ })
    return () => { alive = false }
  }, [sessionId, enabled, tick, recent, hour])
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
export function Cockpit({ s, sessionId, hasPermission, summary, changes, ci, release, processes, title, place, headExtra }: {
  s: SessionSummary
  sessionId: string
  hasPermission: boolean
  summary?: Summary
  /** The session's name, which the hero's first row carries. */
  title?: string
  /** Where it works: the project only when it is not the name, a branch off the default. */
  place?: HeroPlace
  /** Lines the inspector puts under the name row (another account, the attempts). */
  headExtra?: ReactNode
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
  // The subagent a hero chip asked Now's tree to open, and whether *Show
  // all* is on — which asks the daemon for more than three finished.
  const [openSub, setOpenSub] = useState<string | null>(null)
  const [allFinished, setAllFinished] = useState(false)
  const [reveal, setReveal] = useState(0)
  // Claude Code is the agent with subagents Caprock hears from.
  const subs = useSubagents(sessionId, state !== 'ended' && (s.agent ?? 'claude') === 'claude', allFinished ? FINISHED_OPEN : 0, true)
  // A chip opens its subagent's entry in Now, unfolding Now if it was folded.
  const openFromChip = (id: string) => { setLook('now', 'full'); setOpenSub(id); setReveal((n) => n + 1) }
  const running = state === 'working' || state === 'looping' ? runningTool(runs, now) : undefined
  // A session on one of the user's subscriptions shows that account's
  // windows and plan; the day's summary carries the own sign-in's.
  const acct = useSessionPlan(s.agent, s.subscription)
  const plan = s.subscription ? windowsOf(acct.account) : planWindowsFor(s.agent, summary)
  const calls = useMemo(() => callsFromEvents(main), [main])
  const unpricedModels = useMemo(() => [...new Set(main.filter(isUnpricedTurn).map((e) => e.model ?? '').filter(Boolean))], [main])
  const figures = spendFigures(s, calls, unpricedModels)
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
        <Foldable id="now">
          <NowDoing s={s} state={state} running={running} last={runs[runs.length - 1]} permission={permission} background={backgroundAgents(s)} now={now}
            agents={subs && (subs.working.length > 0 || (subs.recent?.length ?? 0) > 0) ? (
              <NowAgents key={sessionId} subs={subs} permission={permission} now={now} sessionId={sessionId}
                background={backgroundAgents(s) > 0 && state === 'working'} focus={openSub} reveal={reveal}
                allFinished={allFinished} onAllFinished={setAllFinished} />
            ) : null}
            agentsWorking={(subs?.working.length ?? 0) > 0} />
        </Foldable>
        {s.loop && state !== 'ended' && <LoopWarning s={s} now={now} />}
        <CheckoutShared s={s} live={state !== 'ended'} />
      </>
    ),
    context: <ContextMeter s={s} />,
    limits: plan ? <PlanWindows limits={plan} agent={s.agent} now={now} acct={acct} /> : null,
    spend: <Spend s={s} sessionId={sessionId} events={main} now={now} figures={figures} summary={summary} />,
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
      <Hero s={s} sessionId={sessionId} state={state} asking={hasPermission || !!permission} now={now} background={hasPermission || permission ? 0 : backgroundAgents(s)} subs={subs} permission={permission} figures={figures} usual={summary?.usual} onChip={openFromChip} title={title} place={place} extra={headExtra} />
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

/** A section the cockpit folds for it: its SectionLabel becomes the chevron that folds it (exported for tests). */
export const FoldCtx = createContext<{ full: boolean; toggle: () => void } | null>(null)

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

/**
 * A section's head. `after` sits right after the label and takes the room
 * left (a folded CI line's PR title); `sub` is a second line under it, for a
 * section whose folded state needs two (CI: its checks and their action).
 */
export function SectionLabel({ children, right, after, sub }: { children: ReactNode; right?: ReactNode; after?: ReactNode; sub?: ReactNode }) {
  const fold = useContext(FoldCtx)
  if (fold) {
    const row = (
      <div data-section-head={sub ? undefined : ''} className="flex min-w-0 items-center gap-2">
        <button type="button" aria-expanded={fold.full} onClick={fold.toggle} title={fold.full ? 'Fold this section' : 'Show the whole section'}
          className="-mx-1 flex min-w-0 shrink-0 items-center gap-1 rounded-[6px] px-1 py-0.5 text-left outline-none hover:bg-panel-2 focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
          <Chevron open={fold.full} />
          <h4 className="truncate text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-faint">{children}</h4>
        </button>
        {after}
        {right && <div className={`ml-auto flex min-w-0 items-baseline gap-2 text-[11.5px]${after ? ' shrink-0' : ''}`}>{right}</div>}
      </div>
    )
    if (!sub) return row
    return (
      <div data-section-head className="grid min-w-0 gap-1">
        {row}
        {/* Under the section's word, not its chevron (12px and a 4px gap): the line belongs to the section (owner, 2026-11-19). */}
        <div data-section-sub className="flex min-w-0 items-center pl-4">{sub}</div>
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
 * Whether the hero's state and mode wrapped onto a line of their own under
 * the name: then they stand at the left, the header's last line, not at the
 * right over the figures. Measured, as only layout knows where a wrap falls.
 */
function useLeadWrapped(lead: RefObject<HTMLSpanElement | null>): boolean {
  const [wrapped, setWrapped] = useState(false)
  useLayoutEffect(() => {
    const el = lead.current
    const head = el?.parentElement
    if (!el || !head) return
    const check = () => {
      const prev = el.previousElementSibling as HTMLElement | null
      setWrapped(!!prev && el.offsetTop > prev.offsetTop + prev.offsetHeight / 2)
    }
    check()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(check)
    ro.observe(head)
    return () => ro.disconnect()
  }, [lead])
  return wrapped
}

/**
 * The top of the Agent panel: the session as a dense informer (owner,
 * 2026-10-29, translated: "the middle doesn't fit, and a lot of valuable
 * space is wasted there — it needs a super-efficient informer"; V2 of the
 * mockups). Nothing in it is cut: a row that does not fit wraps.
 *
 * - **The name row**: the session's name, the project only when it is
 *   not the name, and a branch off the default; at the right the state (dot
 *   and word, how long ago when idle) and the permission mode. In a narrow
 *   inspector the state moves under the name. In the chips and the strip the
 *   agent's own mark (AgentGlyph) leads it in a small tile tinted by the
 *   state — a click on it picks the session's face, and "try a duck?" now
 *   and then points out of it.
 * - **The pictures and the figures** (the matrix, the default look; owner,
 *   2026-11-06): at the left the session's portrait (its face, the same
 *   button) large, as tall as the figures, the mark a badge on its corner,
 *   and the subagents' faces in a grid centred beside it (SubagentMatrix);
 *   at the right the headline figure, burn rate by default, big with its
 *   comparison, the two smaller figures under it, right-aligned. In a hero
 *   narrower than 280px, where the two no longer fit side by side, the
 *   figures go under the pictures. In the other two looks the figures stand
 *   alone. Each figure is still a chooser.
 * - **The subagents' row**, in the chips and the strip (SubagentFaces): the
 *   chips, one per subagent in groups of five, as faces with *1 working ·
 *   peak 4* beside them; or the strip, one line of faces and a sparkline.
 *   Nothing when the session had no subagent.
 * - **The configuration** as small chips: the model, its reasoning effort
 *   when a hook named one ("Opus 5.5 · high") and its account, how
 *   full the context is (a bar and the percent), when it started. What the
 *   daemon does not report is left out.
 */
function Hero({ s, sessionId, state, asking, now, background, subs, permission, figures, usual, onChip, title, place, extra }: { s: SessionSummary; sessionId: string; state: CockpitState; asking: boolean; now: number; background: number; subs?: SubagentsNow; permission?: Permission | null; figures: SpendFigures; usual?: Usual; onChip: (id: string) => void; title?: string; place?: HeroPlace; extra?: ReactNode }) {
  const since = s.worked_at || s.last_event_at
  const saysBackground = background > 0 && state === 'working'
  const working = subs?.working.length ?? 0
  const chipBox = useRef<HTMLDivElement>(null)
  const layout = useChipLayout(chipBox, working)
  const look = useSubagentLook()
  const matrix = look === 'matrix'
  const strip = subagentChips(subs, permission, matrix ? matrixRoom(working) : layout.room)
  const count = working || (strip.chips.length === 0 ? s.live_subagents ?? 0 : 0) || (saysBackground ? background : 0)
  const shown = state === 'ended' ? 0 : count
  const any = anySubagents(subs, shown)
  const [hourOpen, setHourOpen] = useState(false)
  const model = s.model_display || s.model
  const effort = s.effort
  // One word: "Background agents" took two lines (owner, 2026-10-22). The
  // full phrase is the tooltip and what a screen reader announces.
  const label = saysBackground ? 'Background' : STATE_LABEL[state]
  const ago = (state === 'idle' || state === 'ended') && since ? fmtAgo(since, now) : ''
  const agent = s.agent ?? 'claude'
  // The project only when it says something the name does not ("caprock"
  // over "caprock" was the panel's first two lines).
  const project = place && title && place.project.trim().toLowerCase() !== title.trim().toLowerCase() ? place.project : ''
  // The agent: its mark in a small tile on the name row, or, in the matrix,
  // its portrait large at the left of the figures (the face picked for the
  // session, else its own from the default; owner, 2026-11-06, translated:
  // "bring the big icon back as it was, where you can set the little
  // agent's portrait") with the mark as a badge on the tile's corner, so
  // Claude and Codex still tell apart — never both.
  const mark = (big: boolean) => big ? (
    <PickableFace agent={agent} sessionId={sessionId} title={agentName(agent)} hint={!asking && (state === 'idle' || state === 'waiting')}
      className="cockpit-avatar cockpit-portrait relative grid min-h-[64px] w-[64px] shrink-0 place-items-center self-stretch rounded-[16px] @[340px]:min-h-[72px] @[340px]:w-[72px] @[340px]:rounded-[18px]" data-state={state}>
      <span data-hero-portrait className="grid place-items-center">
        <SessionCharacter agent={agent} sessionId={sessionId} size={62} className="cockpit-character @[340px]:h-[70px] @[340px]:w-[70px]" />
      </span>
      <span data-hero-agent aria-label={agentName(agent)}
        className="cockpit-portrait-badge pointer-events-none absolute -bottom-[3px] -right-[3px] grid h-[20px] w-[20px] place-items-center rounded-full">
        <AgentGlyph agent={agent} size={12} />
      </span>
    </PickableFace>
  ) : (
    <PickableFace agent={agent} sessionId={sessionId} title={agentName(agent)} hint={!asking && (state === 'idle' || state === 'waiting')}
      className="cockpit-avatar relative grid h-[24px] w-[24px] shrink-0 place-items-center rounded-[7px]" data-state={state}>
      <span data-hero-agent aria-label={agentName(agent)} className="grid place-items-center"><AgentGlyph agent={agent} size={15} /></span>
    </PickableFace>
  )
  // The state and the mode stand at the right of the name; when they wrap
  // under it (a long name and place), at the left, the header's last line,
  // so the figures' column never starts higher than the pictures' (owner,
  // 2026-11-06: the lopsided hero).
  const lead = useRef<HTMLSpanElement>(null)
  const wrapped = useLeadWrapped(lead)
  const faces = matrix && subs && any && strip.chips.length + strip.more > 0
  return (
    <div className="@container min-w-0">
      <div className="cockpit-hero grid min-w-0 grid-cols-[minmax(0,1fr)] gap-y-2" data-state={state}>
        <div data-hero-head className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {!matrix && mark(false)}
          {title && (
            <h3 className="min-w-0 break-words text-[14.5px] font-semibold leading-[20px] tracking-[-0.01em] text-fg" title={title}>{title}</h3>
          )}
          {place && (project || place.branch) && (
            <span data-hero-place className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[12px] leading-[20px]" title={place.path}
              aria-label={`Project ${place.project}${place.branch ? `, branch ${place.branch}` : ''}`}>
              {project && <span className="break-all font-medium text-fg-muted">{project}</span>}
              {place.branch && <span className="mono break-all text-[11px] text-fg-faint">{place.branch}</span>}
            </span>
          )}
          <span ref={lead} data-hero-lead data-wrapped={wrapped || undefined} className="ml-auto flex shrink-0 items-center gap-1.5 data-[wrapped]:ml-0">
            <p data-hero-state className={`whitespace-nowrap text-[11.5px] font-medium leading-[20px] ${STATE_TEXT[state]}`} role="status"
              title={saysBackground ? backgroundLabel(background) : undefined} aria-label={saysBackground ? backgroundLabel(background) : undefined}>
              <span className="cockpit-dot mr-1.5 inline-block h-[7px] w-[7px] rounded-full align-[1px]" data-state={state} />
              {label}{ago ? <span className="font-normal text-fg-faint"> {ago}</span> : null}
            </p>
            {state !== 'ended' && <span data-hero-mode className="flex"><PermissionModeChip sessionId={sessionId} agent={s.agent} /></span>}
          </span>
        </div>
        {extra}
        {matrix ? (
          // The matrix (owner, 2026-11-06): pictures at the left, the agent's
          // portrait and its subagents' faces centred on it; the figures at
          // the right. The portrait stretches to the figures' height, so the
          // two columns share their top and bottom edges (owner, 2026-11-06:
          // the lopsided hero). Under the pictures in a hero narrower than
          // 280px, where the two no longer fit side by side.
          <div data-hero-row data-look="matrix" className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-stretch gap-x-3 gap-y-2 @[280px]:grid-cols-[auto_minmax(0,1fr)]">
            <div data-hero-pics className="flex min-w-0 items-center gap-2">
              {mark(true)}
              {subs && faces && <SubagentMatrix subs={subs} count={shown} chips={strip.chips} more={strip.more} open={hourOpen} onToggle={() => setHourOpen((v) => !v)} onChip={onChip} />}
            </div>
            {s.stats && (
              <div data-hero-fig data-align="end" className="grid min-w-0 content-center gap-[3px] @[280px]:justify-items-end @[280px]:text-right">
                <HeadlineFigure figures={figures} usual={usual} end />
                <div data-hero-sec><HeroSecondaries figures={figures} end /></div>
              </div>
            )}
          </div>
        ) : s.stats && (
          <div data-hero-row className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-stretch gap-x-3 gap-y-2">
            <div data-hero-fig className="grid min-w-0 content-center gap-[3px]">
              <HeadlineFigure figures={figures} usual={usual} />
              <div data-hero-sec><HeroSecondaries figures={figures} /></div>
            </div>
          </div>
        )}
        {faces && hourOpen && subs?.hour && (
          <div data-hero-hourbox className="grid min-w-0 gap-1">
            <MatrixControls subs={subs} count={shown} open onToggle={() => setHourOpen(false)} />
            <HourChart hour={subs.hour} />
          </div>
        )}
        {/* Always measured; empty, and so hidden, while there is nothing to draw. */}
        <div ref={chipBox} data-hero-chips className="grid min-w-0 empty:hidden">
          {look === 'strip'
            ? subs && any && <SubagentStripLine subs={subs} count={shown} chips={strip.chips} more={strip.more} onChip={onChip} />
            : look === 'chips' && subs && any && (
              <SubagentChipsLine subs={subs} count={shown}
                chips={strip.chips.length > 0 ? <SubagentStrip chips={strip.chips} more={strip.more} compact={layout.compact} onChip={onChip} /> : null} />
            )}
        </div>
        {(model || effort || s.context || (s.started_at > 0 && state !== 'ended')) && (
          <div data-hero-config className="flex min-w-0 flex-wrap gap-1"
            title={[model, effort ? `${effort} reasoning effort` : '', s.context ? `${fmtPct(s.context.pct)} of the context window used (${contextSize(s.context, s.context_note, fmtTokens)})` : ''].filter(Boolean).join(' · ')}>
            {model ? (
              <span data-hero-model className={HERO_CHIP}>
                <span className="font-semibold text-fg">{model}{effort ? <span data-hero-effort className="font-normal text-fg-muted" aria-label={`${effort} reasoning effort`}> · {effort}</span> : null}</span>
                <SubscriptionTag id={s.subscription} agent={agent} className="text-[11px] font-normal text-fg-muted" />
              </span>
            ) : effort ? (
              <span data-hero-effort className={HERO_CHIP} aria-label={`${effort} reasoning effort`}>{effort} effort</span>
            ) : null}
            {s.context ? <ContextChip pct={s.context.pct} /> : null}
            {s.started_at > 0 && state !== 'ended' && (
              // "uptime 8d", not "started 8d ago": short enough to stay on the
              // model and context row's line (owner, 2026-10-31).
              <span data-hero-started className={HERO_CHIP} title={`Started ${new Date(s.started_at).toLocaleString()}`}>uptime {fmtAgo(s.started_at, now).replace(/ ago$/, '').replace(/^now$/, '0s')}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** Where the session works, as the inspector heads it (lib/projects sessionPlace). */
export type HeroPlace = { project: string; branch: string; path: string }

const HERO_CHIP = 'inline-flex items-center gap-1.5 whitespace-nowrap rounded-[5px] bg-[var(--app-row-hover)] px-1.5 text-[11.5px] leading-[20px] text-fg-muted'

/** How full the context is: a short bar and the percent, amber from 60%, red from 85%. */
function ContextChip({ pct }: { pct: number }) {
  const p = Math.max(0, Math.min(100, pct))
  const [bar, ink] = p >= 85 ? ['bg-danger', 'text-danger'] : p >= 60 ? ['bg-warn', 'text-warn'] : ['bg-ok', 'text-fg']
  return (
    <span data-hero-context className={HERO_CHIP}>
      <span aria-hidden className="relative h-[5px] w-[34px] overflow-hidden rounded-full bg-[var(--app-hairline)]">
        <span className={`absolute inset-y-0 left-0 rounded-full ${bar}`} style={{ width: `${p}%` }} />
      </span>
      <span className={`num ${ink}`}>{fmtPct(p)}</span> ctx
    </span>
  )
}

/**
 * One mini-avatar per subagent on the hero's last row (*Faces as chips*):
 * its subagent's face in a tint fixed per type, pulsing while it works,
 * accent while it waits on you, grey once finished. In groups of five, a
 * wider gap between groups, wrapping between groups onto a second line, so
 * the count reads by fives (owner, 2026-10-14). Compact, when there are
 * more than two full lines' worth: a smaller square with no face, its tint
 * and state kept. Then "+N" for the working left out. A chip opens its
 * subagent's entry in Now's tree below.
 */
function SubagentStrip({ chips, more, compact, onChip }: { chips: SubagentChip[]; more: number; compact: boolean; onChip: (id: string) => void }) {
  const groups = chipGroups(chips)
  const [d] = useFaceDefault()
  const box = compact ? 'h-[10px] w-[10px] rounded-[3px]' : 'h-[18px] w-[18px] rounded-[5px] text-[10px] font-semibold'
  return (
    <div role="group" aria-label={`Subagents${more > 0 ? `, and ${more} more working` : ''}`} data-compact={compact || undefined}
      className={`flex min-w-0 flex-wrap items-center p-[2px] ${compact ? 'gap-x-[6px] gap-y-[6px]' : 'gap-x-2 gap-y-[4px]'}`} data-chips={chips.length}>
      {groups.map((g, i) => (
        <span key={i} data-chip-group className={`flex shrink-0 ${compact ? 'gap-[2px]' : 'gap-[3px]'}`}>
          {g.map((c) => (
            <button key={c.id} type="button" title={c.label} aria-label={`${c.label}. Open`} data-state={c.state} data-tone={c.tone}
              onClick={() => onChip(c.id)}
              data-chip-face={compact ? undefined : c.id}
              className={`cockpit-subchip num relative grid place-items-center outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] ${box}`}>
              {compact ? null : <SubFace face={subagentFace(c.id, d)} size={16} className="cockpit-subchip-face" />}
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

/** A figure's menu under right-aligned figures (the matrix): it opens leftwards from 280px. */
const END_MENU = '@[280px]:left-auto @[280px]:right-0'

/**
 * What one of the three figures beside the agent can show: every metric
 * with its value and what it is. One another figure shows is marked, and
 * picking it swaps the two, so none is shown twice.
 */
function HeroMenu({ slot, hero, figures, label, end, onPick }: { slot: number; hero: readonly Metric[]; figures: SpendFigures; label: string; end?: boolean; onPick: (m: Metric) => void }) {
  return (
    <div role="menu" aria-label={label} onKeyDown={onMenuKey}
      className={`absolute left-0 top-full z-30 mt-1 grid w-[min(16rem,calc(100vw-32px))] gap-0.5 rounded-[9px] border border-border-strong bg-panel p-1.5 shadow-lg ${end ? END_MENU : ''}`}>
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
 * matters more to me"). With `end` (the matrix), right-aligned from 280px,
 * its menu opening leftwards.
 */
function HeadlineFigure({ figures, usual, end }: { figures: SpendFigures; usual?: Usual; end?: boolean }) {
  const { hero } = useSpendPrefs()
  const headline = hero[0]!
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const tweened = useTweened(figures.cost)
  const meta = HEADLINES.find((h) => h.id === headline) ?? HEADLINES[0]!
  useMenuDismiss(open, box, () => setOpen(false))
  const value = headline === 'cost' ? costText(figures, tweened) : metricValue(headline, figures)
  const [num, unit] = value.endsWith('/h') ? [value.slice(0, -2), '/h'] : [value, '']
  const choose = (m: Metric) => { setSpendPrefs({ hero: pickHero(hero, 0, m) }); setOpen(false) }
  const vs = versus(headline, figures, usual)
  const days = usual?.days ?? 30
  return (
    <div ref={box} className={`relative grid min-w-0 justify-items-start gap-[3px] ${end ? '@[280px]:justify-items-end' : ''}`} data-headline={headline}>
      <span className="cockpit-hero-num num whitespace-nowrap font-semibold leading-none tracking-[-0.03em] text-fg" data-long={num.length >= 8 ? '' : undefined}
        aria-label={`${meta.name} ${metricValue(headline, figures)}`} title={metricTitle(headline, figures)}>
        {num}{unit && <span className="text-[16px] font-medium text-fg-muted">{unit}</span>}
      </span>
      {/* How the headline compares with the viewer's own usual, left of
        * its name; under 340px a long name steps down to its short word
        * beside it, so the agent's name is never the one cut. */}
      <span className={`-ml-1 flex items-center gap-1.5 ${end ? '@[280px]:-mr-1 @[280px]:ml-0' : ''}`} data-usual-on={vs ? '' : undefined}>
      {vs && <UsualDelta v={vs} days={days} />}
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={`Headline: ${meta.name}. Choose what it shows`}
        onClick={() => setOpen((o) => !o)}
        title="Choose what this figure shows"
        className="inline-flex items-center gap-1 rounded-[5px] px-1 text-[11.5px] leading-[16px] text-fg-faint outline-none hover:bg-panel-2 hover:text-fg-muted focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] aria-expanded:bg-panel-2">
        <span data-label-long>{meta.name.toLowerCase()}</span><span data-label-short>{meta.short}</span><span aria-hidden className="text-[9px]">▾</span>
      </button>
      </span>
      {open && <HeroMenu slot={0} hero={hero} figures={figures} label="Headline figure" end={end} onPick={choose} />}
    </div>
  )
}

/**
 * The two smaller figures under the headline, one line each in 13px —
 * the value, then a short word for it and a ▾ (*$4.08/h burn ▾*, *4.01B
 * tok ▾*). Moved under the agent, they stand side by side on a row of
 * their own, right-aligned with `end` (the matrix) from 280px. Each line is
 * its own chooser over the same metrics as the headline, swapping rather
 * than repeating; tokens and cost until a viewer picks, remembered per
 * viewer.
 */
function HeroSecondaries({ figures, end }: { figures: SpendFigures; end?: boolean }) {
  const { hero } = useSpendPrefs()
  const [open, setOpen] = useState<number | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useMenuDismiss(open !== null, box, () => setOpen(null))
  const choose = (i: number, m: Metric) => { setSpendPrefs({ hero: pickHero(hero, i, m) }); setOpen(null) }
  return (
    <div ref={box} className={`relative -ml-1 flex flex-wrap items-baseline gap-x-0.5 ${end ? '@[280px]:-mr-1 @[280px]:ml-0 @[280px]:justify-end' : ''}`}>
      {[1, 2].map((i) => {
        const m = hero[i]!
        const meta = HEADLINES.find((h) => h.id === m)!
        const value = metricValue(m, figures)
        return (
          <button key={i} type="button" data-hero-line={m} aria-haspopup="menu" aria-expanded={open === i}
            aria-label={`${meta.name} ${value}. Choose what this line shows`} title={metricTitle(m, figures)}
            onClick={() => setOpen((o) => (o === i ? null : i))}
            className="inline-flex items-baseline gap-1 whitespace-nowrap rounded-[5px] px-1 text-[12px] leading-[18px] outline-none hover:bg-panel-2 focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] aria-expanded:bg-panel-2">
            <span className="num font-medium text-fg-muted">{value}</span>
            <span className="text-[11px] text-fg-faint">{meta.short}</span>
            <span aria-hidden className="text-[9px] text-fg-faint">▾</span>
          </button>
        )
      })}
      {open !== null && <HeroMenu slot={open} hero={hero} figures={figures} label={`What line ${open} shows`} end={end} onPick={(m) => choose(open, m)} />}
    </div>
  )
}

/**
 * The spend details under Now, unfolded by default, foldable to one strip
 * (FoldSpark). Two choices, per tab and in memory only (owner, 2026-10-22):
 * over when — *start · today · 7d · 30d* in the header, *start* (since the
 * session started, to now) for this session only and the default — and
 * whose spend, this session's or all sessions' (owner, 2026-11-19: "I'd
 * switch between this session and all sessions"), as *this session ▾* at
 * the right of the line under the header (WhoseMenu). The header holds the
 * period and *Chart | Numbers* on one line from 280 to 460px (owner,
 * 2026-11-19, variant B: three ragged rows at 330px were "not very tidy").
 * *Chart | Numbers* is remembered per viewer (owner, 2026-10-12: "you can
 * choose what you see — the chart or the numbers — and which ones").
 * **Chart**, the default since the figures beside the agent carry the
 * numbers (owner, 2026-10-12: "where did you put the chart?"): the
 * period's spend by time, its total on the top line, whose at its right,
 * and what the bars measure — cost, burn rate, tokens or turns —
 * picked from the ▾ after the total (ChartChooser), with a dashed pace line
 * for the usual stretch. **Numbers**: three figures in one row, each label a
 * menu that picks what sits there, never one twice and, for the whole
 * session, never one of the figures beside the agent again.
 */
function Spend({ s, sessionId, events, now, figures, summary }: { s: SessionSummary; sessionId: string; events: readonly Event[]; now: number; figures: SpendFigures; summary?: Summary }) {
  const { folded, hero, view, slots, chartBy } = useSpendPrefs()
  const made = useSpendPick(sessionId)
  const pick = shownPick(made)
  const whole = isWholeSession(pick)
  const part = pick.scope === 'session' && pick.window !== 'whole' ? pick.window : undefined
  const range = usePeriodSummary(pick.scope === 'all' ? pick.window as RangeWindow : undefined, summary)
  // The window a part of the session covers, to the minute: a new minute
  // re-buckets nothing until a call lands in it.
  const minute = Math.floor(now / 60_000) * 60_000
  const win = part ? { from: windowStart(part, now), to: minute + 59_999, unit: part === 'today' ? 'hour' as const : 'day' as const } : undefined
  // The session's bars, read once for the chart, the folded strip, the
  // menu's burn rate and a window's figures; nothing is read for Numbers
  // of the whole session.
  const own = useSessionBars(sessionId, events, chartBy, pick.scope === 'session' && (folded || view === 'chart' || !!part), win)
  if (!s.stats) return null
  const label = spendLabel(pick)
  const pf: PeriodFigures = whole
    ? { ...figures, series: { step: own.step, bars: own.bars }, activeBurn: own.burn }
    : part && win
      // The calls do not say which window an unpriced turn fell in: a session
      // with any marks every window's cost a lower bound (rule 6).
      ? { ...windowFigures(own.calls, win.from, win.to), series: { step: own.step, bars: own.bars }, ...(figures.unpriced ? { unpriced: figures.unpriced, unpricedModels: figures.unpricedModels } : {}) }
      : rangeFigures(range)
  // The usual is the last 30 days whatever the period; today's summary carries it.
  const usual = range?.usual ?? summary?.usual
  const chooser = <ChartChooser metric={chartBy} figures={pf} />
  const whose = <WhoseMenu pick={pick} label={label} onPick={(x) => setSpendScope(sessionId, x)} />
  // Whose, on a line of its own where no chart top line carries it.
  const whoseLine = <div data-spend-whose-line className="flex h-[18px] min-w-0 items-baseline text-[11px] leading-[18px]">{whose}</div>
  // Turns with no price: the cost total says partial, or unknown, never $0.00.
  const cost = chartBy === 'cost' ? costNote(pf) : undefined
  // A window of the session before its calls are read, or with none in it: a sentence, not zeros.
  const partNote = part && !own.loaded
    ? 'Reading this session’s calls…'
    : part && pf.empty ? `This session made no calls ${windowPhrase(part)}.` : undefined
  return (
    <section aria-label="Spend" data-spend-view={folded ? undefined : view} data-spend-scope={folded ? undefined : pick.scope} data-spend-period={folded ? undefined : pick.window}
      className="@container grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
      {/* One line from 280px: the period and Chart | Numbers at the right,
        * their paddings narrower under 300px; the title gives way first. */}
      <div data-spend-head className="flex min-w-0 items-center justify-end gap-x-1.5 @max-[300px]:gap-x-1">
        <button type="button" aria-expanded={!folded} onClick={() => setSpendPrefs({ folded: !folded })}
          aria-label={folded ? `Spend ${foldedFigures(chartBy, pf).map((f) => (foldWord(f.id) ? `${f.value} ${foldWord(f.id)}` : f.value)).join(' · ')}` : undefined}
          title={folded ? `Show the spend details · ${label}` : 'Fold the spend details'}
          className={`-ml-1 flex min-w-[56px] flex-1 items-center gap-1.5 rounded-[6px] px-1 text-left outline-none hover:bg-panel-2 focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] ${folded ? 'min-w-0 py-1' : 'py-0.5'}`}>
          <Chevron open={!folded} />
          {folded ? (
            <FoldSpark bars={pf.series?.bars} metric={chartBy} figures={pf} pick={pick} usual={usual} />
          ) : (
            <h4 className="min-w-0 truncate text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-faint">Spend</h4>
          )}
        </button>
        {!folded && (
          <span data-spend-choices className="flex shrink-0 items-center gap-x-1.5 @max-[300px]:gap-x-1">
            <Segmented label={`Period: ${label}`} value={pick.window} spoken dense
              options={windowsFor(pick.scope).map((w) => [w, WINDOW_NAMES[w].short, WINDOW_NAMES[w].long] as const)}
              onPick={(w) => setSpendWindow(sessionId, w)} />
            <Segmented label="Spend view" value={view} options={VIEW_OPTIONS} dense onPick={(v) => setSpendPrefs({ view: v })} />
          </span>
        )}
      </div>
      {!folded && (partNote || view === 'numbers' || (pick.scope === 'all' && !pf.series)) && whoseLine}
      {!folded && partNote && <p data-spend-time data-spend-empty className="text-[12px] text-fg-muted">{partNote}</p>}
      {!folded && !partNote && view === 'numbers' && <SpendNumbers pick={pick} hero={hero} slots={slots} figures={pf} label={label} />}
      {!folded && !partNote && view === 'chart' && (pick.scope === 'session'
        ? <SessionChart sessionId={sessionId} bars={own.bars} step={own.step} now={now} total={chartTotal(chartBy, pf)} metric={chartBy} chooser={chooser} usual={usual} cost={cost} scope={label.toLowerCase()} whose={whose} />
        : !range
          ? <p data-spend-time data-spend-empty className="text-[12px] text-fg-muted">Reading {label.split(' · ')[0]!.toLowerCase()}…</p>
          : !pf.series
            ? <p data-spend-time data-spend-empty className="text-[12px] text-fg-muted">This range’s summary has no spend by time to draw.</p>
            : <SpendChart id={`spend-time-${sessionId}`} bars={pf.series.bars} step={pf.series.step} now={now} total={chartTotal(chartBy, pf)} scope={label.toLowerCase()} metric={chartBy} chooser={chooser} usual={usual} cost={cost} whose={whose} />)}
    </section>
  )
}

/**
 * Whose spend, at the right of the chart's top line (or of its own line
 * over Numbers and the notes): *this session ▾* or *all sessions ▾*, a menu
 * of the two. The period is the header's chip, so the face leaves it out;
 * the spoken and hover name says both (*30 days · this session*).
 */
function WhoseMenu({ pick, label, onPick }: { pick: SpendPick; label: string; onPick: (s: SpendScope) => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  useMenuDismiss(open, box, () => setOpen(false))
  return (
    <span ref={box} data-spend-whose={pick.scope} className="relative ml-auto flex min-w-0 justify-end">
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={`${label}. Choose whose spend`}
        title={`${label} · choose whose spend`} onClick={() => setOpen((o) => !o)}
        className="inline-flex min-w-0 max-w-full items-baseline gap-1 whitespace-nowrap rounded-[5px] px-1 text-[11px] leading-[18px] text-fg-muted outline-none hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] aria-expanded:bg-panel-2">
        <span className="min-w-0 truncate">{SCOPE_NAMES[pick.scope].short}</span><span aria-hidden className="shrink-0 text-[9px]">▾</span>
      </button>
      {open && (
        <div role="menu" aria-label="Whose spend" onKeyDown={onMenuKey}
          className="absolute right-0 top-full z-30 mt-1 grid w-max min-w-[140px] gap-0.5 rounded-[9px] border border-border-strong bg-panel p-1 shadow-lg">
          {SPEND_SCOPES.map((x) => (
            <button key={x} type="button" role="menuitemradio" aria-checked={x === pick.scope}
              onClick={() => { onPick(x); setOpen(false) }}
              className={`rounded-[6px] px-2 py-1 text-left text-[12.5px] text-fg outline-none hover:bg-panel-2 focus-visible:bg-panel-2 aria-checked:bg-accent/10 ${x === pick.scope ? 'font-semibold' : ''}`}>
              {SCOPE_NAMES[x].long}
            </button>
          ))}
        </div>
      )}
    </span>
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

/** Whose figures a folded strip shows: *session*, *today · session* for a part of it, *today · all* for every session's. */
function FoldPeriod({ pick }: { pick: SpendPick }) {
  return <span data-fold-period={pick.window} data-fold-scope={pick.scope} title={spendLabel(pick)} className="num shrink-0 whitespace-nowrap rounded-[4px] border border-[var(--app-hairline)] px-1 text-[10.5px] leading-[14px] text-fg-muted">{periodChip(pick)}</span>
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
function FoldSpark({ bars, metric, figures, pick, usual }: { bars?: readonly SpendBar[]; metric: ChartMetric; figures: PeriodFigures; pick: SpendPick; usual?: Usual }) {
  const figs = foldedFigures(metric, figures)
  const pace = bars ? paceOf(metric, bars, usual) : undefined
  return (
    <span data-spend-folded className="flex min-w-0 flex-1 items-center gap-2.5">
      <FoldPeriod pick={pick} />
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
 * swaps the two, so none is shown twice. Remembered per viewer. A figure
 * from 1,000 up reads $7.92k, 13.71B (owner, 2026-11-19: "$7,924…" was cut
 * in a third of the cockpit); its exact value is its title and spoken name.
 */
function SpendNumbers({ pick, hero, slots, figures, label }: { pick: SpendPick; hero: readonly Metric[]; slots: readonly Metric[]; figures: PeriodFigures; label: string }) {
  const shown = shownSlots(slots, pick, hero)
  const [open, setOpen] = useState<number | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useMenuDismiss(open !== null, box, () => setOpen(null))
  const choose = (i: number, m: Metric) => { setSpendPrefs({ slots: pickSlot(shown, i, m) }); setOpen(null) }
  const when = label.toLowerCase()
  return (
    <div ref={box} data-spend-numbers className="relative grid min-w-0 grid-cols-[minmax(0,1fr)]">
      <dl className="grid min-w-0 grid-cols-3 gap-2">
        {shown.map((m, i) => {
          const meta = METRICS.find((x) => x.id === m)!
          const value = metricValue(m, figures)
          const short = metricValue(m, figures, true)
          const title = metricTitle(m, figures, pick)
          return (
            <div key={i} className="grid min-w-0 gap-0.5" data-slot={m}>
              <dt className="flex min-w-0">
                <button type="button" aria-haspopup="menu" aria-expanded={open === i} aria-label={`${meta.name}. Choose what this figure shows`}
                  title="Choose what this figure shows" onClick={() => setOpen((o) => (o === i ? null : i))}
                  className="-mx-1 flex min-w-0 items-center gap-0.5 rounded-[4px] px-1 text-[10px] uppercase leading-[14px] tracking-[0.06em] text-fg-faint outline-none hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] aria-expanded:text-fg">
                  <span className="min-w-0 truncate">{meta.label}</span><span aria-hidden className="shrink-0 text-[8px]">▾</span>
                </button>
              </dt>
              <dd aria-label={`${meta.name}, ${when}: ${value}`} title={short === value ? title : `${value} · ${title}`} data-exact={short === value ? undefined : value}
                className="num min-w-0 max-w-full truncate text-[18px] font-semibold leading-[22px] tracking-[-0.02em] text-fg">{short}</dd>
            </div>
          )
        })}
      </dl>
      {open !== null && (
        <div role="menu" aria-label={`What figure ${open + 1} shows`} onKeyDown={onMenuKey}
          className="absolute inset-x-0 top-full z-30 mt-1 grid gap-px rounded-[9px] border border-border-strong bg-panel p-1 shadow-lg">
          {METRICS.map((x) => {
            const beside = isWholeSession(pick) && hero.includes(x.id)
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
    <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" className={`shrink-0 text-fg-muted transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}>
      <path d="M4.5 2.5L8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * A small segmented choice: toggle buttons in one hairline frame, the picked
 * one filled. An option's third field names it on hover, and for a screen
 * reader when its face is not a word — or, with `spoken`, always: a short
 * face (*all*, *7d*) is read by its full name.
 */
function Segmented<T extends string>({ label, value, options, onPick, spoken, dense }: { label: string; value: T; options: readonly (readonly [T, ReactNode, string?])[]; onPick: (v: T) => void; spoken?: boolean; dense?: boolean }) {
  return (
    <div role="group" aria-label={label} className="flex shrink-0 items-center rounded-[6px] border border-[var(--app-hairline)] p-px">
      {options.map(([id, name, title]) => (
        <button key={id} type="button" aria-pressed={id === value} onClick={() => onPick(id)}
          aria-label={typeof name === 'string' && !spoken ? undefined : title} title={title}
          className={`grid h-[18px] place-items-center rounded-[5px] px-1.5 text-[11px] leading-[16px] ${dense ? '@max-[300px]:px-1' : ''} outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] ${id === value ? 'bg-panel-2 font-medium text-fg' : 'text-fg-muted hover:text-fg'}`}>
          {name}
        </button>
      ))}
    </div>
  )
}

/** How often a 7d or 30d summary (or today's, when the window does not hold one) is read while shown. */
const PERIOD_SUMMARY_MS = 30_000

/**
 * The summary behind an *all sessions* period: today's is the one the window
 * already polls (`given`); 7d and 30d are read from `/v1/stats/summary` only
 * while that period is shown, every 30 seconds.
 */
function usePeriodSummary(period: RangeWindow | undefined, given: Summary | undefined): Summary | undefined {
  const own = period === 'today' && given?.range === 'today' ? given : undefined
  const need = period !== undefined && !own
  const [got, setGot] = useState<{ period: RangeWindow; s: Summary } | undefined>(undefined)
  useEffect(() => {
    if (period === undefined || !need) return
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
  if (period === undefined) return undefined
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
 * After a compaction, the size it left (and *was 332k*) until a call
 * measures it; while one runs, stripes and *Compacting · 0:16* (CompactContext).
 */
function ContextMeter({ s }: { s: SessionSummary }) {
  const { context: look } = useLooks()
  const full = look === 'full'
  const toggle = () => setLook('context', full ? 'compact' : 'full')
  const compact = useCompact(s)
  const ctx = s.context
  if (!ctx) {
    return (
      <section aria-label="Context" className="grid gap-2">
        <SectionLabel right={<span className="text-fg-faint">{s.context_note ?? 'not measured yet'}</span>}>Context</SectionLabel>
      </section>
    )
  }
  const last = compact.view?.last
  const shown = shownContext(ctx, last)
  const pct = Math.max(0, Math.min(100, shown.pct))
  const tone = pct >= 85 ? 'danger' : pct >= 60 ? 'warn' : 'ok'
  const ink = tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-fg'
  const running = compact.phase.kind === 'running'
  const nextCall = shown.tokens === ctx.tokens ? ctx.next_call_usd : 0
  const ghost = shown.was && last && ctx.window > 0 ? { id: `${s.session_id}:${last.at}`, from: Math.min(100, (100 * shown.was) / ctx.window) } : undefined
  const meter = (h: string) => <ContextBar h={h} pct={pct} tone={tone} running={running} ghost={ghost} />
  if (!full) {
    return (
      <section aria-label="Context" data-look="compact" className="flex min-w-0 items-center gap-2"
        title={nextCall > 0 ? `Every call now re-reads it for ${fmtUSD(nextCall)}` : undefined}>
        <LookLabel name="Context" full={false} onToggle={toggle} />
        <div className="min-w-[24px] flex-1">{meter('h-[5px]')}</div>
        <span className="num shrink-0 whitespace-nowrap text-[11.5px] text-fg-muted">
          {running ? <CompactingLine view={compact.view} brief /> : <span className={`font-medium ${ink}`}>{fmtPct(pct)}</span>}{ctx.window > 0 && <> · <span className="text-fg">{fmtTokens(shown.tokens)}</span> / {fmtTokens(ctx.window)}</>}
        </span>
        <CompactIcon c={compact} />
      </section>
    )
  }
  return (
    <section aria-label="Context" data-look="full" className="grid gap-2">
      <div className="flex items-center gap-2">
        <LookLabel name="Context" full onToggle={toggle} />
        <span className="num ml-auto text-[11.5px] text-fg-muted">{ctx.window > 0 ? <><span className="text-fg">{fmtTokens(shown.tokens)}</span> / {fmtTokens(ctx.window)}</> : contextSize(ctx, s.context_note, fmtTokens)}</span>
      </div>
      {meter('h-[9px]')}
      <p className="text-[11.5px] text-fg-muted">
        {running ? <CompactingLine view={compact.view} /> : <><span className={`num font-medium ${ink}`}>{fmtPct(pct)}</span> full</>}
        {!running && shown.was && <> · was <span className="num">{tokShort(shown.was)}</span></>}
        {!running && !shown.was && nextCall > 0 && <> · every call now re-reads it for <span className="num text-fg">{fmtUSD(nextCall)}</span></>}
      </p>
      <CompactAction s={s} c={compact} />
    </section>
  )
}

function NowDoing({ s, state, running, last, permission, background, now, agents, agentsWorking }: {
  s: SessionSummary
  state: CockpitState
  running?: ToolRun
  last?: ToolRun
  permission?: Permission | null
  /** Subagents working after the turn ended (backgroundAgents). */
  background: number
  now: number
  /** The subagents' tree (NowAgents), drawn under the card while any works or finished lately. */
  agents?: ReactNode
  /** The tree lists working subagents: its header then says what the background card said. */
  agentsWorking?: boolean
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
  const view = useNowView()
  const fields = useSubagentFields()
  // Background agents at work: the tree's header is the card (owner, 2026-11-23).
  const cardIsTree = !permission && background > 0 && state === 'working' && !!agents && !!agentsWorking
  return (
    <section aria-label="Now" className="grid gap-2">
      <SectionLabel right={(
        <>
          {/* Folded, the section's one line: what it is doing. */}
          {folded && <span data-fold-only className="min-w-0 truncate text-fg-muted" title={detail || verb}>{verb}</span>}
          {plan && plan.total > 0 ? <span className="num shrink-0 text-fg-muted" title={plan.next ? `Next: ${plan.next}` : undefined}>plan {plan.done}/{plan.total}</span> : null}
          {!folded && agents && view === 'cards' && <SubagentShow fields={fields} />}
          {!folded && agents && (
            <Segmented label="How Now draws its subagents" value={view} onPick={setNowView}
              options={[['rows', 'Rows', 'One dense line per subagent'], ['cards', 'Cards', 'A card per subagent']] as const} />
          )}
        </>
      )}>Now</SectionLabel>
      {!cardIsTree && <div className="cockpit-now flex items-center gap-2.5 rounded-[10px] border px-2.5 py-2" data-state={state} data-running={running ? 'true' : undefined}>
        <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[7px] bg-[var(--app-row-active)]">{icon}</span>
        <span className="grid min-w-0 flex-1 leading-tight">
          <span className={`${permission ? 'line-clamp-2' : 'truncate'} text-[12.5px] font-medium text-fg`}>{verb}</span>
          {detail && (
            <span className={`mono text-[11.5px] text-fg-muted ${permission ? 'line-clamp-2 break-all' : 'truncate'}`} title={full || detail}>{detail}</span>
          )}
        </span>
        {right}
      </div>}
      {agents}
    </section>
  )
}

/**
 * The subagents as one tree inside *Now* (owner, 2026-11-23, picked from a
 * clickable mockup; it replaced a separate Subagents section under Spend).
 * A header row, *Background agents · N* while the turn has ended and they
 * work (*Subagents · N* while the main thread waits on them), with what
 * every subagent of the session has cost and how long the oldest working
 * one has run; a button that folds the tree, open by default while any
 * works and closed when only finished ones are left. Under it one entry per
 * working subagent, in a fixed order (`orderSubagents`), and the finished
 * folded into one *N done* entry that opens to them. An entry opens in
 * place to its newest few calls, newest last (SubagentSteps), its own
 * subagents nested under it behind a thin guide line (`buildSubagentTree`;
 * `/subagents` names no parent today, so the tree is one level deep), and
 * *Task, result and numbers*, which opens the whole SubagentDetail.
 *
 * Two looks, *Rows · Cards* in Now's header, kept per viewer
 * (`lib/subagentTree.ts`): **Cards**, the default, are the rows the
 * Subagents section always drew (SubagentRow: the type's letter, what it is
 * doing, its tool and the figures picked in *Show ▾*); **Rows** are one
 * dense line each — a dot, its phrase, its tool, cost · time. Nothing opens
 * on its own but the header; a hero chip opens its entry (and the header,
 * and *N done* for a finished one) and brings it into view. *Show all*,
 * under the tree when it holds some back, lists every working subagent and
 * up to 30 finished (what *+N more working* and *+N finished* did).
 */
function NowAgents({ subs, permission, now, sessionId, background, focus, reveal, allFinished, onAllFinished }: {
  subs: SubagentsNow
  permission?: Permission | null
  now: number
  sessionId: string
  /** The turn has ended and they still work (backgroundAgents). */
  background: boolean
  /** The entry a hero chip asked for, and a counter bumped on each ask. */
  focus: string | null
  reveal: number
  allFinished: boolean
  onAllFinished: (v: boolean) => void
}) {
  const view = useNowView()
  const fields = useSubagentFields()
  const box = useRef<HTMLDivElement>(null)
  const seen = useRef({ session: sessionId, starts: new Map<string, number>() })
  if (seen.current.session !== sessionId) seen.current = { session: sessionId, starts: new Map() }
  const tree = buildSubagentTree(subs, seen.current.starts)
  // null: the default, open while any works; a click sets it for the session.
  const [head, setHead] = useState<boolean | null>(null)
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())
  const [doneOpen, setDoneOpen] = useState(false)
  const [allWorking, setAllWorking] = useState(false)
  const open = head ?? tree.count > 0
  const id = `now-agents-${sessionId}`
  const toggle = (agent: string) => setOpened((s) => {
    const next = new Set(s)
    if (next.has(agent)) next.delete(agent)
    else next.add(agent)
    return next
  })
  // A hero chip: open the header, the entry and whatever hides it, then show it.
  useEffect(() => {
    if (!reveal || !focus) return
    setHead(true)
    setOpened((s) => (s.has(focus) ? s : new Set(s).add(focus)))
    if (tree.done.some((n) => n.agent_id === focus)) setDoneOpen(true)
    if (tree.working.findIndex((n) => n.agent_id === focus) >= SUBAGENT_ROWS) setAllWorking(true)
    const t = setTimeout(() => {
      box.current?.querySelector(`[data-subagent="${CSS.escape(focus)}"]`)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
    }, 0)
    return () => clearTimeout(t)
    // The tree is read when the chip asks, not again as it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, focus])

  const working = allWorking ? tree.working : tree.working.slice(0, SUBAGENT_ROWS)
  const held = tree.working.length - working.length + (allFinished ? 0 : tree.doneCount - tree.done.length)
  const whole = allWorking || allFinished
  const label = tree.count > 0
    ? `${background ? 'Background agents' : 'Subagents'} · ${tree.count}`
    : `Subagents · ${tree.doneCount} done`
  const figures = [
    tree.cost !== undefined ? fmtUSD(tree.cost) : '',
    tree.since !== undefined ? fmtRun(Math.max(0, now - tree.since)) : '',
  ].filter(Boolean).join(' · ')
  const entry = (n: TreeNode, depth: number) => (
    <AgentEntry key={n.agent_id} n={n} depth={depth} view={view} fields={fields} permission={permission} now={now} sessionId={sessionId}
      opened={opened} onToggle={toggle} />
  )
  const doneTitle = tree.doneCount === 1 && tree.done[0] ? ` · ${tree.done[0].d?.description || tree.done[0].d?.agent_type || 'subagent'}` : ''
  const doneFig = tree.doneCost !== undefined ? fmtUSD(tree.doneCost) : ''
  const showDone = tree.doneCount > 0
  return (
    <div ref={box} data-now-agents data-view={view} className="grid min-w-0 gap-1">
      <button type="button" data-agents-head aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setHead(!open)}
        title={[label, background ? 'Claude Code picks the session up when they finish' : '', subs.cost_usd !== undefined ? `What every subagent of this session has cost over its whole life: ${fmtUSD(subs.cost_usd)}` : ''].filter(Boolean).join(' — ')}
        className="cockpit-now flex min-w-0 items-center gap-2 rounded-[10px] border px-2.5 py-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
        data-state={tree.count > 0 ? 'working' : 'idle'}>
        <Chevron open={open} />
        <span className="grid min-w-0 flex-1 leading-tight">
          <span className="truncate text-[12.5px] font-medium text-fg">{label}</span>
          {background && tree.count > 0 && <span className="truncate text-[11.5px] text-fg-muted">resumes when they finish</span>}
        </span>
        {figures && <span data-agents-figures className="num shrink-0 text-[11.5px] text-fg-muted">{figures}</span>}
      </button>
      {open && (
        <ul id={id} aria-label="Subagents" className={`grid min-w-0 ${view === 'cards' ? 'gap-1' : 'gap-px'}`}>
          {working.map((n) => entry(n, 0))}
          {showDone && (
            <li data-agents-done data-open={doneOpen ? 'true' : undefined}
              className={view === 'cards' ? 'grid min-w-0 rounded-[8px] border border-dashed border-[var(--app-hairline)]' : 'grid min-w-0'}>
              <button type="button" aria-expanded={doneOpen} onClick={() => setDoneOpen((v) => !v)}
                title={`Subagents that finished in the last 30 minutes: ${tree.doneCount}`}
                className={`${view === 'cards' ? 'gap-1.5 rounded-[8px] px-2 py-1.5' : 'gap-1.5 rounded-[6px] px-1.5 py-[3px]'} grid min-w-0 grid-cols-[12px_minmax(0,1fr)_auto] items-center text-left text-[12px] leading-[16px] opacity-70 outline-none hover:bg-[var(--app-row-hover)] focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]`}>
                <Chevron open={doneOpen} />
                <span className="min-w-0 truncate text-fg-muted"><span aria-hidden className="mr-1 text-ok">✓</span>{tree.doneCount} done{doneTitle}</span>
                {doneFig && <span className="num shrink-0 text-[11px] text-fg-faint">{doneFig}</span>}
              </button>
              {doneOpen && (
                <ul aria-label="Finished subagents" className={`${GUIDE} ${view === 'cards' ? 'mb-1.5 mr-1.5 gap-1' : 'gap-px'}`}>
                  {tree.done.map((n) => entry(n, 1))}
                  {tree.done.length === 0 && <li className="px-1 text-[11px] text-fg-faint">Reading…</li>}
                </ul>
              )}
            </li>
          )}
        </ul>
      )}
      {open && (held > 0 || whole) && (
        <button type="button" data-agents-all onClick={() => {
          const next = !whole
          setAllWorking(next)
          onAllFinished(next)
          if (next) setDoneOpen(true)
        }}
          className="w-fit rounded-[4px] text-[11px] text-fg-faint outline-none hover:text-fg-muted focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
          {whole ? 'Show fewer' : 'Show all'}
        </button>
      )}
    </div>
  )
}

/** Where an entry's steps and its own subagents hang: indented behind a thin guide line. */
const GUIDE = 'ml-[11px] grid min-w-0 border-l border-[var(--app-hairline)] pl-2'

/**
 * One subagent in Now's tree, as a card (the Subagents section's row) or a
 * dense row; opened, its newest calls and its own subagents under a guide
 * line, recursively.
 */
function AgentEntry({ n, depth, view, fields, permission, now, sessionId, opened, onToggle }: {
  n: TreeNode
  depth: number
  view: NowView
  fields: SubagentFields
  permission?: Permission | null
  now: number
  sessionId: string
  opened: ReadonlySet<string>
  onToggle: (id: string) => void
}) {
  const [detail, setDetail] = useState(false)
  const isOpen = opened.has(n.agent_id)
  const panel = `subagent-${n.agent_id}`
  const waiting = n.a ? subagentWaiting(n.a, permission) : false
  const inside = isOpen && (
    <div id={panel} data-agent-inside className={`${GUIDE} gap-0.5 ${view === 'cards' && depth === 0 ? 'mb-1.5 mr-1.5' : 'mb-0.5'}`}>
      {detail
        ? <SubagentDetail sessionId={sessionId} agentId={n.agent_id} now={now} />
        : <SubagentSteps sessionId={sessionId} agentId={n.agent_id} now={now} working={!!n.a} />}
      <button type="button" aria-expanded={detail} onClick={() => setDetail((v) => !v)}
        className="w-fit rounded-[4px] px-1 text-[11px] text-fg-faint outline-none hover:text-fg-muted focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
        {detail ? 'Latest steps' : 'Task, result and numbers'}
      </button>
      {n.children.length > 0 && (
        <ul aria-label="Its subagents" className={`grid min-w-0 ${view === 'cards' ? 'gap-1' : 'gap-px'}`}>
          {n.children.map((c) => (
            <AgentEntry key={c.agent_id} n={c} depth={depth + 1} view={view} fields={fields} permission={permission} now={now} sessionId={sessionId}
              opened={opened} onToggle={onToggle} />
          ))}
        </ul>
      )}
    </div>
  )
  if (view === 'cards') {
    return (
      <li data-subagent={n.agent_id} data-done={n.d ? 'true' : undefined} data-waiting={waiting ? 'true' : undefined} data-open={isOpen ? 'true' : undefined}
        className={`grid min-w-0 rounded-[8px] border ${n.d && !isOpen ? 'border-transparent' : 'border-[var(--app-hairline)]'}`}>
        <SubagentRow item={n} waiting={waiting} now={now} fields={fields} open={isOpen} panel={panel} onToggle={() => onToggle(n.agent_id)} />
        {inside}
      </li>
    )
  }
  const { a, d } = n
  const doing = a ? subagentDoing(a) : { text: d?.description ?? '' }
  const phrase = doing.text || (a ? 'starting' : d?.agent_type ?? 'subagent')
  const tool = nodeTool(n)
  const cost = (a ?? d)?.cost_usd
  const ran = a ? (a.started_at ? Math.max(0, now - a.started_at) : 0) : d ? d.stopped_at - d.started_at : 0
  const fig = [typeof cost === 'number' ? fmtUSD(cost) : '', ran > 0 ? fmtRun(ran) : ''].filter(Boolean).join(' · ')
  const type = a?.agent_type ?? d?.agent_type
  return (
    <li data-subagent={n.agent_id} data-done={d ? 'true' : undefined} data-waiting={waiting ? 'true' : undefined} data-open={isOpen ? 'true' : undefined} className="grid min-w-0">
      <button type="button" onClick={() => onToggle(n.agent_id)} aria-expanded={isOpen} aria-controls={isOpen ? panel : undefined}
        title={[type, phrase, a?.tool && `${a.tool}${a.detail ? ` ${a.detail}` : ''}`, d && 'finished', waiting && 'waiting on you'].filter(Boolean).join(' — ')}
        className={`grid min-w-0 grid-cols-[12px_7px_minmax(0,1fr)_auto] items-center gap-1.5 rounded-[6px] px-1.5 py-[3px] text-left text-[12px] leading-[16px] outline-none hover:bg-[var(--app-row-hover)] focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] ${d ? 'opacity-70' : ''}`}>
        <Chevron open={isOpen} />
        <span aria-hidden data-dot className={`h-[7px] w-[7px] rounded-full ${d ? 'bg-fg-faint' : waiting ? 'bg-accent' : 'bg-ok'}`} />
        <span className="min-w-0 truncate">
          <span className={d ? 'text-fg-muted' : 'text-fg'}>{phrase}</span>
          {waiting
            ? <span className="ml-1.5 text-[10.5px] font-medium text-accent">waiting on you</span>
            : tool && <span className="mono ml-1.5 text-[10.5px] text-fg-faint">{tool}</span>}
        </span>
        <span className="num shrink-0 text-[11px] text-fg-muted">{d ? <span aria-label="finished" className="mr-1 text-ok">✓</span> : null}{fig}</span>
      </button>
      {inside}
    </li>
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
 * amber *runs out tomorrow 17:11*, red when that is under half an hour away; a click
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
            {p.verdict === 'out' && <span data-verdict="out" className={`font-medium ${p.urgent ? 'text-danger' : 'text-warn'}`}>⚠ runs out {p.outAt ? resetClock(p.outAt, now) : 'now'}</span>}
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
