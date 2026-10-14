/**
 * The session deck (.ai/21-app.md § What the user sees, Session deck): a band
 * under the terminal of the agent in front. Opening it pushes the terminal's
 * bottom up, so Claude Code's prompt sits nearer the middle of the screen
 * than its edge (owner, 2026-10-11, translated: "I basically type in the
 * centre, a bit below the middle of the screen — that's comfortable — and in
 * this new area show data useful to me while I work"), and the room it makes
 * carries one cell, *Pull requests & CI*: the session's pull requests, the
 * current one first, each with its state, its mini pipeline and its CI in
 * words, opening in place into the GitHub Actions jobs and steps; the
 * release build and the default branch behind a switch; the branch a chip in
 * its header (owner, 2026-10-12, translated: "Remove the Branch cell … CI/CD
 * and Pull requests should simply be merged properly into one, with all the
 * statuses, plus at least a couple of previous PRs"). No chart: the
 * dashboard has those (owner, 2026-10-11: "we already have charts
 * everywhere").
 *
 * The branch is what the workspace already holds; the CI and the pull
 * requests are read from GitHub by the daemon, which keeps each answer, while
 * the deck is open. Nothing is estimated but the release build's time left,
 * labelled so, and a figure that is not reported is left out rather than
 * drawn as zero.
 *
 * Cheap on purpose. It is a sibling of the terminals, so nothing here redraws
 * one. Closed, it is not mounted: no clock, no subscription. While its
 * divider is dragged the band grows over the terminal and the terminal's own
 * box changes once, on release — one fit and one PTY resize, not one per
 * frame. Arrow keys on the divider settle the same way.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { api, errText, listedJobs, type CIJob, type CILog, type CIRun, type CIStep, type DeckFresh, type SessionCI, type SessionPRLive, type SessionPRs, type SessionRepoCI, type SessionSummary, type SpawnRequest, type Summary } from '@/lib/api'
import { readDeck, writeDeck } from '@/lib/deckCache'
import { Freshness } from './Freshness'
import { DECK_DEFAULT, DECK_MAX_SHARE, clampDeck, deckKeyStep } from '@/lib/deck'
import { MiniPipeline } from './MiniPipeline'
import { CheckSummary } from './CheckSummary'
import { CHECKS_VIEWS, CI_VIEWS, byOSLine, jobVsMedian, runSpan, runVsMedian, type DeltaTone, type VsMedian, ciActive, ciElapsed, ciTone, fmtRun, investigateMessage, jobNodes, keyStep, orderPRs, osTag, prAge, prDotState, prReviewText, prChecks, prVerdict, readChecksView, readCIView, readOpenPR, releaseChip, releaseDoneText, releaseElapsed, releaseEstimateText, runnerTime, saveChecksView, saveCIView, saveOpenPR, type ChecksView, type CITone, type CIView, type PipeNode, type PRWordTone } from '@/lib/ci'
import { jobCostLabel, sumCostLabel, sumRuns, usageLine, type CICost, type CostLabel, type CostTone } from '@/lib/runnercost'
import { BRANCHES_SHOWN, STALE_TITLE, aheadBehind, branchPRDot, branchSpend, lastCommit, shownBranches, type SessionBranch, type SessionBranches } from '@/lib/branches'
import { sessionTitle } from '@/lib/sidebar'
import { useCanControl } from '@/lib/useCanControl'
import { githubApi } from '@/lib/github'
import { openExternal } from '@/lib/nudges'
import { keys } from '@/lib/appkeys'
import { hasConflict, isBehind, prAgents, prStatus, queuedFor, quickActions, QUICK_LABEL, topChip, typeable, type DeckWorktree, type PRAgent, type PRChip, type PRStatus } from '@/lib/prforce'
import { FORCE_LABEL, FORCE_TITLE, usePRForce, type ForceKind } from '@/lib/usePRForce'

/** How long arrow keys on the divider rest before the terminal is fitted to the new height. */
export const KEY_SETTLE_MS = 250

export interface SessionDeckProps {
  s: SessionSummary
  sessionId: string
  hasPermission: boolean
  /** The day's summary: the plan windows. */
  summary?: Summary
  /** Files changed in the session's checkout, as the sidebar counts them; absent when not known. */
  changed?: number
  /** The checkout's branch and commits not pushed, as the sidebar knows them. */
  branch?: string
  ahead?: number
  onReviewChanges?: () => void
  /** The height kept, in CSS pixels. */
  height: number
  /** A new height, once a drag or the arrow keys settle. */
  onResize: (height: number) => void
  /** Says something briefly at the foot of the window: Investigate's result. */
  onToast?: (text: string) => void
  /** The checkouts of the session's project and the live agents in each: who is on a PR's branch. */
  worktrees?: DeckWorktree[]
  /** Opens a session's tab: a PR row's agent mark. */
  onOpenSession?: (s: SessionSummary) => void
  /** Starts an agent and opens its tab; throws why it could not. */
  onStartAgent?: (req: SpawnRequest, title: string) => Promise<void>
  /** The project's finished copies, over the Branches view (components/CleanupLine). */
  cleanup?: ReactNode
}

export function SessionDeck(props: SessionDeckProps) {
  const { height, onResize } = props
  const box = useRef<HTMLDivElement>(null)
  // The height while the divider moves: the band is drawn at it, over the
  // terminal, and the terminal's own box waits for the release.
  const [draft, setDraft] = useState<number | null>(null)
  const settle = useRef(0)
  useEffect(() => () => window.clearTimeout(settle.current), [])

  const pane = () => box.current?.parentElement?.clientHeight || undefined
  const current = () => draft ?? (box.current?.getBoundingClientRect().height || height)

  const drag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const y0 = e.clientY
    const h0 = current()
    const p = pane()
    let last: number | null = null
    const onMove = (m: PointerEvent) => {
      last = clampDeck(h0 + (y0 - m.clientY), p)
      setDraft(last)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.documentElement.removeAttribute('data-deck-drag')
      if (last !== null && last !== Math.round(h0)) onResize(last)
      setDraft(null)
    }
    document.documentElement.setAttribute('data-deck-drag', '')
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const nudge = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && draft !== null) {
      e.preventDefault()
      window.clearTimeout(settle.current)
      setDraft(null)
      return
    }
    const next = deckKeyStep(e.key, current(), pane())
    if (next === undefined) return
    e.preventDefault()
    setDraft(next)
    window.clearTimeout(settle.current)
    settle.current = window.setTimeout(() => {
      onResize(next)
      setDraft(null)
    }, KEY_SETTLE_MS)
  }

  const shown = draft ?? height
  return (
    <div
      ref={box}
      data-deck
      className="relative shrink-0"
      // Never past its share of the pane, whatever was kept: a window made
      // smaller since must not leave the terminal a sliver.
      style={{ height: `min(${height}px, ${DECK_MAX_SHARE * 100}%)` }}
    >
      <section
        aria-label="Session deck"
        className="deck-band absolute inset-x-0 bottom-0 z-30 flex flex-col bg-[var(--app-chrome-bg)]"
        style={{ height: draft !== null ? `${draft}px` : '100%' }}
      >
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the session deck"
          aria-valuenow={Math.round(shown)}
          aria-valuemin={0}
          tabIndex={0}
          title={`Drag to resize · double-click for the default height · ${keys('⌘B')} hides it`}
          onPointerDown={drag}
          onKeyDown={nudge}
          onDoubleClick={() => onResize(clampDeck(DECK_DEFAULT, pane()))}
          className="deck-divider group absolute inset-x-0 -top-[4px] z-10 h-[8px] cursor-row-resize outline-none"
          data-dragging={draft !== null || undefined}
        >
          <span aria-hidden className="deck-grip absolute left-1/2 top-[2px] h-[4px] w-[36px] -translate-x-1/2 rounded-full" />
        </div>
        <DeckBody {...props} />
      </section>
    </div>
  )
}


function DeckBody({ s, sessionId, changed, branch, ahead, onReviewChanges, onToast, worktrees, onOpenSession, onStartAgent, cleanup }: SessionDeckProps) {
  return (
    // A container, so the row's quieter columns give way as the terminal
    // narrows (the sidebar and the inspector both open). No clock and no
    // event subscription: what it is doing and what it cost are the
    // sidebar's and the inspector's (owner, 2026-10-11: "Spent doesn't
    // help", "Working now is debatable").
    <div className="@container flex min-h-0 flex-1 items-stretch overflow-hidden">
      {/* No Expand or Hide here: the sidebar footer's PRs & CI button cycles
        * Hidden, Bar and Full page, beside ⌘B and ⇧⌘B (owner, 2026-10-14,
        * translated: "Expand/Hide inside the bar is not noticeable"). */}
      <PullsCI sessionId={sessionId} s={s} onToast={onToast} branch={branch || s.git_branch} changed={changed} ahead={ahead} onReview={onReviewChanges} worktrees={worktrees} onOpenSession={onOpenSession} onStartAgent={onStartAgent} cleanup={cleanup} />
    </div>
  )
}

/** Back from the large view: Collapse in the PRs & CI tab's top-right
 *  corner (⇧⌘B; Ctrl+Alt+Shift+B off macOS, where ⌘B is Ctrl+Shift+B).
 *  The deck itself has no Expand: the sidebar footer's button and ⇧⌘B. */
export function ExpandToggle({ collapse, onClick }: { collapse?: boolean; onClick: () => void }) {
  const k = keys('⇧⌘B')
  return (
    <button
      type="button"
      data-deck-expand={collapse ? undefined : ''}
      data-prs-back={collapse ? '' : undefined}
      onClick={onClick}
      aria-label={collapse ? `Collapse: back to the agent and its deck (${k})` : `Expand: pull requests and CI in a tab (${k})`}
      title={collapse
        ? 'Close this tab and show the agent’s terminal with its deck; the same key expands it again'
        : 'Pull requests and CI, large: the repository’s pull requests, each one’s jobs by runner, and the figures over two weeks, in a tab'}
      className="flex h-[26px] shrink-0 items-center gap-1.5 rounded-[6px] border border-accent/60 px-2 text-[12px] font-medium text-accent hover:bg-accent/10"
    >
      <ExpandIcon back={collapse} /> {collapse ? 'Collapse' : 'Expand'} <kbd aria-hidden className="app-kbd-key">{k}</kbd>
    </button>
  )
}

/** Two arrows out to the corners: the large view. */
export function ExpandIcon({ back }: { back?: boolean }) {
  return (
    <svg aria-hidden width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {back ? <path d="M6 2v4H2M10 14v-4h4M6 6 2 2M10 10l4 4" /> : <path d="M10 2h4v4M6 14H2v-4M14 2 9 7M2 14l5-5" />}
    </svg>
  )
}

/**
 * One click turns the GitHub integration on through the GitHub CLI's own
 * login (ADR-047: off until the user turns it on; this button is that).
 * Without a usable `gh`, Settings is where a token goes. True when connected.
 */
export async function connectGitHub(): Promise<boolean> {
  try {
    const st = await githubApi.connect('gh')
    if (st.connected) return true
  } catch { /* Settings says why */ }
  location.hash = '#/settings'
  return false
}

