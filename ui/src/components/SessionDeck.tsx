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
import { api, errText, type CIJob, type CILog, type CIRun, type CIStep, type SessionPRLive, type SessionRepoCI, type SessionSummary, type SpawnRequest, type Summary } from '@/lib/api'
import { DECK_DEFAULT, DECK_MAX_SHARE, clampDeck, deckKeyStep } from '@/lib/deck'
import { MiniPipeline } from './MiniPipeline'
import { CI_VIEWS, byOSLine, checkNodes, jobVsMedian, runSpan, runVsMedian, type DeltaTone, type VsMedian, ciActive, ciElapsed, ciTone, fmtRun, investigateMessage, jobNodes, keyStep, orderPRs, osTag, prAge, prDotState, prReviewText, prVerdict, readCIView, releaseChip, releaseDoneText, releaseElapsed, releaseEstimateText, runnerTime, saveCIView, type CITone, type CIView, type PipeNode, type PRWordTone } from '@/lib/ci'
import { jobCostLabel, sumCostLabel, sumRuns, usageLine, type CICost, type CostLabel, type CostTone } from '@/lib/runnercost'
import { BRANCHES_SHOWN, STALE_TITLE, aheadBehind, branchPRDot, branchSpend, lastCommit, shownBranches, type SessionBranch, type SessionBranches } from '@/lib/branches'
import { sessionTitle } from '@/lib/sidebar'
import { useCanControl } from '@/lib/useCanControl'
import { githubApi } from '@/lib/github'
import { openExternal } from '@/lib/nudges'
import { keys } from '@/lib/appkeys'
import { PROGRESS_MAX_MS, branchWorktree, fixCIMessage, fixConflictMessage, fixWorktreeName, forceErrText, hasConflict, isBehind, prAgents, prChips, progressStands, rerunText, typeable, type DeckWorktree, type PRAgent, type PRChip, type PRProgress } from '@/lib/prforce'

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
  onClose: () => void
  /** Says something briefly at the foot of the window: Investigate's result. */
  onToast?: (text: string) => void
  /** The checkouts of the session's project and the live agents in each: who is on a PR's branch. */
  worktrees?: DeckWorktree[]
  /** Opens a session's tab: a PR row's agent mark. */
  onOpenSession?: (s: SessionSummary) => void
  /** Starts an agent and opens its tab; throws why it could not. */
  onStartAgent?: (req: SpawnRequest, title: string) => Promise<void>
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