/** How often the CI of the open row, the release build and Main are asked
 *  again: soon while a job runs, else rarely. The daemon keeps a commit's
 *  runs 10 s while one runs and 2 min once all settled, so a poll inside
 *  that costs GitHub nothing. */
export const CI_RUNNING_MS = 12_000
export const CI_IDLE_MS = 60_000
/** The pull requests: sooner while a check runs. The daemon keeps each pull
 *  request about as long, so a poll it can answer from what it holds costs
 *  GitHub nothing. */
export const PRS_PENDING_MS = 20_000

const CI_TEXT: Record<CITone, string> = {
  running: 'text-warn', queued: 'text-fg-faint', pass: 'text-ok', fail: 'text-danger', skipped: 'text-fg-faint',
}

/** A job's or a step's state as a mark: a turning ring while it runs. */
export function CIMark({ tone }: { tone: CITone }) {
  if (tone === 'running') return <span role="img" aria-label="running" className="ci-spin inline-block h-[9px] w-[9px] shrink-0 rounded-full" />
  const mark = tone === 'pass' ? '✓' : tone === 'fail' ? '✗' : tone === 'queued' ? '○' : '–'
  return <span role="img" aria-label={tone === 'pass' ? 'passed' : tone === 'fail' ? 'failed' : tone} className={`w-[9px] shrink-0 text-center text-[11px] leading-none ${CI_TEXT[tone]}`}>{mark}</span>
}

/**
 * Investigate: a failed job, its step, link and the end of its log, queued
 * into the session in front as one message (ADR-053's queue: typed in at the
 * prompt, else when the turn ends). Only into a session Caprock started and
 * this device may control — rule 7: Caprock never types into a process it did
 * not start; otherwise the button is drawn disabled and its tooltip says why.
 */
interface InvestigateCtx {
  run: (job: CIJob, step?: string) => void
  /** Why it cannot be queued here; '' when it can. */
  why: string
  /** The job being queued now. */
  busy?: number
}
const Investigate = createContext<InvestigateCtx | null>(null)

function InvestigateButton({ job, step }: { job: CIJob; step?: string }) {
  const ctx = useContext(Investigate)
  if (!ctx) return null
  const busy = ctx.busy === job.id
  return (
    <button type="button" data-deck-ci-investigate disabled={!!ctx.why || busy} onClick={() => ctx.run(job, step)}
      title={ctx.why || 'Queue this failure — the job, its step, its link and the end of its log — into this agent, to investigate and fix. It types in at the prompt, else when the turn ends.'}
      className="rounded-[4px] border border-accent/50 px-1.5 text-[11px] font-medium text-accent hover:bg-accent/10 disabled:cursor-not-allowed disabled:border-[var(--app-hairline)] disabled:text-fg-faint">
      {busy ? 'Queueing…' : 'Investigate'}
    </button>
  )
}

/** Which view a job's log is read in: the route reads only jobs that view lists. */
type LogViewName = Exclude<CIView, 'branches'>
const LogView = createContext<{ view: LogViewName; pr?: number; onShown?: (d: 1 | -1) => void }>({ view: 'pr' })

/** How soon a poll is repeated when the daemon handed back the answer it
 *  kept while it composes a newer one: a local read, nothing asked of GitHub. */
const REFRESHING_MS = 1_500

/** A poll's state beside its answer: a read under way, the last one failed
 *  (and why), whether the shown answer came from the daemon since the view
 *  was opened, and a way to ask again now. */
export interface PollMeta {
  loading: boolean
  failed: boolean
  /** Why the last read failed, or why the daemon could not compose a newer
   *  answer (`refresh_error`): the shown one is older. */
  reason?: string
  /** The shown answer was read from the daemon since the view was opened —
   *  not only the copy kept from before (lib/deckCache). */
  confirmed: boolean
  /** Asks again now. */
  retry: () => void
}

const noRetry = () => {}

interface PollSnap<T> {
  k?: string
  d?: T
  at: number
}

function fromCache<T>(k: string | undefined): PollSnap<T> {
  const c = readDeck<T>(k)
  return { k, d: c?.d, at: c?.at ?? 0 }
}

/**
 * Asks read() while `on`, the deck open and the window visible: every
 * `fast` ms while busy() says something runs, else every CI_IDLE_MS. Hidden,
 * nothing is asked and no timer is armed; it asks again once the window is
 * shown (lib/visible: a hidden window does no work).
 * The last answer stays while it is off. With a cache key, the answer last
 * kept under it (lib/deckCache) is shown at once — after a remount, a
 * restart of the app, a switch of view — while the read revalidates it.
 * keep(prev, next) says a failed read's answer is worse than the one shown:
 * the shown one stays, marked failed.
 */
export function usePoll<T>(on: boolean, key: string, read: () => Promise<T>, busy: (d: T) => boolean, fast = CI_RUNNING_MS, cacheKey?: string, keep?: (prev: T, next: T) => boolean): [T | undefined, number, PollMeta] {
  const [snap, setSnap] = useState<PollSnap<T>>(() => fromCache<T>(cacheKey))
  const [meta, setMeta] = useState<Omit<PollMeta, 'retry'>>({ loading: false, failed: false, confirmed: false })
  const retryRef = useRef<() => void>(noRetry)
  const shown = !cacheKey || snap.k === cacheKey ? snap : fromCache<T>(cacheKey)
  const fn = useRef({ read, busy, keep, shown })
  useEffect(() => { fn.current = { read, busy, keep, shown } })
  useEffect(() => {
    if (!on) return
    let alive = true
    let timer = 0
    // "updating…" stands for the first read of what is shown and while the
    // daemon says a newer answer is being composed, not for every poll.
    let revalidating = true
    let busyTick = false
    const tick = async () => {
      if (busyTick) return
      busyTick = true
      let next = CI_IDLE_MS
      if (!document.hidden) {
        if (revalidating) setMeta((m) => (m.loading ? m : { ...m, loading: true }))
        try {
          const d = await fn.current.read()
          if (!alive) return
          const prev = fn.current.shown.d
          const worse = prev !== undefined && !!fn.current.keep?.(prev, d)
          if (!worse) {
            setSnap({ k: cacheKey, d, at: Date.now() })
            if (cacheKey) writeDeck(cacheKey, d)
          }
          const fresh = d as DeckFresh | undefined
          revalidating = !!fresh?.refreshing
          // An answer kept back while a newer one is composed is not a
          // failure: it is on its way. One the daemon could not replace is:
          // it says why (refresh_error), and the header says it.
          const reason = fresh?.refresh_error || (worse ? (d as { error?: { message?: string } } | undefined)?.error?.message : undefined) || undefined
          setMeta({ loading: revalidating, failed: (worse || !!reason) && !revalidating, reason, confirmed: !worse })
          if (fn.current.busy(d)) next = fast
          if (revalidating) next = Math.min(next, REFRESHING_MS)
        } catch (e) {
          // The last answer stays, said to be not refreshed, and why.
          if (alive) setMeta((m) => ({ loading: false, failed: true, reason: errText(e), confirmed: m.confirmed }))
        }
      }
      busyTick = false
      if (alive && !document.hidden) timer = window.setTimeout(() => void tick(), next)
    }
    retryRef.current = () => { if (alive && !busyTick) { window.clearTimeout(timer); revalidating = true; void tick() } }
    void tick()
    const onVisible = () => { if (!document.hidden) { window.clearTimeout(timer); void tick() } }
    document.addEventListener('visibilitychange', onVisible)
    return () => { alive = false; retryRef.current = noRetry; window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [on, key, fast, cacheKey])
  const retry = useCallback(() => retryRef.current(), [])
  return [shown.d, shown.at, { ...meta, retry }]
}

/** A failed read of a repository view kept over the answer it would replace. */
const keepRepoCI = (prev: SessionRepoCI, next: SessionRepoCI) => !!next.error && ((!!prev.release && !next.release) || (!!prev.ci && !next.ci))
const keepPRCI = (prev: SessionCI, next: SessionCI) => !!next.error && !!prev.ci && !next.ci
// The daemon's quick first answer (the rows as recorded, no live state) never replaces a list that had it.
const keepPRs = (prev: SessionPRs, next: SessionPRs) => !!next.refreshing && next.prs.every((p) => !p.live) && prev.prs.some((p) => !!p.live)
const keepBranches = (prev: SessionBranches, next: SessionBranches) => !!next.error && !prev.error && prev.branches.length > 0

export { Freshness } from './Freshness'

/** Three grey rows in the shape of the list: the first read ever of a view. */
export function DeckSkeleton({ label }: { label: string }) {
  return (
    <ul data-deck-skeleton aria-busy="true" aria-label={label} className="-mx-1 flex flex-col gap-[5px] px-1 pt-1">
      {[0.62, 0.48, 0.55].map((w, i) => (
        <li key={i} aria-hidden className="flex h-[14px] items-center gap-2 animate-pulse motion-reduce:animate-none">
          <span className="h-[8px] w-[8px] shrink-0 rounded-full bg-[var(--app-hairline)]" />
          <span className="h-[8px] w-[28px] shrink-0 rounded-[3px] bg-[var(--app-hairline)]" />
          <span className="h-[8px] rounded-[3px] bg-[var(--app-hairline)]" style={{ width: `${w * 100}%` }} />
          <span className="ml-auto h-[8px] w-[64px] shrink-0 rounded-[3px] bg-[var(--app-hairline)]" />
        </li>
      ))}
    </ul>
  )
}

const VIEW_LABEL: Record<CIView, string> = { pr: 'PRs', branches: 'Branches', release: 'Release', main: 'Main' }
const VIEW_TITLE: Record<CIView, string> = {
  pr: 'This session’s pull requests and their CI',
  branches: 'The repository’s branches: ahead and behind, last commit, pull request, and what Caprock’s sessions on each cost',
  release: 'The repository’s newest release build: a tag push or a published release',
  main: 'The newest run of each workflow on the default branch',
}

/** PRs | Branches | Release | Main, kept per viewer. */
export function CIViewSwitch({ view, onChange }: { view: CIView; onChange: (v: CIView) => void }) {
  return (
    <div role="tablist" aria-label="CI view" className="flex shrink-0 items-center gap-px rounded-[5px] border border-[var(--app-hairline)] p-px">
      {CI_VIEWS.map((v) => (
        <button key={v} type="button" role="tab" aria-selected={view === v} data-deck-ci-view={v} onClick={() => onChange(v)} title={VIEW_TITLE[v]}
          className={`rounded-[4px] px-1.5 text-[10.5px] leading-[16px] ${view === v ? 'bg-[var(--app-row-hover)] font-medium text-fg' : 'text-fg-faint hover:text-fg-muted'}`}>{VIEW_LABEL[v]}</button>
      ))}
    </div>
  )
}

const CHECKS_TITLE: Record<ChecksView, string> = {
  circles: 'A circle per check, in the order they started; hover for each one’s name, OS, state and time',
  summary: 'The checks counted by state: “✗ 1 failed ● 1 running ✓ 8”; hover for each one',
}

/** Checks: circles | summary — how the rows draw a PR's checks, kept per viewer. */
export function ChecksViewSwitch({ view, onChange }: { view: ChecksView; onChange: (v: ChecksView) => void }) {
  return (
    <div role="radiogroup" aria-label="Checks" data-deck-checks-view={view} className="flex shrink-0 items-center gap-1 text-[10.5px] text-fg-faint">
      <span aria-hidden className="hidden @min-[560px]:inline">Checks</span>
      <span className="flex items-center gap-px rounded-[5px] border border-[var(--app-hairline)] p-px">
        {CHECKS_VIEWS.map((v) => (
          <button key={v} type="button" role="radio" aria-checked={view === v} data-deck-checks={v} onClick={() => onChange(v)} title={CHECKS_TITLE[v]}
            className={`rounded-[4px] px-1.5 leading-[16px] ${view === v ? 'bg-[var(--app-row-hover)] font-medium text-fg' : 'text-fg-faint hover:text-fg-muted'}`}>{v}</button>
        ))}
      </span>
    </div>
  )
}

/** Why the Release or Main view has no repository, in a line. */
function noRepoLine(d: SessionRepoCI): string {
  return d.reason === 'not_github' ? 'This repository is not on GitHub.' : 'This session’s folder has no GitHub repository.'
}

/**
 * The branch the session works on, a mono chip in the cell's header — "→
 * main" when the current pull request is from it — and what is not
 * committed or pushed beside it, a click on which opens the Changes view.
 * It was a cell of its own until 2026-10-12 (owner: "Remove the Branch
 * cell — put it somewhere else").
 */
function BranchChip({ branch, base, changed, ahead, onReview }: { branch: string; base?: string; changed?: number; ahead?: number; onReview?: () => void }) {
  const bits = [changed ? `${changed} not committed` : '', ahead ? `${ahead} not pushed` : ''].filter(Boolean)
  const state = typeof changed === 'number' && !changed && !ahead ? 'clean' : bits.join(' · ')
  return (
    <span className="hidden min-w-0 items-baseline gap-1.5 @min-[480px]:flex">
      <span data-deck-branch title={`Branch ${branch}${base ? `, its pull request into ${base}` : ''}${state ? `\n${state}` : ''}`}
        className="mono min-w-0 truncate rounded-[4px] border border-[var(--app-hairline)] px-1 text-[10.5px] leading-[16px] text-fg-muted">
        {branch}{base && <span className="text-fg-faint"> → {base}</span>}
      </span>
      {bits.length > 0 && (onReview && changed
        ? <button type="button" data-deck-dirty onClick={onReview} title={`Review changes (${keys('⇧⌘G')})`}
            className="hidden shrink-0 text-[10.5px] text-warn underline-offset-2 hover:underline @min-[560px]:inline">{bits.join(' · ')}</button>
        : <span data-deck-dirty className="hidden shrink-0 text-[10.5px] text-warn @min-[560px]:inline">{bits.join(' · ')}</span>)}
    </span>
  )
}

/** Kept for the tests that reset the deck: the rows opened are kept per viewer now (lib/ci readOpenPR). */
export function forgetFoldedPRs() { /* nothing is held in memory */ }

/**
 * Scrolls `el` within its own scroll area (marked data-deck-scroll) only —
 * never the deck or the window, which scrollIntoView would also move: to the
 * top of the area when opened, just into view when folded back.
 */
function scrollInDeck(el: HTMLElement, mode: 'start' | 'nearest') {
  const area = el.parentElement?.closest<HTMLElement>('[data-deck-scroll]')
  if (!area) return
  const a = area.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  if (mode === 'start') area.scrollTop += r.top - a.top
  else if (r.top < a.top) area.scrollTop += r.top - a.top
  else if (r.bottom > a.bottom) area.scrollTop += Math.min(r.top - a.top, r.bottom - a.bottom)
}

export { forgetPRProgress } from '@/lib/usePRForce'

const CHIP_TEXT: Record<PRChip['tone'], string> = {
  fail: 'border-danger/45 text-danger', warn: 'border-warn/45 text-warn', muted: 'border-[var(--app-hairline)] text-fg-faint',
}
const AGENT_TINT: Record<PRAgent['word'], string> = {
  fixing: 'bg-ok/20 text-ok', waiting: 'bg-accent/20 text-accent', idle: 'bg-[var(--app-row-hover)] text-fg-muted',
}

const STATUS_TEXT: Record<PRStatus['word'], string> = { 'in work': 'text-accent', waiting: 'text-warn', queued: 'text-fg-muted' }

/**
 * Whether anything is on the PR, in one word — in work, waiting, queued —
 * with the initial of the agent on its branch beside it; an idle agent is
 * its initial alone. A click on an agent opens its tab.
 */
function StatusMark({ status, agents, onOpen }: { status?: PRStatus; agents: PRAgent[]; onOpen?: (s: SessionSummary) => void }) {
  const a = status?.agent ?? agents[0]
  if (!status && !a) return null
  const title = status?.title || agents.map((x) => x.title).join('\n')
  const inner = (
    <>
      {a && <span aria-hidden data-deck-pr-agent={a.word} className={`grid h-[14px] w-[14px] shrink-0 place-items-center rounded-[4px] text-[9px] font-semibold ${AGENT_TINT[a.word]}`}>{a.initial}</span>}
      {status?.word === 'in work' && <span aria-hidden className="ci-spin inline-block h-[7px] w-[7px] shrink-0 rounded-full" />}
      {status && <span className={`whitespace-nowrap ${STATUS_TEXT[status.word]}`}>{status.word}</span>}
      {agents.length > 1 && <span className="text-fg-faint">+{agents.length - 1}</span>}
    </>
  )
  const cls = 'flex shrink-0 items-center gap-1 rounded-[4px] px-0.5 text-[10.5px] leading-[14px]'
  return a && onOpen
    ? <button type="button" data-deck-pr-status={status?.word ?? 'idle'} onClick={(e) => { e.stopPropagation(); onOpen(a.session) }} title={`${title}\nOpen its tab`} className={`${cls} hover:bg-[var(--app-row-hover)]`}>{inner}</button>
    : <span data-deck-pr-status={status?.word ?? 'idle'} title={title} className={cls}>{inner}</span>
}

const WORD_TEXT: Record<PRWordTone, string> = {
  ok: 'text-ok', fail: 'text-danger', pending: 'text-warn', muted: 'text-fg-muted', faint: 'text-fg-faint',
}

/**
 * Pull requests & CI, one cell (owner, 2026-10-12). The PRs view lists the
 * session's pull requests, the open one first and then the earlier ones: a
 * state dot, the number and title, the mini pipeline, the CI in words, the
 * review, a conflict, the age. A row opens in place into its GitHub Actions
 * (owner, 2026-10-11, translated: "I want to see which steps run, how long
 * each step takes … what failed and with which error, and the time of each
 * stage, because runners are money"): a row per job with its state, OS and
 * time, ticking while it runs; a job opens into its steps, a failed step into
 * the lines around its error, with Investigate. One row is open at a time;
 * the current PR is open by default while it is open and has checks, so its
 * jobs fill the room rather than leaving it empty. The Release
 * and Main views stand behind the same switch. Asked only while the deck is
 * open and the window visible.
 */
function PullsCI({ sessionId, s, onToast, branch, changed, ahead, onReview, worktrees, onOpenSession, onStartAgent, cleanup, controls }: { controls?: ReactNode; sessionId: string; s: SessionSummary; onToast?: (text: string) => void; branch?: string; changed?: number; ahead?: number; onReview?: () => void; worktrees?: DeckWorktree[]; onOpenSession?: (s: SessionSummary) => void; onStartAgent?: (req: SpawnRequest, title: string) => Promise<void>; cleanup?: ReactNode }) {
  const canControl = useCanControl()
  const [busy, setBusy] = useState<number>()
  const [view, setViewState] = useState<CIView>(() => readCIView())
  const setView = (v: CIView) => { setViewState(v); saveCIView(v) }
  // A row's checks as circles (the default) or counted in words, per viewer.
  const [checks, setChecksState] = useState<ChecksView>(readChecksView)
  const setChecks = (v: ChecksView) => { setChecksState(v); saveChecksView(v) }
  // The rows' checks column is as wide as the widest row's checks need, so a
  // title takes every pixel the checks leave (owner, 2026-10-14, translated:
  // "use the space for the PR title — 'feat(app): …' is interesting to read").
  const prList = useRef<HTMLUListElement>(null)
  useLayoutEffect(() => {
    const ul = prList.current
    if (!ul) return
    let w = 0
    ul.querySelectorAll<HTMLElement>('[data-deck-pr-ci-fit]').forEach((el) => { w = Math.max(w, Math.ceil(el.getBoundingClientRect().width)) })
    if (w > 0) ul.style.setProperty('--deck-ci-w', `${w}px`)
    else ul.style.removeProperty('--deck-ci-w')
  })
  const [n, setN] = useState(0)
  const [connecting, setConnecting] = useState(false)
  // One job open at a time: its steps take the row, under a header that
  // stays in view while they scroll (owner, 2026-10-12, translated: "when
  // you start expanding things, you can't see a damn thing, and then it's
  // impossible to collapse").
  const [openJob, setOpenJob] = useState<number>()
  const autoOpened = useRef<Record<string, boolean>>({})
  const [now, setNow] = useState(() => Date.now())
  // What to bring into view once drawn: a job just opened (to the top of
  // its scroll area) or just folded (back to its row), or a PR opened.
  const scrollTo = useRef<{ sel: string; mode: 'start' | 'nearest'; focus?: boolean } | undefined>(undefined)
  const cell = useRef<HTMLDivElement>(null)
  // The row opened by a click, kept per viewer (lib/ci readOpenPR); 0 is the
  // overview of every row, which is where the deck opens until one is opened.
  const [chosen, setChosenState] = useState<number>(() => readOpenPR(sessionId))
  const setChosen = (n: number) => { setChosenState(n); saveOpenPR(sessionId, n) }
  // How many error logs are open: while one is, the earlier PRs fold into
  // one line so the error has the room.
  const [logs, setLogs] = useState(0)
  const onShown = useCallback((d: 1 | -1) => setLogs((x) => Math.max(0, x + d)), [])

  const key = `${sessionId}:${n}`
  // Sooner while a force action's progress stands, so it goes once done.
  const forceSoon = useRef(false)
  // Each view opens on the answer it was last given (lib/deckCache): a
  // session's PRs and their CI by session, the release build and Main by
  // repository, the branches by folder (its current branch leads).
  const repoScope = s.repo_root || s.cwd || sessionId
  const folderScope = s.cwd || s.repo_root || sessionId
  const [prsData, prsAt, prsMeta] = usePoll(view === 'pr', key, () => api.sessionPRs(sessionId), (d) => forceSoon.current || d.prs.some((p) => p.live?.checks.state === 'pending'), PRS_PENDING_MS, `prs:${sessionId}`, keepPRs)
  const rows = useMemo(() => orderPRs(prsData?.prs ?? []), [prsData])
  // No row opens by itself: the deck opens on the overview, every row on its
  // line with its circles (owner, 2026-10-13). A row opened by hand stays
  // open — while it is still one of the session's.
  const openPr = chosen > 0 && (!prsData || rows.some((p) => p.number === chosen)) ? chosen : 0
  const [prData, prAt] = usePoll(view === 'pr' && openPr > 0, `${key}:${openPr}`, () => api.sessionCI(sessionId, openPr), (d) => ciActive(d.ci), CI_RUNNING_MS, openPr > 0 ? `ci:${sessionId}:${openPr}` : undefined, keepPRCI)
  // The answer for the open row only: one for the row open before waits.
  // listedJobs here as well as in the fetch: a cached answer from an older
  // daemon can still carry `"jobs": null` (lib/api).
  const prCI = prData && prData.pr?.number === openPr ? listedJobs(prData) : undefined
  // Each PR's runs once read, so its row keeps its time against the median
  // after it is closed; nothing is asked for a row never opened.
  const [seenRuns, setSeenRuns] = useState<Record<number, CIRun[]>>({})
  useEffect(() => {
    const n = prCI?.pr?.number
    const r = prCI?.ci?.runs
    if (n && r) setSeenRuns((m) => (m[n] === r ? m : { ...m, [n]: r }))
  }, [prCI])
  // A PR's cost: the open row's commit sum, else the sum of the runs read.
  const prCost = (n: number): CICost | undefined => (prCI?.pr?.number === n && prCI.ci?.cost) || sumRuns((seenRuns[n] ?? []).map((r) => r.cost))
  // A settled PR's runs are read once while the deck is open, so its row says
  // its time against the median without being opened; the daemon keeps the
  // answer and a finished run's jobs, so this costs GitHub a read per PR.
  const asked = useRef<Record<string, boolean>>({})
  useEffect(() => {
    if (view !== 'pr' || !prsData?.connected) return
    const todo = rows.filter((p) => p.number !== openPr && !seenRuns[p.number] && !asked.current[`${sessionId}:${p.number}`]
      && p.live && (p.live.checks.state === 'pass' || p.live.checks.state === 'fail') && p.live.checks.items.length > 0)
    void (async () => {
      for (const p of todo) {
        asked.current[`${sessionId}:${p.number}`] = true
        try {
          const d = await api.sessionCI(sessionId, p.number)
          const r = d.ci?.runs
          if (d.pr?.number === p.number && r) setSeenRuns((m) => ({ ...m, [p.number]: r }))
        } catch { /* the row keeps its time without the median */ }
      }
    })()
  }, [view, prsData, rows, openPr, seenRuns, sessionId])
  // The release build is asked while the deck is open whatever the view, so
  // its chip shows a build under way from the other views too.
  const [relRaw, relAt, relMeta] = usePoll(true, key, () => api.sessionCIRelease(sessionId), (d) => d.release?.state === 'running', CI_RUNNING_MS, `release:${repoScope}`, keepRepoCI)
  const [mainRaw, mainAt, mainMeta] = usePoll(view === 'main', key, () => api.sessionCIMain(sessionId), (d) => ciActive(d.ci), CI_RUNNING_MS, `main:${repoScope}`, keepRepoCI)
  const relData = relRaw && listedJobs(relRaw)
  const mainData = mainRaw && listedJobs(mainRaw)
  // The branches, while that view is shown: local git and one cached list of
  // the repository's pull requests, so a poll costs GitHub nothing new.
  const [brData, brAt, brMeta] = usePoll(view === 'branches', key, () => api.sessionBranches(sessionId), (d) => d.branches.some((b) => b.live?.checks.state === 'pending'), PRS_PENDING_MS, `branches:${folderScope}`, keepBranches)
  // What GitHub billed for Actions this month, only while Main is shown; the
  // daemon keeps the answer 30 minutes, so the minute's poll costs nothing.
  const owner = mainData?.repo?.split('/')[0] ?? ''
  const [usage] = usePoll(view === 'main' && !!mainData?.connected && !!owner, `${key}:${owner}`, () => api.actionsUsage(owner), () => false)
  useEffect(() => { setNow(Date.now()) }, [prsAt, prAt, relAt, mainAt, brAt])

  const rel = relData?.release
  const ci = view === 'pr' ? prCI?.ci : view === 'main' ? mainData?.ci : undefined
  const runs: CIRun[] = useMemo(() => (view === 'release' ? (rel?.run ? [rel.run] : []) : ci?.runs ?? []), [view, rel?.run, ci?.runs])
  const why = !canControl ? 'This device can only watch. To act from it, open the Caprock app on your computer: Settings → Use on your phone, then press Let it control sessions next to this device.'
    : !s.owned ? 'Caprock did not start this session, so it never types into it. Start the agent from Caprock to queue CI failures to it.'
      : s.status === 'ended' || s.detached ? 'This session is no longer running here, so nothing can be queued to it.' : ''
  // The force actions (lib/usePRForce), shared with the PRs & CI tab.
  const { confirm, setConfirm, forcing, standing, active: forcingActive, forceWhy, confirmText, force } = usePRForce({
    sessionId, s, worktrees, onStartAgent, onToast, canControl, connected: prsData?.connected, why,
    runsOf: (p) => (prCI?.pr?.number === p.number ? prCI.ci?.runs : undefined),
    onDone: () => setN((x) => x + 1),
  })
  const forceActive = forcingActive(now)
  const relRunning = rel?.state === 'running'
  const prsRunning = view === 'pr' && rows.some((p) => p.live?.checks.state === 'pending')
  const active = ciActive(ci) || relRunning || prsRunning || forceActive
  forceSoon.current = forceActive
  // A clock only while something runs: a settled CI draws once.
  useEffect(() => {
    if (!active) return
    const t = window.setInterval(() => { if (!document.hidden) setNow(Date.now()) }, 1000)
    return () => window.clearInterval(t)
  }, [active])

  // The first failed job of each view, and of each PR, opens by itself once:
  // what failed is the question.
  const autoKey = view === 'pr' ? `pr:${openPr}` : view
  useEffect(() => {
    if (autoOpened.current[autoKey]) return
    const failed = runs.flatMap((r) => r.jobs).find((j) => ciTone(j) === 'fail')
    if (failed) {
      autoOpened.current[autoKey] = true
      setOpenJob(failed.id)
    }
  }, [runs, autoKey])

  const jobs = runs.flatMap((r) => r.jobs)
  // A job opened comes to the top of its scroll area, its header pinned
  // there; one folded goes back to its row, in view. Once it is drawn: a job
  // picked from a PR row waits for that PR's CI.
  useLayoutEffect(() => {
    const t = scrollTo.current
    if (!t) return
    const el = cell.current?.querySelector<HTMLElement>(t.sel)
    if (!el) return
    scrollTo.current = undefined
    scrollInDeck(el, t.mode)
    if (t.focus) el.querySelector<HTMLElement>('button[aria-expanded]')?.focus({ preventScroll: true })
  }, [openJob, runs, openPr, prCI])
  const openOne = (id: number) => {
    setOpenJob(id)
    scrollTo.current = { sel: `[data-deck-ci-job="${id}"]`, mode: 'start' }
  }
  // Folded, the job's own button keeps the focus, so Esc and the arrow of
  // the next look start from it.
  const fold = (id: number, focus = false) => {
    setOpenJob(undefined)
    scrollTo.current = { sel: `[data-deck-ci-job="${id}"]`, mode: 'nearest', focus }
  }
  const toggleJob = (id: number) => (openJob === id ? fold(id) : openOne(id))
  const pick = (node: PipeNode) => {
    if (!node.jobId) { if (node.url) openExternal(node.url); return }
    openOne(node.jobId)
  }
  // A PR row's click: open it (and only it), or fold it — remembered, so
  // the current PR stays folded once folded by hand.
  const togglePR = (n: number, focus = false) => {
    if (openPr === n) {
      setChosen(0)
      scrollTo.current = { sel: `[data-deck-pr="${n}"]`, mode: 'nearest', focus }
    } else {
      setChosen(n)
      scrollTo.current = { sel: `[data-deck-pr="${n}"]`, mode: 'nearest' }
    }
  }
  // A circle of a PR row: that row opens, at that job.
  const pickInRow = (pr: number, node: PipeNode) => {
    if (!node.jobId) { if (node.url) openExternal(node.url); return }
    setChosen(pr)
    pick(node)
  }

  // A branch's PR: in the PRs view when it is one of this session's, else on GitHub.
  const jumpToPR = (n: number, url: string) => {
    if (prsData && !prsData.prs.some((p) => p.number === n)) { openExternal(url); return }
    setChosen(n)
    setView('pr')
  }

  const connect = async () => {
    setConnecting(true)
    if (await connectGitHub()) setN((x) => x + 1)
    setConnecting(false)
  }

  const pr = prCI?.pr
  const logView: LogViewName = view === 'branches' ? 'pr' : view
  const investigate = async (job: CIJob, step?: string) => {
    if (why) return
    const run = runs.find((r) => r.id === job.run_id)
    const where = view === 'release' ? { text: `the release build of ${rel?.tag ?? run?.head_branch ?? 'the newest tag'}`, url: run?.html_url }
      : view === 'main' ? { text: `${mainData?.branch ?? ci?.branch ?? 'the default branch'} of ${mainData?.repo ?? ci?.repo ?? 'the repository'}`, url: run?.html_url }
        : undefined
    if (view === 'pr' && !pr) return
    setBusy(job.id)
    let lines: string[] = []
    try { lines = (await api.sessionCILog(sessionId, job.id, logView, logView === 'pr' ? pr?.number : undefined)).lines } catch { /* the message goes without the log; the job's link has it */ }
    const text = investigateMessage({ pr: view === 'pr' ? pr : undefined, where, workflow: run?.name, job, step: step ?? keyStep(job)?.name, lines })
    try {
      const res = await api.queueSend(sessionId, text)
      onToast?.(`${res.sent ? 'Sent to' : 'Queued for'} ${sessionTitle(s)}`)
    } catch (e) {
      onToast?.(`Not queued: ${errText(e)}`)
    } finally {
      setBusy(undefined)
    }
  }
  // The force actions on a pull request (owner, 2026-10-12, translated: "if
  // needed I want to FORCE a fix or a check"): each asks once, in a line
  // inside the row, and then says in the row what it is doing.
  const agentsOf = (p: SessionPRLive) => prAgents(p.live?.branch, worktrees)
  // Open, or not known otherwise while GitHub is not read: its actions are offered.
  const openish = (p: SessionPRLive) => (p.live ? p.live.state === 'open' : !p.merged_at && !p.closed_at)
  // What is queued for the agents on the open PRs' branches and for this
  // session, read with each PR poll: a PR with a message waiting is "queued".
  const [queues, setQueues] = useState<Record<string, { text: string }[]>>({})
  const queueIds = useMemo(() => {
    const ids = new Set<string>()
    for (const p of rows) if (p.live?.state === 'open') for (const a of prAgents(p.live.branch, worktrees)) if (typeable(a.session)) ids.add(a.session.session_id)
    if (typeable(s)) ids.add(sessionId)
    return [...ids].sort().join(' ')
  }, [rows, worktrees, s, sessionId])
  useEffect(() => {
    if (view !== 'pr' || !queueIds) { setQueues({}); return }
    let on = true
    void Promise.all(queueIds.split(' ').map(async (id) => {
      try { return [id, (await api.queue(id)).messages ?? []] as const } catch { return [id, []] as const }
    })).then((xs) => { if (on) setQueues(Object.fromEntries(xs)) })
    return () => { on = false }
  }, [view, queueIds, prsData])
  // ⋯ on a row: open it, with the focus on its first action.
  const focusActions = useRef<number | undefined>(undefined)
  const openActions = (n: number) => {
    if (openPr !== n) togglePR(n)
    focusActions.current = n
  }
  useLayoutEffect(() => {
    const n = focusActions.current
    if (n === undefined) return
    const b = cell.current?.querySelector<HTMLElement>(`[data-deck-pr="${n}"] [data-deck-pr-actions] button:not([disabled])`)
    if (b) { focusActions.current = undefined; b.focus({ preventScroll: true }) }
  })
  const actionsFor = (p: SessionPRLive): ReactNode => {
    const live = p.live
    // Not connected: the actions are there, greyed, with the way to turn them on.
    if (!live && prsData && !prsData.connected && openish(p)) {
      return (
        <div data-deck-pr-actions className="flex min-w-0 items-center gap-1.5 overflow-hidden pb-0.5 pl-[34px] pr-1 text-[11px]">
          {(['conflict', 'ci', 'rerun', 'update'] as ForceKind[]).map((k) => (
            <button key={k} type="button" data-deck-pr-action={k} disabled title="Connect GitHub first: Caprock reads and acts on pull requests through your GitHub login"
              className="shrink-0 cursor-not-allowed rounded-[4px] border border-[var(--app-hairline)] px-1.5 leading-[16px] text-fg-faint opacity-60">{FORCE_LABEL[k]}</button>
          ))}
          <button type="button" data-deck-pr-connect disabled={connecting} onClick={() => void connect()} title="Reads CI and acts on pull requests through your GitHub CLI login; turn it off in Settings → GitHub"
            className="shrink-0 text-accent hover:underline disabled:opacity-60">{connecting ? 'connecting…' : 'Connect GitHub'}</button>
        </div>
      )
    }
    if (!live || live.state !== 'open') return null
    const kinds: ForceKind[] = []
    if (hasConflict(p)) kinds.push('conflict')
    else if (isBehind(p)) kinds.push('update')
    if (live.checks.items.length > 0) kinds.push('ci', 'rerun')
    if (kinds.length === 0) return null
    const c = confirm?.pr === p.number ? confirm : undefined
    return (
      <div data-deck-pr-actions className="flex min-w-0 items-center gap-1.5 overflow-hidden pb-0.5 pl-[34px] pr-1 text-[11px]">
        {c ? (
          <>
            <span data-deck-pr-confirm className="min-w-0 truncate text-fg" title={confirmText(p, c.kind)}>{confirmText(p, c.kind)}</span>
            <button type="button" data-deck-pr-confirm-yes autoFocus onClick={() => void force(p, c.kind)}
              className="shrink-0 rounded-[4px] border border-accent/60 bg-accent/10 px-1.5 font-medium text-accent hover:bg-accent/20">Confirm</button>
            <button type="button" onClick={() => setConfirm(undefined)} title={`Cancel (${keys('Esc')})`}
              className="shrink-0 rounded-[4px] px-1 text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">Cancel</button>
          </>
        ) : kinds.map((k) => {
          const no = forceWhy(p, k)
          return (
            <button key={k} type="button" data-deck-pr-action={k} disabled={!!no || forcing === p.number} onClick={() => setConfirm({ pr: p.number, kind: k })}
              title={no || FORCE_TITLE[k]}
              className={`shrink-0 rounded-[4px] border px-1.5 leading-[16px] disabled:cursor-not-allowed disabled:border-[var(--app-hairline)] disabled:text-fg-faint ${k === 'conflict' ? 'border-danger/50 text-danger hover:bg-danger/10' : 'border-[var(--app-hairline)] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg'}`}>
              {FORCE_LABEL[k]}
            </button>
          )
        })}
      </div>
    )
  }
  // The one-word actions beside the row's problem chip: each opens the same
  // confirm line in the row as the ⋯ actions do, without opening its CI.
  const quickFor = (p: SessionPRLive): ReactNode => {
    const ks = quickActions(p)
    if (ks.length === 0) return null
    return ks.map((k) => {
      const no = forceWhy(p, k)
      return (
        <button key={k} type="button" data-deck-pr-quick={k} disabled={!!no || forcing === p.number}
          onClick={(e) => { e.stopPropagation(); setConfirm({ pr: p.number, kind: k }) }}
          title={no || FORCE_TITLE[k]}
          className="shrink-0 rounded-[3px] px-0.5 text-[11px] font-medium leading-[14px] text-accent hover:bg-accent/10 hover:underline disabled:cursor-not-allowed disabled:font-normal disabled:text-fg-faint disabled:no-underline disabled:hover:bg-transparent">
          {QUICK_LABEL[k]}
        </button>
      )
    })
  }
  const total = ci ? runnerTime(ci, now) : 0
  const runnerTitle = ci ? `Runner time, measured from GitHub’s job times${ciActive(ci) ? ' and the running jobs on the clock' : ''}${ci.by_os.length ? `\nFinished: ${byOSLine(ci)}` : ''}` : ''
  const ciCost = sumCostLabel(ci?.cost)
  const connectButton = (label: string) => (
    <button type="button" disabled={connecting} onClick={() => void connect()} title="Reads GitHub Actions through your GitHub CLI login; turn it off in Settings → GitHub"
      className="w-fit text-left text-[12px] text-accent hover:underline disabled:opacity-60">{connecting ? 'connecting…' : label}</button>
  )
  const quiet = (text: string, title?: string) => <p className="truncate text-[12px] text-fg-faint" title={title ?? text}>{text}</p>
  const vsCol = runs.some((r) => r.jobs.some((j) => j.baseline))
  const costCol = runs.some((r) => r.jobs.some((j) => j.cost && j.cost.reason !== 'unfinished'))
  const runList = (manyRuns: boolean, byOS: boolean) => (
    <ul data-deck-ci-jobs data-deck-scroll={view === 'pr' ? undefined : ''} className={view === 'pr' ? '' : '-mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain [container-type:size]'}>
      {runs.map((run) => (
        <li key={run.id} data-deck-ci-run={run.id}>
          {manyRuns && (
            <div data-deck-ci-run-head className="flex min-w-0 items-center gap-2 px-1 pt-0.5">
              <button type="button" onClick={() => run.html_url && openExternal(run.html_url)} title={`Open the ${run.name} run on GitHub`}
                className="flex min-w-0 items-center gap-1.5 truncate text-left text-[10px] font-semibold uppercase tracking-[0.06em] text-fg-faint hover:text-fg-muted">
                {view === 'main' && <CIMark tone={ciTone(run)} />}<span className="truncate">{run.name}</span>
              </button>
              <MiniPipeline nodes={jobNodes([run], now)} label={`${run.name}: its jobs`} onPick={pick} />
              <RunTime run={run} now={now} />
            </div>
          )}
          {/* The jobs flow into as many columns as the deck's width holds,
            * not one tall column with its right half empty; an open job
            * takes the whole width for its steps and error. */}
          <ul data-deck-ci-grid className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,330px),1fr))] gap-x-6">
            {run.jobs.map((job) => (
              <CIJobRow key={job.id} sessionId={sessionId} job={job} now={now} vsCol={vsCol} costCol={costCol} table={run.cost}
                open={openJob === job.id} onToggle={() => toggleJob(job.id)} />
            ))}
            {run.jobs.length === 0 && <li className="col-span-full px-1 text-[11px] text-fg-faint">{run.status === 'completed' ? 'No jobs reported.' : 'Waiting for a runner…'}</li>}
          </ul>
        </li>
      ))}
      {byOS && ci && ci.by_os.length > 1 && <li className="num truncate px-1 pt-0.5 text-[10.5px] text-fg-faint" title="The finished jobs’ runner time per OS, measured">{byOSLine(ci)}</li>}
    </ul>
  )

  // An open PR row: its CI, as the jobs and steps.
  const prDetail = (p: SessionPRLive): ReactNode => {
    if (prsData && !prsData.connected) return connectButton(`Connect GitHub to see #${p.number}’s CI`)
    if (!prCI) return quiet(prData?.error ? `CI not read: ${prData.error.message}` : 'Reading the CI…')
    if (!prCI.connected) return connectButton(`Connect GitHub to see #${p.number}’s CI`)
    if (!ci) return quiet(prCI.error ? `CI not read: ${prCI.error.message}` : `#${p.number}: no commit to read CI for.`, prCI.error?.message)
    if (jobs.length === 0) return quiet(`No GitHub Actions runs on #${p.number}’s head commit.`)
    const url = p.live?.url || p.url
    return (
      <>
        <div className="flex min-w-0 items-baseline gap-2 px-0 text-[10.5px] text-fg-faint">
          {/* One run: its cost is the runner total's, said once there. */}
          {runs.length === 1 && <><RunTime run={runs[0]!} now={now} noCost /><span aria-hidden>·</span></>}
          <span data-deck-ci-runner className="num shrink-0" title={runnerTitle}>runner <span className="text-fg">{fmtRun(total)}</span></span>
          {ciCost && <><span aria-hidden>·</span><CostText c={ciCost} data="ci" /></>}
          {ci.by_os.length > 1 && <span className="num truncate" title="The finished jobs’ runner time per OS, measured">{byOSLine(ci)}</span>}
          <button type="button" onClick={() => openExternal(`${url}/checks`)} className="ml-auto shrink-0 hover:text-fg-muted hover:underline">checks ↗</button>
        </div>
        {runList(runs.length > 1, false)}
        {ci.error && <p className="truncate text-[10.5px] text-warn" title={ci.error.message}>The last read failed; this is the one before.</p>}
      </>
    )
  }

  // While an error is open, or a job's steps, the earlier PRs fold into one
  // line so the open PR has the deck's height.
  const cramped = logs > 0 || (openJob !== undefined && jobs.some((j) => j.id === openJob))
  let body: ReactNode = null
  if (view === 'pr') {
    const d = prsData
    if (d && rows.length === 0) body = quiet('No PR from this session yet.')
    else if (d) {
      body = (
        // A column: every row keeps its line and the open one's CI takes
        // the height left, scrolling inside, so the earlier PRs stay in view.
        <ul ref={prList} data-deck-prs data-deck-scroll="" className="-mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
          {rows.map((p) => {
            if (cramped && openPr !== p.number) return null
            const agents = agentsOf(p)
            const progress = standing(p, agents, now)
            return (
            <PRRow key={p.url} p={p} now={now} checks={checks} runs={seenRuns[p.number]} cost={prCost(p.number)} open={openPr === p.number}
              onToggle={() => togglePR(p.number)}
              onPick={(node) => pickInRow(p.number, node)}
              agents={agents} onOpenAgent={onOpenSession} status={prStatus(p, agents, progress, queuedFor(p, agents, queues))}
              quick={quickFor(p)}
              actions={openPr === p.number || confirm?.pr === p.number ? actionsFor(p) : null} onMenu={openish(p) ? () => openActions(p.number) : undefined}>
              {openPr === p.number && prDetail(p)}
            </PRRow>
            )
          })}
          {cramped && rows.length > 1 && (
            <li data-deck-prs-folded className="flex shrink-0 items-center gap-2 overflow-hidden px-1 pt-0.5 text-[11px] text-fg-faint">
              <span className="shrink-0">also</span>
              {rows.filter((p) => p.number !== openPr).map((p) => {
                const v = prVerdict(p, now)
                return (
                  <button key={p.url} type="button" onClick={() => togglePR(p.number)} title={`${p.live?.title || p.title || ''}\n${v.text}`}
                    className="flex shrink-0 items-center gap-1 rounded-[4px] px-1 hover:bg-[var(--app-row-hover)]">
                    <span aria-hidden className="pr-dot" data-state={prDotState(p)} /><span className="num text-fg-muted">#{p.number}</span><span className={WORD_TEXT[v.tone]}>{v.tone === 'ok' ? '✓' : v.tone === 'fail' ? '✗' : v.tone === 'pending' ? '…' : ''}</span>
                  </button>
                )
              })}
            </li>
          )}
          {rows.length === 1 && <li data-deck-no-earlier className="shrink-0 px-1 pt-0.5 text-[11px] text-fg-faint">No earlier PRs from this session.</li>}
        </ul>
      )
    }
  } else if (view === 'branches') {
    const d = brData
    if (d && d.reason) body = quiet('This session’s folder is not a git repository.')
    else if (d && d.branches.length === 0) body = quiet('No branches.')
    else if (d) body = <BranchList d={d} now={now} checks={checks} onJump={jumpToPR} connect={!d.connected && d.repo ? connectButton('Connect GitHub to see each branch’s pull request') : null} cleanup={cleanup} />
  } else if (view === 'release') {
    const d = relData
    if (d && d.reason) body = quiet(noRepoLine(d))
    else if (d && !d.connected) body = connectButton(`Connect GitHub to see ${d.repo ?? 'the repository'}’s release build`)
    else if (d && !rel) body = quiet(d.error ? `Release build not read: ${d.error.message}` : 'Release build not read.', d.error?.message)
    else if (rel && rel.state === 'none') body = quiet('No release build among the repository’s recent runs: none was started by a tag push or a release.')
    else if (rel && rel.run) {
      const run = rel.run
      const est = releaseEstimateText(rel, now)
      const relCost = sumCostLabel(run.cost)
      body = (
        <>
          <div data-deck-ci-release className="flex min-w-0 items-baseline gap-1.5 text-[12px]">
            <CIMark tone={relRunning ? 'running' : rel.state === 'fail' ? 'fail' : rel.state === 'pass' ? 'pass' : 'skipped'} />
            {relRunning
              ? <>
                  <button type="button" onClick={() => run.html_url && openExternal(run.html_url)} title={`Open the ${run.name} run on GitHub`} className="mono shrink-0 font-medium text-fg hover:underline">{rel.tag ?? run.name}</button>
                  <span className="num shrink-0 text-warn">{fmtRun(releaseElapsed(rel, now))}</span>
                  <MiniPipeline nodes={jobNodes([run], now)} label={`${rel.tag ?? run.name}: its jobs`} onPick={pick} />
                  {est && <span data-deck-ci-estimate className="truncate text-[11px] text-fg-faint" title={`${est}\nAn estimate: the median time of this workflow’s last successful release runs, from GitHub’s own run times`}>{est}</span>}
                </>
              : <>
                  <button type="button" onClick={() => openExternal(rel.release?.url ?? run.html_url ?? '')} title={rel.release ? 'Open the release on GitHub' : `Open the ${run.name} run on GitHub`}
                    className={`truncate hover:underline ${rel.state === 'fail' ? 'text-danger' : 'text-fg'}`}>{releaseDoneText(rel, now)}</button>
                  <MiniPipeline nodes={jobNodes([run], now)} label={`${rel.tag ?? run.name}: its jobs`} onPick={pick} />
                  {relCost && <CostText c={relCost} data="run" />}
                  {rel.release && run.html_url && <button type="button" onClick={() => openExternal(run.html_url!)} className="shrink-0 text-[11px] text-fg-faint hover:text-fg-muted hover:underline">run ↗</button>}
                </>}
          </div>
          {runList(false, true)}
          {rel.error && jobs.length > 0 && <p className="truncate text-[10.5px] text-warn" title={rel.error.message}>The last read failed; this is the one before.</p>}
        </>
      )
    }
  } else {
    const d = mainData
    if (d && d.reason) body = quiet(noRepoLine(d))
    else if (d && !d.connected) body = connectButton(`Connect GitHub to see ${d.branch ?? 'the default branch'}’s CI`)
    else if (d && !ci) body = quiet(d.error ? `CI not read: ${d.error.message}` : 'CI not read.', d.error?.message)
    else if (ci && runs.length === 0) body = quiet(`No GitHub Actions runs on ${ci.branch ?? 'the default branch'}.`)
    else if (ci) {
      body = (
        <>
          <UsageText line={usageLine(usage)} />
          {runList(true, true)}
          {ci.error && <p className="truncate text-[10.5px] text-warn" title={ci.error.message}>The last read failed; this is the one before.</p>}
        </>
      )
    }
  }

  // The shown view's answer: three grey rows the first time it is ever
  // asked, else what it was last told, with how fresh that is.
  const viewData: DeckFresh | undefined = view === 'pr' ? prsData : view === 'branches' ? brData : view === 'release' ? relData : mainData
  const viewMeta = view === 'pr' ? prsMeta : view === 'branches' ? brMeta : view === 'release' ? relMeta : mainMeta
  const viewAt = viewData ? viewData.fetched_at || (view === 'pr' ? prsAt : view === 'branches' ? brAt : view === 'release' ? relAt : mainAt) : undefined
  if (body === null && !viewData) body = <DeckSkeleton label={`Reading ${VIEW_LABEL[view]}`} />

  // The branch's pull request, when the current one is from it: "→ main".
  const lead = rows[0]
  const base = lead?.live?.state === 'open' && branch && lead.live.branch === branch ? lead.live.base : undefined
  const chip = view !== 'release' ? releaseChip(rel, now) : ''
  // Esc folds the innermost open thing — a job's steps, else the open PR —
  // only while the focus is in the deck: the terminal keeps its own Esc.
  const onEsc = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    if (confirm) setConfirm(undefined)
    else if (openJob !== undefined && jobs.some((j) => j.id === openJob)) fold(openJob, true)
    else if (view === 'pr' && openPr > 0) togglePR(openPr, true)
    else return
    e.preventDefault()
    e.stopPropagation()
  }
  return (
    <Investigate.Provider value={{ run: (j, st) => void investigate(j, st), why, busy }}>
    <LogView.Provider value={{ view: logView, pr: view === 'pr' ? pr?.number : undefined, onShown }}>
    <div ref={cell} data-deck-cell onKeyDown={onEsc} className="flex min-w-0 flex-1 flex-col gap-1 overflow-hidden px-3 pb-2 pt-2">
      {/* The header never runs past the deck's right edge (owner, 2026-10-14:
        * on a 14-inch MacBook with the sidebar and the cockpit open, the
        * end of it was cut off at the cockpit). The least useful words go
        * first as the deck narrows — "updated …" under 640px, the word
        * "Checks" under 560px, the branch chip under 480px — and what is
        * still too wide wraps to a second line rather than overflowing. */}
      <div data-deck-head className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-faint">Pull requests &amp; CI</h4>
        {branch && <BranchChip branch={branch} base={base} changed={changed} ahead={ahead} onReview={onReview} />}
        {/* A release under way, said from the other views, in the header. */}
        {chip && (
          <button type="button" data-deck-release-chip onClick={() => setView('release')} title={`A release build is running${rel?.estimate ? `; the time left is an estimate from the last ${rel.estimate.runs} runs` : ''}. Show it.`}
            className="num hidden min-w-0 max-w-[220px] shrink items-center gap-1.5 rounded-[4px] border border-warn/40 @min-[480px]:flex px-1.5 text-[10.5px] leading-[16px] text-warn hover:bg-warn/10">
            <span aria-hidden className="ci-spin inline-block h-[7px] w-[7px] shrink-0 rounded-full" /><span className="truncate">{chip}</span>
          </button>
        )}
        <span className="ml-auto flex min-w-0 items-baseline justify-end gap-2 text-[11px] text-fg-faint">
          <span data-deck-fresh-slot className="hidden @min-[640px]:contents"><Freshness compact at={viewAt} loading={viewMeta.loading} failed={viewMeta.failed} reason={viewMeta.reason} confirmed={viewMeta.confirmed} onRetry={viewMeta.retry} /></span>
          {view === 'pr' && prsData && !prsData.connected && rows.length > 0 && (
            <button type="button" disabled={connecting} onClick={() => void connect()} title="Reads CI and reviews through your GitHub CLI login; turn it off in Settings → GitHub" className="text-accent hover:underline disabled:opacity-60">{connecting ? 'connecting…' : 'connect GitHub for CI'}</button>
          )}
          {view === 'main' && ci?.branch && <span className="mono truncate" title={`${ci.repo}, its default branch`}>{ci.branch}</span>}
          {view === 'main' && ci && jobs.length > 0 && (
            <span data-deck-ci-runner className="num" title={runnerTitle}>runner <span className="text-fg">{fmtRun(total)}</span>{ciCost && <> · <CostText c={ciCost} data="ci" /></>}</span>
          )}
        </span>
        {(view === 'pr' || view === 'branches') && <ChecksViewSwitch view={checks} onChange={setChecks} />}
        <CIViewSwitch view={view} onChange={setView} />
        {controls}
      </div>
      {body}
    </div>
    </LogView.Provider>
    </Investigate.Provider>
  )
}