function DeckBody({ s, sessionId, changed, branch, ahead, onReviewChanges, onClose, onToast, worktrees, onOpenSession, onStartAgent }: SessionDeckProps) {
  return (
    // A container, so the row's quieter columns give way as the terminal
    // narrows (the sidebar and the inspector both open). No clock and no
    // event subscription: what it is doing and what it cost are the
    // sidebar's and the inspector's (owner, 2026-10-11: "Spent doesn't
    // help", "Working now is debatable").
    <div className="@container flex min-h-0 flex-1 items-stretch overflow-hidden">
      <PullsCI sessionId={sessionId} s={s} onToast={onToast} branch={branch || s.git_branch} changed={changed} ahead={ahead} onReview={onReviewChanges} worktrees={worktrees} onOpenSession={onOpenSession} onStartAgent={onStartAgent} />
      <div className="flex shrink-0 items-start pr-2 pt-1.5">
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close the session deck (${keys('⌘B')})`}
          title="Hide the deck; the same key brings it back"
          className="flex h-[24px] items-center gap-1.5 rounded-[6px] px-1.5 text-[11.5px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg"
        >
          Hide <kbd aria-hidden className="app-kbd-key">{keys('⌘B')}</kbd>
        </button>
      </div>
    </div>
  )
}

/**
 * One click turns the GitHub integration on through the GitHub CLI's own
 * login (ADR-047: off until the user turns it on; this button is that).
 * Without a usable `gh`, Settings is where a token goes. True when connected.
 */
async function connectGitHub(): Promise<boolean> {
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
const CI_RUNNING_MS = 12_000
const CI_IDLE_MS = 60_000
/** The pull requests: sooner while a check runs. The daemon keeps each pull
 *  request about as long, so a poll it can answer from what it holds costs
 *  GitHub nothing. */
const PRS_PENDING_MS = 20_000

const CI_TEXT: Record<CITone, string> = {
  running: 'text-warn', queued: 'text-fg-faint', pass: 'text-ok', fail: 'text-danger', skipped: 'text-fg-faint',
}

/** A job's or a step's state as a mark: a turning ring while it runs. */
function CIMark({ tone }: { tone: CITone }) {
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

/**
 * Asks read() while `on`, the deck open and the window visible: every
 * `fast` ms while busy() says something runs, else every CI_IDLE_MS.
 * The last answer stays while it is off.
 */
function usePoll<T>(on: boolean, key: string, read: () => Promise<T>, busy: (d: T) => boolean, fast = CI_RUNNING_MS): [T | undefined, number] {
  const [data, setData] = useState<T>()
  const [at, setAt] = useState(0)
  const fn = useRef({ read, busy })
  useEffect(() => { fn.current = { read, busy } })
  useEffect(() => {
    if (!on) return
    let alive = true
    let timer = 0
    const tick = async () => {
      let next = CI_IDLE_MS
      if (!document.hidden) {
        try {
          const d = await fn.current.read()
          if (!alive) return
          setData(d)
          setAt(Date.now())
          if (fn.current.busy(d)) next = fast
        } catch { /* the last answer stays */ }
      }
      if (alive) timer = window.setTimeout(() => void tick(), next)
    }
    void tick()
    const onVisible = () => { if (!document.hidden) { window.clearTimeout(timer); void tick() } }
    document.addEventListener('visibilitychange', onVisible)
    return () => { alive = false; window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [on, key, fast])
  return [data, at]
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

/**
 * The pull requests folded by hand, per session, while the app runs: the
 * current one opens by itself while it has checks, and a fold must not be
 * undone by the next poll or by hiding and showing the deck again.
 */
const foldedPRs = new Set<string>()
/** Forgets every fold: for tests. */
export function forgetFoldedPRs() { foldedPRs.clear() }

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

/** The force actions on a pull request row. */
type ForceKind = 'conflict' | 'ci' | 'rerun' | 'update'
const FORCE_LABEL: Record<ForceKind, string> = {
  conflict: 'Fix conflict with agent', ci: 'Fix CI with agent', rerun: 'Re-run checks', update: 'Update branch',
}
const FORCE_TITLE: Record<ForceKind, string> = {
  conflict: 'An agent merges the base in, resolves the conflicts, runs the checks and pushes: the agent on this branch when Caprock started it, else a new one in the branch’s checkout',
  ci: 'An agent looks at this pull request’s CI — the failed job with its log, or the flaky checks — fixes it and pushes',
  rerun: 'Run the checks again on GitHub: the failed jobs, else every finished run. Needs the token’s Actions (write) permission',
  update: 'Merge the base into this branch on GitHub, as its Update branch button does. Needs the token’s Pull requests (write) permission',
}
/** Where a fix goes: typed into an agent Caprock started, or a new agent. */
type FixPlan = { mode: 'queue'; to: SessionSummary } | { mode: 'spawn'; wt?: DeckWorktree; foreign: boolean }

/** What each PR row is doing after a force action, per session, while the app runs: hiding the deck keeps it. */
const prProgress = new Map<string, PRProgress>()
function progressOf(sessionId: string): Record<number, PRProgress> {
  const out: Record<number, PRProgress> = {}
  for (const [k, g] of prProgress) {
    const i = k.lastIndexOf(':')
    if (k.slice(0, i) === sessionId) out[Number(k.slice(i + 1))] = g
  }
  return out
}
/** Forgets every progress line: for tests. */
export function forgetPRProgress() { prProgress.clear() }

const CHIP_TEXT: Record<PRChip['tone'], string> = {
  fail: 'border-danger/45 text-danger', warn: 'border-warn/45 text-warn', muted: 'border-[var(--app-hairline)] text-fg-faint',
}
const AGENT_TINT: Record<PRAgent['word'], string> = {
  fixing: 'bg-ok/20 text-ok', waiting: 'bg-accent/20 text-accent', idle: 'bg-[var(--app-row-hover)] text-fg-muted',
}
const AGENT_WORD: Record<PRAgent['word'], string> = { fixing: 'text-ok', waiting: 'text-accent', idle: 'text-fg-faint' }

/** Who is on the PR's branch: the agent's initial and its word, or "2 agents"; a click opens it. */
function AgentMark({ agents, onOpen }: { agents: PRAgent[]; onOpen?: (s: SessionSummary) => void }) {
  if (agents.length === 0) return null
  const a = agents[0]!
  const many = agents.length > 1
  return (
    <button type="button" data-deck-pr-agent={a.word} disabled={!onOpen} onClick={(e) => { e.stopPropagation(); onOpen?.(a.session) }}
      title={`${agents.map((x) => x.title).join('\n')}${onOpen ? '\nOpen its tab' : ''}`}
      className="flex shrink-0 items-center gap-1 rounded-[4px] px-0.5 text-[10.5px] leading-[14px] hover:bg-[var(--app-row-hover)]">
      <span aria-hidden className={`grid h-[14px] w-[14px] place-items-center rounded-[4px] text-[9px] font-semibold ${AGENT_TINT[a.word]}`}>{a.initial}</span>
      <span className={many ? 'text-fg-muted' : AGENT_WORD[a.word]}>{many ? `${agents.length} agents` : a.word}</span>
    </button>
  )
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
function PullsCI({ sessionId, s, onToast, branch, changed, ahead, onReview, worktrees, onOpenSession, onStartAgent }: { sessionId: string; s: SessionSummary; onToast?: (text: string) => void; branch?: string; changed?: number; ahead?: number; onReview?: () => void; worktrees?: DeckWorktree[]; onOpenSession?: (s: SessionSummary) => void; onStartAgent?: (req: SpawnRequest, title: string) => Promise<void> }) {
  const canControl = useCanControl()
  const [busy, setBusy] = useState<number>()
  const [view, setViewState] = useState<CIView>(() => readCIView())
  const setView = (v: CIView) => { setViewState(v); saveCIView(v) }
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
  // The row opened by a click: a PR's number, 0 when every row was closed,
  // undefined while no click chose (the default rule decides).
  const [chosen, setChosen] = useState<number>()
  // How many error logs are open: while one is, the earlier PRs fold into
  // one line so the error has the room.
  const [logs, setLogs] = useState(0)
  const onShown = useCallback((d: 1 | -1) => setLogs((x) => Math.max(0, x + d)), [])
  const [confirm, setConfirm] = useState<{ pr: number; kind: ForceKind }>()
  const [forcing, setForcing] = useState<number>()
  const [progress, setProgressState] = useState<Record<number, PRProgress>>(() => progressOf(sessionId))
  const setProgress = (n: number, g: PRProgress | undefined) => {
    const k = `${sessionId}:${n}`
    if (g) prProgress.set(k, g)
    else prProgress.delete(k)
    setProgressState(progressOf(sessionId))
  }
  // A progress line goes once GitHub shows it done, or after a while.
  const standing = (p: SessionPRLive, agents: PRAgent[]): PRProgress | undefined => {
    const g = progress[p.number]
    return g && progressStands(g, p, agents, now) ? g : undefined
  }
  // While one stands, the PRs are asked sooner and the clock ticks, so it
  // goes as soon as it is done.
  const forceActive = Object.values(progress).some((g) => now - g.at < PROGRESS_MAX_MS)

  const key = `${sessionId}:${n}`
  // Sooner while a force action's progress stands, so it goes once done.
  const forceSoon = useRef(false)
  const [prsData, prsAt] = usePoll(view === 'pr', key, () => api.sessionPRs(sessionId), (d) => forceSoon.current || d.prs.some((p) => p.live?.checks.state === 'pending'), PRS_PENDING_MS)
  const rows = useMemo(() => orderPRs(prsData?.prs ?? []), [prsData])
  const lead = rows[0]
  // The current PR opens by itself while it is open and has checks, whatever
  // their state: its jobs fill the room the rows leave (owner, 2026-10-12, of
  // the 0.109 deck: "see how much space is wasted").
  // Unless it was folded by hand in this session: that holds.
  const leadOpen = lead?.live?.state === 'open' && !!lead.live && lead.live.checks.items.length > 0 && !foldedPRs.has(`${sessionId}:${lead.number}`)
  const openPr = chosen ?? (leadOpen ? lead!.number : 0)
  const [prData, prAt] = usePoll(view === 'pr' && openPr > 0, `${key}:${openPr}`, () => api.sessionCI(sessionId, openPr), (d) => ciActive(d.ci))
  // The answer for the open row only: one for the row open before waits.
  const prCI = prData && prData.pr?.number === openPr ? prData : undefined
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
  const [relData, relAt] = usePoll(true, key, () => api.sessionCIRelease(sessionId), (d) => d.release?.state === 'running')
  const [mainData, mainAt] = usePoll(view === 'main', key, () => api.sessionCIMain(sessionId), (d) => ciActive(d.ci))
  // The branches, while that view is shown: local git and one cached list of
  // the repository's pull requests, so a poll costs GitHub nothing new.
  const [brData, brAt] = usePoll(view === 'branches', key, () => api.sessionBranches(sessionId), (d) => d.branches.some((b) => b.live?.checks.state === 'pending'), PRS_PENDING_MS)
  // What GitHub billed for Actions this month, only while Main is shown; the
  // daemon keeps the answer 30 minutes, so the minute's poll costs nothing.
  const owner = mainData?.repo?.split('/')[0] ?? ''
  const [usage] = usePoll(view === 'main' && !!mainData?.connected && !!owner, `${key}:${owner}`, () => api.actionsUsage(owner), () => false)
  useEffect(() => { setNow(Date.now()) }, [prsAt, prAt, relAt, mainAt, brAt])

  const rel = relData?.release
  const ci = view === 'pr' ? prCI?.ci : view === 'main' ? mainData?.ci : undefined
  const runs: CIRun[] = useMemo(() => (view === 'release' ? (rel?.run ? [rel.run] : []) : ci?.runs ?? []), [view, rel?.run, ci?.runs])
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
    const k = `${sessionId}:${n}`
    if (openPr === n) {
      foldedPRs.add(k)
      setChosen(0)
      scrollTo.current = { sel: `[data-deck-pr="${n}"]`, mode: 'nearest', focus }
    } else {
      foldedPRs.delete(k)
      setChosen(n)
      scrollTo.current = { sel: `[data-deck-pr="${n}"]`, mode: 'nearest' }
    }
  }
  // A circle of a PR row: that row opens, at that job.
  const pickInRow = (pr: number, node: PipeNode) => {
    if (!node.jobId) { if (node.url) openExternal(node.url); return }
    foldedPRs.delete(`${sessionId}:${pr}`)
    setChosen(pr)
    pick(node)
  }

  // A branch's PR: in the PRs view when it is one of this session's, else on GitHub.
  const jumpToPR = (n: number, url: string) => {
    if (prsData && !prsData.prs.some((p) => p.number === n)) { openExternal(url); return }
    foldedPRs.delete(`${sessionId}:${n}`)
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
  const why = !canControl ? 'This device may only watch: queue it from the Mac, or make this device a controller in Settings.'
    : !s.owned ? 'Caprock did not start this session, so it never types into it. Start the agent from Caprock to queue CI failures to it.'
      : s.status === 'ended' || s.detached ? 'This session is no longer running here, so nothing can be queued to it.' : ''
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
  const root = s.repo_root || s.cwd
  const agentsOf = (p: SessionPRLive) => prAgents(p.live?.branch, worktrees)
  // Who a fix goes to: a Caprock-started agent on the branch; for CI, else
  // the session in front as Investigate does; else a new agent in the
  // branch's checkout, or in a new worktree at the PR's head when there is
  // none or someone Caprock did not start works in it (rule 7).
  const fixPlan = (p: SessionPRLive, kind: 'conflict' | 'ci'): FixPlan => {
    const on = agentsOf(p)
    const mine = on.find((a) => typeable(a.session))
    if (mine) return { mode: 'queue', to: mine.session }
    if (kind === 'ci' && !why) return { mode: 'queue', to: s }
    const wt = branchWorktree(p.live?.branch, worktrees)
    const foreign = on.some((a) => !typeable(a.session))
    return { mode: 'spawn', wt: wt && !foreign ? wt : undefined, foreign }
  }
  const forceWhy = (p: SessionPRLive, kind: ForceKind): string => {
    if (!canControl) return 'This device may only watch: do it from the Mac, or make this device a controller in Settings.'
    const live = p.live
    if (!live || live.state !== 'open') return 'Only an open pull request.'
    if (kind === 'rerun' || kind === 'update') {
      if (prsData && !prsData.connected) return 'Connect GitHub first.'
      if (kind === 'rerun' && live.checks.items.length === 0) return 'No checks to re-run.'
      if (kind === 'rerun' && live.checks.state === 'pending') return 'The checks are still running; GitHub re-runs a run once it has finished.'
      return ''
    }
    const plan = fixPlan(p, kind)
    if (plan.mode === 'spawn' && !onStartAgent) return 'An agent cannot be started from here.'
    if (plan.mode === 'spawn' && !root) return 'This session has no folder to start an agent in.'
    return ''
  }
  const confirmText = (p: SessionPRLive, kind: ForceKind): string => {
    const live = p.live!
    if (kind === 'rerun') return live.checks.failed > 0 ? `Re-run #${p.number}’s failed jobs on GitHub?` : `Re-run every check of #${p.number} on GitHub?`
    if (kind === 'update') return `Merge ${live.base} into ${live.branch} on GitHub (Update branch)?`
    const plan = fixPlan(p, kind)
    const what = kind === 'conflict' ? `merge origin/${live.base}, resolve the conflicts, run the checks and push` : 'fix #' + p.number + '’s CI and push'
    if (plan.mode === 'queue') return `Ask ${sessionTitle(plan.to)} to ${what}?`
    const where = plan.wt ? `in ${plan.wt.path.split(/[\\/]/).pop()}` : `in a new worktree at #${p.number}’s head`
    return `Start an agent ${where} to ${what}?${plan.foreign ? ' The agent on the branch was not started by Caprock, so nothing is typed into it.' : ''}`
  }
  // Fix CI's message: Investigate's for the first failed job, with its log;
  // else the flaky-check one.
  const ciMessage = async (p: SessionPRLive, fresh: boolean): Promise<string> => {
    const live = p.live!
    const failed = prCI?.pr?.number === p.number ? jobs.find((j) => ciTone(j) === 'fail') : undefined
    if (!failed) return fixCIMessage(live, fresh)
    let lines: string[] = []
    try { lines = (await api.sessionCILog(sessionId, failed.id, 'pr', p.number)).lines } catch { /* the job's link has it */ }
    const run = runs.find((r) => r.id === failed.run_id)
    const text = investigateMessage({ pr: { number: p.number, title: live.title, url: live.url }, workflow: run?.name, job: failed, step: keyStep(failed)?.name, lines })
    return fresh && live.branch ? `${text}\nPush to the pull request's branch: git push origin HEAD:${live.branch}` : text
  }
  const force = async (p: SessionPRLive, kind: ForceKind) => {
    setConfirm(undefined)
    const live = p.live
    if (!live || forceWhy(p, kind)) return
    setForcing(p.number)
    const label = FORCE_LABEL[kind]
    try {
      if (kind === 'rerun') {
        const r = await api.sessionPRRerun(sessionId, p.number)
        setProgress(p.number, { kind: 'rerun', text: rerunText(r.jobs), at: Date.now(), head: live.head_sha })
      } else if (kind === 'update') {
        await api.sessionPRUpdateBranch(sessionId, p.number)
        setProgress(p.number, { kind: 'update', text: 'updating branch…', at: Date.now(), head: live.head_sha })
      } else {
        const plan = fixPlan(p, kind)
        const fresh = plan.mode === 'spawn' && !plan.wt
        const text = kind === 'conflict' ? fixConflictMessage(live, fresh) : await ciMessage(p, fresh)
        if (plan.mode === 'queue') {
          const res = await api.queueSend(plan.to.session_id, text)
          onToast?.(`${res.sent ? 'Sent to' : 'Queued for'} ${sessionTitle(plan.to)}`)
        } else {
          const req: SpawnRequest = plan.wt ? { cwd: plan.wt.path, prompt: text } : { cwd: root, worktree: fixWorktreeName(p.number), worktree_pr: p.number, prompt: text }
          await onStartAgent!(req, `#${p.number} ${kind === 'conflict' ? 'conflict' : 'CI'}`)
          onToast?.(`Started an agent on #${p.number}`)
        }
        setProgress(p.number, { kind: 'agent', text: 'agent fixing…', at: Date.now(), head: live.head_sha })
      }
      setN((x) => x + 1)
    } catch (e) {
      onToast?.(`${label}: ${forceErrText(e)}`)
    } finally {
      setForcing(undefined)
    }
  }
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
        <ul data-deck-prs data-deck-scroll="" className="-mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
          {rows.map((p) => {
            if (cramped && openPr !== p.number) return null
            const agents = agentsOf(p)
            return (
            <PRRow key={p.url} p={p} now={now} runs={seenRuns[p.number]} cost={prCost(p.number)} open={openPr === p.number}
              onToggle={() => togglePR(p.number)}
              onPick={(node) => pickInRow(p.number, node)}
              agents={agents} onOpenAgent={onOpenSession} progress={standing(p, agents)}
              actions={openPr === p.number ? actionsFor(p) : null} onMenu={p.live?.state === 'open' ? () => openActions(p.number) : undefined}>
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
    else if (d) body = <BranchList d={d} now={now} onJump={jumpToPR} connect={!d.connected && d.repo ? connectButton('Connect GitHub to see each branch’s pull request') : null} />
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

  // The branch's pull request, when the current one is from it: "→ main".
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
      <div className="flex min-w-0 items-center gap-2">
        <h4 className="shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-faint">Pull requests &amp; CI</h4>
        {branch && <BranchChip branch={branch} base={base} changed={changed} ahead={ahead} onReview={onReview} />}
        {/* A release under way, said from the other views, in the header. */}
        {chip && (
          <button type="button" data-deck-release-chip onClick={() => setView('release')} title={`A release build is running${rel?.estimate ? `; the time left is an estimate from the last ${rel.estimate.runs} runs` : ''}. Show it.`}
            className="num hidden min-w-0 max-w-[220px] shrink items-center gap-1.5 rounded-[4px] border border-warn/40 @min-[480px]:flex px-1.5 text-[10.5px] leading-[16px] text-warn hover:bg-warn/10">
            <span aria-hidden className="ci-spin inline-block h-[7px] w-[7px] shrink-0 rounded-full" /><span className="truncate">{chip}</span>
          </button>
        )}
        <span className="ml-auto flex min-w-0 shrink-0 items-baseline justify-end gap-2 text-[11px] text-fg-faint">
          {view === 'pr' && prsData && !prsData.connected && rows.length > 0 && (
            <button type="button" disabled={connecting} onClick={() => void connect()} title="Reads CI and reviews through your GitHub CLI login; turn it off in Settings → GitHub" className="text-accent hover:underline disabled:opacity-60">{connecting ? 'connecting…' : 'connect GitHub for CI'}</button>
          )}
          {view === 'main' && ci?.branch && <span className="mono truncate" title={`${ci.repo}, its default branch`}>{ci.branch}</span>}
          {view === 'main' && ci && jobs.length > 0 && (
            <span data-deck-ci-runner className="num" title={runnerTitle}>runner <span className="text-fg">{fmtRun(total)}</span>{ciCost && <> · <CostText c={ciCost} data="ci" /></>}</span>
          )}
        </span>
        <CIViewSwitch view={view} onChange={setView} />
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
function PRRow({ p, now, runs, cost, open, onToggle, onPick, agents = [], onOpenAgent, progress, actions, onMenu, children }: { p: SessionPRLive; now: number; runs?: CIRun[]; cost?: CICost; open: boolean; onToggle: () => void; onPick: (n: PipeNode) => void; agents?: PRAgent[]; onOpenAgent?: (s: SessionSummary) => void; progress?: PRProgress; actions?: ReactNode; onMenu?: () => void; children?: ReactNode }) {
  const live = p.live
  const dot = prDotState(p)
  const v = prVerdict(p, now, runs)
  // "changes requested" is the review chip; approved and review required stay words.
  const reviewWords = prReviewText(p)
  const review = live?.review === 'changes_requested' ? undefined : reviewWords
  const chips = prChips(p)
  const age = prAge(p, now)
  // Its runner cost once a job finished: "· $0.42", "· $0 · public repo".
  const money = sumCostLabel(cost)
  const title = live?.title || p.title || ''
  const url = live?.url || p.url
  const nodes = live && live.checks.items.length > 0 ? checkNodes(live.checks.items, now) : []
  return (
    <li data-deck-pr={p.number} data-open={open || undefined} className={open ? 'flex min-h-[72px] flex-1 flex-col' : 'shrink-0'}>
      {/* Open, its line stays at the top of the list whatever scrolls, with
        * the chevron that folds it. */}
      <div className={open ? 'sticky top-0 z-[2] shrink-0 bg-[var(--app-chrome-bg)]' : undefined}>
      <div onClick={onToggle}
        className={`grid min-w-0 shrink-0 cursor-pointer grid-cols-[10px_8px_minmax(40px,1fr)_auto_auto_minmax(64px,236px)_26px_14px_14px] items-center gap-x-2 rounded-[5px] px-1 py-[1px] text-[12.5px] hover:bg-[var(--app-row-hover)] ${open ? 'bg-[var(--app-row-hover)]' : ''}`}>
        <Chevron open={open} />
        <span role="img" aria-label={dot} title={dot} className="pr-dot" data-state={dot} />
        <button type="button" aria-expanded={open} onClick={(e) => { e.stopPropagation(); onToggle() }}
          title={`${title}\n${open ? `Fold its CI (${keys('Esc')})` : 'Show its CI'}`} className="flex min-w-0 items-baseline gap-2 text-left">
          <span className="num shrink-0 text-fg">#{p.number}</span>
          <span className={`truncate ${open ? 'text-fg' : 'text-fg-muted'}`}>{title}</span>
        </button>
        {/* Every cell stays in the grid; what gives way as the deck narrows is
          * hidden inside it, so the columns never shift. */}
        {/* What is doing something about it, who is on it, and what stands
          * between it and a merge — beside the mini pipeline. The chips and
          * the agent stay at every width; the review words give way. */}
        <span className="flex min-w-0 items-center justify-end gap-1">
          {/* An agent at work says "fixing" in its own mark: no second line for it. */}
          {progress && !(progress.kind === 'agent' && agents.some((a) => a.word === 'fixing')) && (
            <span data-deck-pr-progress={progress.kind} title={progress.text} className="flex shrink-0 items-center gap-1 text-[10.5px] text-accent">
              <span aria-hidden className="ci-spin inline-block h-[7px] w-[7px] shrink-0 rounded-full" />{progress.text}
            </span>
          )}
          <AgentMark agents={agents} onOpen={onOpenAgent} />
          {chips.map((c) => (
            <span key={c.word} data-deck-pr-chip={c.word} title={c.title} className={`shrink-0 rounded-[4px] border px-1 text-[10px] font-medium leading-[14px] ${CHIP_TEXT[c.tone]}`}>{c.word}</span>
          ))}
          {review && <span data-deck-pr-review className={`hidden max-w-[150px] truncate text-[11px] @min-[640px]:block ${WORD_TEXT[review.tone]}`}>{review.text}</span>}
        </span>
        {nodes.length > 0 ? <span className="flex justify-end"><span className="hidden @min-[520px]:inline-flex"><MiniPipeline nodes={nodes} label={`#${p.number}: its checks`} onPick={onPick} /></span></span> : <span />}
        <span data-deck-pr-ci className="flex w-full min-w-0 items-baseline gap-1 overflow-hidden text-[11.5px]">
          <span title={v.title ?? v.text} className={`truncate ${v.strong ? 'font-medium' : ''} ${WORD_TEXT[v.tone]}`}>{v.text}</span>
          {money && <><span aria-hidden className="text-fg-faint">·</span><CostText c={money} data="pr" className="shrink-0" /></>}
        </span>
        <span data-deck-pr-age className="num text-right text-[11px] text-fg-faint" title={age.title}>{age.text}</span>
        {onMenu
          ? <button type="button" data-deck-pr-menu onClick={(e) => { e.stopPropagation(); onMenu() }} aria-label={`Actions on #${p.number}`} title="Fix with an agent, re-run checks, update the branch"
              className="text-[12px] leading-none text-fg-faint hover:text-fg">⋯</button>
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
function BranchList({ d, now, onJump, connect }: { d: SessionBranches; now: number; onJump: (n: number, url: string) => void; connect: ReactNode }) {
  const [all, setAll] = useState(false)
  const rows = shownBranches(d.branches, all)
  return (
    <>
      {connect}
      <ul data-deck-branches className="-mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
        {rows.map((b) => <BranchRow key={b.name} b={b} now={now} onJump={onJump} />)}
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

function BranchRow({ b, now, onJump }: { b: SessionBranch; now: number; onJump: (n: number, url: string) => void }) {
  const ab = aheadBehind(b)
  const commit = lastCommit(b, now)
  const spend = branchSpend(b)
  const nodes = b.live && b.live.checks.items.length > 0 ? checkNodes(b.live.checks.items, now) : []
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
          {nodes.length > 0 && <span className="hidden @min-[560px]:inline-flex"><MiniPipeline nodes={nodes} label={`#${pr?.number}: its checks`} onPick={() => jump?.()} /></span>}
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