/**
 * One pull request: a dot for its state (open, draft, merged, closed), the
 * number and title, the mini pipeline, the CI in words, the review and a
 * conflict when GitHub said so, and its age. A click opens its CI in place;
 * ↗ opens the PR on GitHub.
 */
function PRRow({ p, now, checks = 'circles', runs, cost, open, onToggle, onPick, agents = [], onOpenAgent, status, quick, actions, onMenu, children }: { p: SessionPRLive; now: number; checks?: ChecksView; runs?: CIRun[]; cost?: CICost; open: boolean; onToggle: () => void; onPick: (n: PipeNode) => void; agents?: PRAgent[]; onOpenAgent?: (s: SessionSummary) => void; status?: PRStatus; quick?: ReactNode; actions?: ReactNode; onMenu?: () => void; children?: ReactNode }) {
  const live = p.live
  const dot = prDotState(p)
  const v = prVerdict(p, now, runs)
  // "changes requested" is the review chip; approved and review required stay words.
  const reviewWords = prReviewText(p)
  const review = live?.review === 'changes_requested' ? undefined : reviewWords
  // One problem chip, the most important; the rest in its tooltip.
  const { chip, more } = topChip(p)
  const chipTitle = chip && `${chip.title}${more.length ? `\nAlso: ${more.join(', ')}` : ''}`
  const age = prAge(p, now)
  // Its runner cost once a job finished, "· $0.42"; nothing at $0 — a
  // public repository's free runners are noise on every row (owner,
  // 2026-10-14). The open row's CI still says what was free and why.
  const money = cost && cost.usd > 0 ? sumCostLabel(cost) : undefined
  const title = live?.title || p.title || ''
  const url = live?.url || p.url
  // The checks in one short group — "✗ 1 failed ✓ 11", "✓ all 12 · 6m" —
  // every check one hover away (components/CheckSummary). With none
  // reported yet, the words say why ("CI not started", "no checks").
  const sum = prChecks(p, now, runs)
  return (
    <li data-deck-pr={p.number} data-open={open || undefined} className={open ? 'flex min-h-[72px] flex-1 flex-col' : 'shrink-0'}>
      {/* Open, its line stays at the top of the list whatever scrolls, with
        * the chevron that folds it. */}
      <div className={open ? 'sticky top-0 z-[2] shrink-0 bg-[var(--app-chrome-bg)]' : undefined}>
      <div onClick={onToggle}
        className={`grid min-w-0 shrink-0 cursor-pointer grid-cols-[10px_8px_minmax(40px,1fr)_auto_minmax(72px,min(var(--deck-ci-w,250px),38cqw))_26px_18px_14px] items-center gap-x-2 rounded-[5px] px-1 py-[1px] text-[12.5px] hover:bg-[var(--app-row-hover)] ${open ? 'bg-[var(--app-row-hover)]' : ''}`}>
        <Chevron open={open} />
        <span role="img" aria-label={dot} title={dot} className="pr-dot" data-state={dot} />
        <button type="button" aria-expanded={open} onClick={(e) => { e.stopPropagation(); onToggle() }}
          title={`${title}\n${open ? `Fold its CI (${keys('Esc')})` : 'Show its CI'}`} className="flex min-w-0 items-baseline gap-2 text-left">
          <span className="num shrink-0 text-fg">#{p.number}</span>
          <span data-deck-pr-title className={`truncate text-[13.5px] ${open ? 'text-fg' : 'text-fg-muted'}`}>{title}</span>
        </button>
        {/* Every cell stays in the grid; what gives way as the deck narrows is
          * hidden inside it, so the columns never shift. */}
        {/* What is doing something about it, who is on it, and what stands
          * between it and a merge — beside the mini pipeline. The chips and
          * the agent stay at every width; the review words give way. */}
        <span className="flex min-w-0 items-center justify-end gap-1.5">
          <StatusMark status={status} agents={agents} onOpen={onOpenAgent} />
          {chip && <span data-deck-pr-chip={chip.word} title={chipTitle} className={`shrink-0 rounded-[4px] border px-1 text-[10px] font-medium leading-[14px] ${CHIP_TEXT[chip.tone]}`}>{chip.word}</span>}
          {quick && <span data-deck-pr-quicks className="flex shrink-0 items-center gap-0.5">{quick}</span>}
          {review && <span data-deck-pr-review className={`hidden max-w-[150px] truncate text-[11px] @min-[1100px]:block ${WORD_TEXT[review.tone]}`}>{review.text}</span>}
        </span>
        <span data-deck-pr-ci className="flex w-full min-w-0 overflow-hidden text-[11.5px]">
          {/* Drawn at its natural width, which the list measures for the column. */}
          <span data-deck-pr-ci-fit className="flex w-max shrink-0 items-center gap-1.5">
            {sum
              ? <CheckSummary s={sum} label={`#${p.number}: its checks`} onPick={onPick} view={checks} />
              : <span title={v.title ?? v.text} className={`truncate ${v.strong ? 'font-medium' : ''} ${WORD_TEXT[v.tone]}`}>{v.text}</span>}
            {money && <><span aria-hidden className="text-fg-faint">·</span><CostText c={money} data="pr" className="shrink-0" /></>}
          </span>
        </span>
        <span data-deck-pr-age className="num text-right text-[11px] text-fg-faint" title={age.title}>{age.text}</span>
        {onMenu
          ? <button type="button" data-deck-pr-menu onClick={(e) => { e.stopPropagation(); onMenu() }} aria-label={`Actions on #${p.number}`} title="Fix with an agent, re-run checks, update the branch"
              className="grid h-[16px] w-[18px] place-items-center rounded-[4px] text-[13px] font-semibold leading-none text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">⋯</button>
          : <span />}
        <button type="button" onClick={(e) => { e.stopPropagation(); openExternal(url) }} aria-label={`Open #${p.number} on GitHub`} title="Open the pull request on GitHub"
          className="text-[11px] text-fg-faint hover:text-fg">↗</button>
      </div>
      {actions}
      </div>
      {/* A size container: an open job's steps are bounded to its height (100cqh). */}
      {open && <div data-deck-pr-detail data-deck-scroll="" className="mb-1 ml-[7px] min-h-0 flex-1 overflow-y-auto overscroll-contain border-l border-[var(--app-hairline)] pl-2 pt-0.5 [container-type:size]">{children}</div>}
    </li>
  )
}

/** A disclosure chevron: right while folded, down while open; up on a Fold button. */
function Chevron({ open, up }: { open?: boolean; up?: boolean }) {
  const turn = up ? '-rotate-90' : open ? 'rotate-90 text-fg-muted' : 'text-fg-faint'
  return (
    <svg aria-hidden data-deck-chevron viewBox="0 0 10 10" className={`h-[10px] w-[10px] shrink-0 transition-transform duration-100 ${turn}`}>
      <path d="M3.5 2 L6.5 5 L3.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

const COST_TEXT: Record<CostTone, string> = { cost: 'text-fg-muted', free: 'text-ok', muted: 'text-fg-faint' }

/** A runner cost: "$0.31", "$0 · public repo", "unpriced" (muted), the basis in its tooltip. */
function CostText({ c, data, className = '' }: { c: CostLabel; data: string; className?: string }) {
  return <span data-deck-cost={data} data-tone={c.tone} title={c.title} className={`num truncate whitespace-nowrap text-[11px] ${COST_TEXT[c.tone]} ${className}`}>{c.text}</span>
}

/** What GitHub billed for Actions this month, or what the token needs to say it. */
function UsageText({ line }: { line?: ReturnType<typeof usageLine> }) {
  if (!line) return null
  return (
    <p data-deck-usage={line.kind} className="flex min-w-0 shrink-0 items-baseline gap-1.5 truncate px-0 text-[11px]" title={line.title}>
      {line.kind === 'available'
        ? <span className="num truncate text-fg-muted">{line.text}</span>
        : <span className="truncate text-fg-faint">{line.text}</span>}
      {line.kind === 'permission' && (
        <button type="button" onClick={() => openExternal(line.url)} className="shrink-0 text-accent hover:underline">token settings ↗</button>
      )}
    </p>
  )
}

/**
 * The repository's branches (owner, 2026-10-12, translated: "seeing branches
 * with statistics would also be interesting"): the current one first, then by
 * last activity; each with ahead and behind the default branch, its last
 * commit's age and author, its pull request (dot, number, mini pipeline),
 * what Caprock's sessions on it cost and how many, and a stale mark. The first
 * BRANCHES_SHOWN, then "Show all". A branch with a PR opens it in the PRs view.
 */
function BranchList({ d, now, checks, onJump, connect, cleanup }: { d: SessionBranches; now: number; checks: ChecksView; onJump: (n: number, url: string) => void; connect: ReactNode; cleanup?: ReactNode }) {
  const [all, setAll] = useState(false)
  const rows = shownBranches(d.branches, all)
  return (
    <>
      {connect}
      {cleanup && <div className="shrink-0 empty:hidden" data-deck-cleanup>{cleanup}</div>}
      <ul data-deck-branches className="-mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
        {rows.map((b) => <BranchRow key={b.name} b={b} now={now} checks={checks} onJump={onJump} />)}
        {d.branches.length > BRANCHES_SHOWN && (
          <li className="shrink-0 px-1 pt-0.5">
            <button type="button" data-deck-branches-all onClick={() => setAll((x) => !x)} className="text-[11px] text-fg-faint hover:text-fg-muted hover:underline">
              {all ? 'Show fewer' : `Show all ${d.branches.length}`}
            </button>
          </li>
        )}
      </ul>
      {d.error && <p className="truncate text-[10.5px] text-warn" title={d.error.message}>Pull requests not read: {d.error.message}</p>}
    </>
  )
}

function BranchRow({ b, now, checks, onJump }: { b: SessionBranch; now: number; checks: ChecksView; onJump: (n: number, url: string) => void }) {
  const ab = aheadBehind(b)
  const commit = lastCommit(b, now)
  const spend = branchSpend(b)
  const sum = prChecks(b, now)
  const pr = b.pr
  const jump = pr ? () => onJump(pr.number, pr.url) : undefined
  // Below 460px the deck keeps the name, the PR and the spend; ahead and
  // behind and the last commit leave the grid (and its template) together.
  return (
    <li data-deck-branch-row={b.name} data-current={b.current || undefined} data-stale={b.stale || undefined} className="shrink-0">
      <div onClick={jump} title={pr ? `${b.name}\nOpen #${pr.number}${pr.title ? ` “${pr.title}”` : ''}` : b.name}
        className={`grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(44px,auto)] @min-[460px]:grid-cols-[minmax(90px,1fr)_auto_auto_minmax(52px,156px)_minmax(28px,110px)] items-center gap-x-2 rounded-[5px] px-1 py-[1px] text-[12px] ${jump ? 'cursor-pointer hover:bg-[var(--app-row-hover)]' : ''}`}>
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className={`mono truncate text-[11.5px] ${b.current ? 'font-medium text-fg' : b.stale ? 'text-fg-faint' : 'text-fg-muted'}`}>{b.name}</span>
          {b.current && <span className="hidden shrink-0 text-[10px] uppercase tracking-[0.04em] text-accent @min-[560px]:inline">current</span>}
          {b.default && <span className="hidden shrink-0 text-[10px] uppercase tracking-[0.04em] text-fg-faint @min-[640px]:inline">default</span>}
          {b.stale && <span data-deck-stale title={STALE_TITLE} className="shrink-0 rounded-[3px] border border-[var(--app-hairline)] px-1 text-[9.5px] uppercase tracking-[0.04em] text-fg-faint">stale</span>}
          {!b.local && <span className="hidden shrink-0 text-[10px] text-fg-faint @min-[640px]:inline" title="Only on origin: no local branch">origin</span>}
        </span>
        <span data-deck-branch-ab className="num hidden whitespace-nowrap text-[11px] text-fg-faint @min-[460px]:block" title={ab.title}>{ab.text}</span>
        <span className="flex items-center justify-end gap-1.5">
          {pr && (
            <span data-deck-branch-pr={pr.number} className="flex shrink-0 items-center gap-1 text-[11.5px]">
              <span aria-hidden className="pr-dot" data-state={branchPRDot(pr)} />
              <span className="num text-fg-muted">#{pr.number}</span>
            </span>
          )}
          {sum && <span className="hidden @min-[560px]:inline-flex"><CheckSummary s={sum} label={`#${pr?.number}: its checks`} onPick={() => jump?.()} view={checks} /></span>}
        </span>
        {/* The session count and the author give way first as the deck narrows. */}
        <span data-deck-branch-spend className={`num truncate text-right text-[11px] ${b.sessions ? 'text-fg-muted' : 'text-fg-faint'}`} title={spend.title}>
          {spend.cost}{spend.count && <span className="hidden @min-[640px]:inline"> · {spend.count}</span>}
        </span>
        <span data-deck-branch-commit className="hidden truncate text-right text-[11px] text-fg-faint @min-[460px]:block" title={commit.title}>
          {commit.age}{commit.author && <span className="hidden @min-[640px]:inline"> · {commit.author}</span>}
        </span>
      </div>
    </li>
  )
}

const DELTA_TEXT: Record<DeltaTone, string> = { warn: 'text-warn', ok: 'text-ok', muted: 'text-fg-faint' }

/** A time against its median: "+18%", "≈ 3m left", "+12% over median"; nothing without a median. */
function VsText({ vs, className = '' }: { vs?: VsMedian; className?: string }) {
  if (!vs) return <span />
  return <span data-deck-vs={vs.kind} title={vs.title} className={`num truncate whitespace-nowrap text-[11px] ${DELTA_TEXT[vs.tone]} ${className}`}>{vs.text}</span>
}

/** A run's wall-clock time and how it stands against its workflow's median. */
function RunTime({ run, now, noCost }: { run: CIRun; now: number; noCost?: boolean }) {
  const ms = runSpan(run, now)
  if (ms === undefined) return null
  const vs = runVsMedian(run, now)
  const money = noCost ? undefined : sumCostLabel(run.cost)
  return (
    <span data-deck-run-time className="num flex shrink-0 items-baseline gap-1 text-[10.5px] text-fg-faint" title={`The run's wall-clock time, from GitHub's own stamps${vs ? `\n${vs.title}` : ''}`}>
      run <span className={run.status === 'completed' ? 'text-fg' : 'text-warn'}>{fmtRun(ms)}</span>
      {vs && <><span aria-hidden>·</span><VsText vs={vs} /></>}
      {money && <><span aria-hidden>·</span><CostText c={money} data="run" /></>}
    </span>
  )
}

/** One job: its mark, name, OS and time against its median; open, its steps. */
function CIJobRow({ sessionId, job, now, open, onToggle, vsCol, costCol, table }: { sessionId: string; job: CIJob; now: number; open: boolean; onToggle: () => void; vsCol?: boolean; costCol?: boolean; table?: CICost }) {
  const tone = ciTone(job)
  const vs = vsCol ? jobVsMedian(job, now) : undefined
  const money = costCol ? jobCostLabel(job.cost, table, job.labels) : undefined
  // Whole class names, so Tailwind sees each one.
  // Fixed tracks after the name, so a column of jobs lines up row to row.
  const cols = vsCol && costCol ? 'grid-cols-[9px_minmax(0,1fr)_34px_52px_62px_42px]'
    : vsCol ? 'grid-cols-[9px_minmax(0,1fr)_34px_52px_62px]'
      : costCol ? 'grid-cols-[9px_minmax(0,1fr)_34px_52px_42px]'
        : 'grid-cols-[9px_minmax(0,1fr)_34px_52px]'
  const at = keyStep(job)
  const [logFor, setLogFor] = useState<number>()
  return (
    <li data-deck-ci-job={job.id} data-tone={tone} data-open={open || undefined} className={open ? 'col-span-full' : 'min-w-0'}>
      {/* Open, the job's line is pinned at the top of the scroll area while
        * its steps scroll under it, with the control that folds them. */}
      <div data-deck-ci-job-head className={open ? 'sticky top-0 z-[1] flex min-w-0 items-center gap-2 bg-[var(--app-chrome-bg)]' : 'contents'}>
      <button type="button" onClick={onToggle} aria-expanded={open} title={`${job.name}${job.labels.length ? `\nRunner: ${job.labels.join(', ')}` : ''}\n${open ? `Fold its steps (${keys('Esc')})` : 'Show its steps'}`}
        className={`grid w-full min-w-0 ${cols} items-center gap-x-1.5 rounded-[4px] px-1 py-[1px] text-left text-[12px] hover:bg-[var(--app-row-hover)] ${open ? 'flex-1 bg-[var(--app-row-hover)]' : ''}`}>
        <CIMark tone={tone} />
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className={`truncate ${tone === 'fail' ? 'font-medium text-danger' : 'text-fg'}`}>{job.name}</span>
          {!open && at && <span className={`min-w-0 shrink-[100] truncate text-[11px] ${tone === 'fail' ? 'text-danger' : 'text-fg-faint'}`}>{at.name}</span>}
        </span>
        <span className="truncate text-[10px] uppercase tracking-[0.04em] text-fg-faint">{osTag(job.os)}</span>
        <span className={`num whitespace-nowrap text-right text-[11.5px] ${tone === 'running' ? 'text-warn' : 'text-fg-muted'}`}>{fmtRun(ciElapsed(job, now))}</span>
        {vsCol && <VsText vs={vs} />}
        {costCol && (money ? <CostText c={money} data="job" className="text-right" /> : <span />)}
      </button>
      {open && (
        <button type="button" data-deck-ci-fold onClick={onToggle} aria-label={`Fold ${job.name}’s steps (${keys('Esc')})`} title="Fold the steps: Esc, or a click on the job"
          className="flex h-[20px] shrink-0 items-center gap-1 rounded-[5px] px-1.5 text-[11px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">
          <Chevron up />Fold <kbd aria-hidden className="app-kbd-key">{keys('Esc')}</kbd>
        </button>
      )}
      </div>
      {open && (
        // Never taller than the scroll area under the pinned line: the steps
        // scroll on their own, so the open job fits the deck whatever its height.
        <ul data-deck-ci-steps className="ml-[8px] grid max-h-[max(60px,calc(100cqh-26px))] grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] content-start gap-x-4 overflow-y-auto overscroll-contain border-l border-[var(--app-hairline)] pl-1">
          {job.steps.map((st) => (
            <CIStepRow key={st.number} sessionId={sessionId} job={job} step={st} now={now}
              showLog={logFor === st.number} onLog={() => setLogFor((x) => (x === st.number ? undefined : st.number))} />
          ))}
          {job.steps.length === 0 && <li className="col-span-full px-1 text-[11px] text-fg-faint">No steps reported yet.</li>}
          {tone === 'fail' && job.status === 'completed' && (
            <li className="col-span-full flex items-center gap-2 px-1 py-0.5 text-[11px] text-fg-faint">
              <InvestigateButton job={job} step={at?.name} />
              <span className="truncate">queue it to this agent</span>
            </li>
          )}
        </ul>
      )}
    </li>
  )
}

/** One step; a failed one opens the lines around its error. */
function CIStepRow({ sessionId, job, step, now, showLog, onLog }: { sessionId: string; job: CIJob; step: CIStep; now: number; showLog: boolean; onLog: () => void }) {
  const tone = ciTone(step)
  const failed = tone === 'fail'
  const row = (
    <>
      <CIMark tone={tone} />
      <span className={`truncate ${failed ? 'font-medium text-danger' : tone === 'skipped' || tone === 'queued' ? 'text-fg-faint' : 'text-fg-muted'}`}>{step.name}</span>
      <span className={`num whitespace-nowrap text-right ${tone === 'running' ? 'text-warn' : 'text-fg-faint'}`}>{fmtRun(ciElapsed(step, now))}</span>
    </>
  )
  const cls = 'grid w-full min-w-0 grid-cols-[9px_minmax(0,1fr)_minmax(48px,auto)] items-center gap-x-1.5 rounded-[4px] px-1 text-left text-[11.5px]'
  return (
    <li data-deck-ci-step={step.number} data-tone={tone} className={showLog ? 'col-span-full' : 'min-w-0'}>
      {failed && job.status === 'completed'
        ? <button type="button" onClick={onLog} aria-expanded={showLog} title={showLog ? 'Hide the error' : 'Show the error: the lines around it in the job’s log'} className={`${cls} ci-failed-step`}>{row}</button>
        : <div className={cls}>{row}</div>}
      {showLog && <CILogTail sessionId={sessionId} job={job} />}
    </li>
  )
}

/** The lines around a failed job's error, read once, on demand. */
function CILogTail({ sessionId, job }: { sessionId: string; job: CIJob }) {
  const { view, pr, onShown } = useContext(LogView)
  const [log, setLog] = useState<CILog>()
  const [err, setErr] = useState('')
  const pre = useRef<HTMLPreElement>(null)
  const box2 = useRef<HTMLDivElement>(null)
  // Said to the cell, which makes room for it; brought into view once read.
  useEffect(() => {
    onShown?.(1)
    return () => onShown?.(-1)
  }, [onShown])
  useEffect(() => {
    let alive = true
    api.sessionCILog(sessionId, job.id, view, pr).then((l) => { if (alive) setLog(l) }).catch((e: unknown) => {
      const body = (e as { body?: { error?: string } }).body
      if (alive) setErr(body?.error || String(e))
    })
    return () => { alive = false }
  }, [sessionId, job.id, view, pr])
  // The error line in view, a few lines of what followed it under it.
  useEffect(() => {
    const box = pre.current
    const el = box?.querySelector<HTMLElement>('[data-error-line]')
    if (box && el) box.scrollTop = Math.max(0, el.offsetTop - box.clientHeight + el.offsetHeight * 4)
    if (log || err) box2.current?.scrollIntoView?.({ block: 'nearest' })
  }, [log, err])
  return (
    <div ref={box2} data-deck-ci-log className="my-1 mr-1 overflow-hidden rounded-[5px] border border-[var(--app-hairline)]">
      {!log && !err && <p className="px-2 py-1 text-[11px] text-fg-faint">Reading the log…</p>}
      {err && <p className="px-2 py-1 text-[11px] text-danger">{err}</p>}
      {log && (
        <pre ref={pre} className="mono ci-log max-h-[132px] overflow-auto px-2 py-1 text-[10.5px] leading-[1.45] text-fg-muted">
          {log.lines.map((l, i) => (
            <div key={i} data-error-line={i === log.error_line ? '' : undefined} className={i === log.error_line ? 'ci-error-line' : l.includes('##[error]') ? 'text-danger' : undefined}>{l || ' '}</div>
          ))}
          {log.lines.length === 0 && <div className="text-fg-faint">The log is empty.</div>}
        </pre>
      )}
      <div className="flex items-center gap-3 border-t border-[var(--app-hairline)] px-2 py-0.5 text-[11px]">
        {log?.truncated && <span className="text-fg-faint">the end of a long log</span>}
        <InvestigateButton job={job} />
        {job.html_url && <button type="button" onClick={() => openExternal(job.html_url!)} className="ml-auto text-accent hover:underline">Open on GitHub ↗</button>}
      </div>
    </div>
  )
}

