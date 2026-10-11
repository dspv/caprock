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
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { api, errText, type CIJob, type CILog, type CIRun, type CIStep, type SessionPRLive, type SessionRepoCI, type SessionSummary, type Summary } from '@/lib/api'
import { DECK_DEFAULT, DECK_MAX_SHARE, clampDeck, deckKeyStep } from '@/lib/deck'
import { MiniPipeline } from './MiniPipeline'
import { CI_VIEWS, byOSLine, checkNodes, jobVsMedian, runSpan, runVsMedian, type DeltaTone, type VsMedian, ciActive, ciElapsed, ciTone, fmtRun, investigateMessage, jobNodes, keyStep, orderPRs, osTag, prAge, prDotState, prMergeText, prReviewText, prVerdict, readCIView, releaseChip, releaseDoneText, releaseElapsed, releaseEstimateText, runnerTime, saveCIView, type CITone, type CIView, type PipeNode, type PRWordTone } from '@/lib/ci'
import { sessionTitle } from '@/lib/sidebar'
import { useCanControl } from '@/lib/useCanControl'
import { githubApi } from '@/lib/github'
import { openExternal } from '@/lib/nudges'
import { keys } from '@/lib/appkeys'

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


function DeckBody({ s, sessionId, changed, branch, ahead, onReviewChanges, onClose, onToast }: SessionDeckProps) {
  return (
    // A container, so the row's quieter columns give way as the terminal
    // narrows (the sidebar and the inspector both open). No clock and no
    // event subscription: what it is doing and what it cost are the
    // sidebar's and the inspector's (owner, 2026-10-11: "Spent doesn't
    // help", "Working now is debatable").
    <div className="@container flex min-h-0 flex-1 items-stretch overflow-hidden">
      <PullsCI sessionId={sessionId} s={s} onToast={onToast} branch={branch || s.git_branch} changed={changed} ahead={ahead} onReview={onReviewChanges} />
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
const LogView = createContext<{ view: CIView; pr?: number; onShown?: (d: 1 | -1) => void }>({ view: 'pr' })

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

const VIEW_LABEL: Record<CIView, string> = { pr: 'PRs', release: 'Release', main: 'Main' }
const VIEW_TITLE: Record<CIView, string> = {
  pr: 'This session’s pull requests and their CI',
  release: 'The repository’s newest release build: a tag push or a published release',
  main: 'The newest run of each workflow on the default branch',
}

/** PRs | Release | Main, kept per viewer. */
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
 * the current PR is open by default while its CI runs or failed. The Release
 * and Main views stand behind the same switch. Asked only while the deck is
 * open and the window visible.
 */
function PullsCI({ sessionId, s, onToast, branch, changed, ahead, onReview }: { sessionId: string; s: SessionSummary; onToast?: (text: string) => void; branch?: string; changed?: number; ahead?: number; onReview?: () => void }) {
  const canControl = useCanControl()
  const [busy, setBusy] = useState<number>()
  const [view, setViewState] = useState<CIView>(() => readCIView())
  const setView = (v: CIView) => { setViewState(v); saveCIView(v) }
  const [n, setN] = useState(0)
  const [connecting, setConnecting] = useState(false)
  const [open, setOpen] = useState<Record<number, boolean>>({})
  const autoOpened = useRef<Record<string, boolean>>({})
  const [now, setNow] = useState(() => Date.now())
  const [reveal, setReveal] = useState<number>()
  // The row opened by a click: a PR's number, 0 when every row was closed,
  // undefined while no click chose (the default rule decides).
  const [chosen, setChosen] = useState<number>()
  // How many error logs are open: while one is, the earlier PRs fold into
  // one line so the error has the room.
  const [logs, setLogs] = useState(0)
  const onShown = useCallback((d: 1 | -1) => setLogs((x) => Math.max(0, x + d)), [])

  const key = `${sessionId}:${n}`
  const [prsData, prsAt] = usePoll(view === 'pr', key, () => api.sessionPRs(sessionId), (d) => d.prs.some((p) => p.live?.checks.state === 'pending'), PRS_PENDING_MS)
  const rows = useMemo(() => orderPRs(prsData?.prs ?? []), [prsData])
  const lead = rows[0]
  const leadOpen = lead?.live?.state === 'open' && !!lead.live && (lead.live.checks.state === 'fail' || lead.live.checks.state === 'pending')
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
  useEffect(() => { setNow(Date.now()) }, [prsAt, prAt, relAt, mainAt])

  const rel = relData?.release
  const ci = view === 'pr' ? prCI?.ci : view === 'main' ? mainData?.ci : undefined
  const runs: CIRun[] = useMemo(() => (view === 'release' ? (rel?.run ? [rel.run] : []) : ci?.runs ?? []), [view, rel?.run, ci?.runs])
  const relRunning = rel?.state === 'running'
  const prsRunning = view === 'pr' && rows.some((p) => p.live?.checks.state === 'pending')
  const active = ciActive(ci) || relRunning || prsRunning
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
      setOpen((o) => ({ ...o, [failed.id]: true }))
    }
  }, [runs, autoKey])

  const jobs = runs.flatMap((r) => r.jobs)
  // A job picked from a mini pipeline comes into view once it is drawn.
  useEffect(() => {
    if (reveal === undefined) return
    const el = document.querySelector<HTMLElement>(`[data-deck-ci-job="${reveal}"]`)
    if (!el) return
    el.scrollIntoView?.({ block: 'nearest' })
    setReveal(undefined)
  }, [reveal, runs])
  const pick = (node: PipeNode) => {
    if (!node.jobId) { if (node.url) openExternal(node.url); return }
    setOpen((o) => ({ ...o, [node.jobId!]: true }))
    setReveal(node.jobId)
  }
  // A circle of a PR row: that row opens, at that job.
  const pickInRow = (pr: number, node: PipeNode) => {
    if (!node.jobId) { if (node.url) openExternal(node.url); return }
    setChosen(pr)
    pick(node)
  }

  const connect = async () => {
    setConnecting(true)
    if (await connectGitHub()) setN((x) => x + 1)
    setConnecting(false)
  }

  const pr = prCI?.pr
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
    try { lines = (await api.sessionCILog(sessionId, job.id, view, view === 'pr' ? pr?.number : undefined)).lines } catch { /* the message goes without the log; the job's link has it */ }
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
  const total = ci ? runnerTime(ci, now) : 0
  const runnerTitle = ci ? `Runner time, measured from GitHub’s job times${ciActive(ci) ? ' and the running jobs on the clock' : ''}${ci.by_os.length ? `\nFinished: ${byOSLine(ci)}` : ''}\nNot priced: what a minute costs depends on the plan and the OS.` : ''
  const connectButton = (label: string) => (
    <button type="button" disabled={connecting} onClick={() => void connect()} title="Reads GitHub Actions through your GitHub CLI login; turn it off in Settings → GitHub"
      className="w-fit text-left text-[12px] text-accent hover:underline disabled:opacity-60">{connecting ? 'connecting…' : label}</button>
  )
  const quiet = (text: string, title?: string) => <p className="truncate text-[12px] text-fg-faint" title={title ?? text}>{text}</p>
  const vsCol = runs.some((r) => r.jobs.some((j) => j.baseline))
  const runList = (manyRuns: boolean, byOS: boolean) => (
    <ul data-deck-ci-jobs className={view === 'pr' ? '-mx-1' : '-mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain'}>
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
          <ul>
            {run.jobs.map((job) => (
              <CIJobRow key={job.id} sessionId={sessionId} job={job} now={now} vsCol={vsCol}
                open={!!open[job.id]} onToggle={() => setOpen((o) => ({ ...o, [job.id]: !o[job.id] }))} />
            ))}
            {run.jobs.length === 0 && <li className="px-1 text-[11px] text-fg-faint">{run.status === 'completed' ? 'No jobs reported.' : 'Waiting for a runner…'}</li>}
          </ul>
        </li>
      ))}
      {byOS && ci && ci.by_os.length > 1 && <li className="num truncate px-1 pt-0.5 text-[10.5px] text-fg-faint" title="The finished jobs’ runner time per OS, measured; not priced">{byOSLine(ci)}</li>}
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
          {runs.length === 1 && <><RunTime run={runs[0]!} now={now} /><span aria-hidden>·</span></>}
          <span data-deck-ci-runner className="num shrink-0" title={runnerTitle}>runner <span className="text-fg">{fmtRun(total)}</span></span>
          {ci.by_os.length > 1 && <span className="num truncate" title="The finished jobs’ runner time per OS, measured; not priced">{byOSLine(ci)}</span>}
          <button type="button" onClick={() => openExternal(`${url}/checks`)} className="ml-auto shrink-0 hover:text-fg-muted hover:underline">checks ↗</button>
        </div>
        {runList(runs.length > 1, false)}
        {ci.error && <p className="truncate text-[10.5px] text-warn" title={ci.error.message}>The last read failed; this is the one before.</p>}
      </>
    )
  }

  let body: ReactNode = null
  if (view === 'pr') {
    const d = prsData
    if (d && rows.length === 0) body = quiet('No PR from this session yet.')
    else if (d) {
      body = (
        // A column: every row keeps its line and the open one's CI takes
        // the height left, scrolling inside, so the earlier PRs stay in view.
        <ul data-deck-prs className="-mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
          {rows.map((p) => (logs > 0 && openPr !== p.number ? null :
            <PRRow key={p.url} p={p} now={now} runs={seenRuns[p.number]} open={openPr === p.number}
              onToggle={() => setChosen(openPr === p.number ? 0 : p.number)}
              onPick={(node) => pickInRow(p.number, node)}>
              {openPr === p.number && prDetail(p)}
            </PRRow>
          ))}
          {logs > 0 && rows.length > 1 && (
            <li data-deck-prs-folded className="flex shrink-0 items-center gap-2 overflow-hidden px-1 pt-0.5 text-[11px] text-fg-faint">
              <span className="shrink-0">also</span>
              {rows.filter((p) => p.number !== openPr).map((p) => {
                const v = prVerdict(p, now)
                return (
                  <button key={p.url} type="button" onClick={() => setChosen(p.number)} title={`${p.live?.title || p.title || ''}\n${v.text}`}
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
  } else if (view === 'release') {
    const d = relData
    if (d && d.reason) body = quiet(noRepoLine(d))
    else if (d && !d.connected) body = connectButton(`Connect GitHub to see ${d.repo ?? 'the repository'}’s release build`)
    else if (d && !rel) body = quiet(d.error ? `Release build not read: ${d.error.message}` : 'Release build not read.', d.error?.message)
    else if (rel && rel.state === 'none') body = quiet('No release build among the repository’s recent runs: none was started by a tag push or a release.')
    else if (rel && rel.run) {
      const run = rel.run
      const est = releaseEstimateText(rel, now)
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
          {runList(true, true)}
          {ci.error && <p className="truncate text-[10.5px] text-warn" title={ci.error.message}>The last read failed; this is the one before.</p>}
        </>
      )
    }
  }

  // The branch's pull request, when the current one is from it: "→ main".
  const base = lead?.live?.state === 'open' && branch && lead.live.branch === branch ? lead.live.base : undefined
  const chip = view !== 'release' ? releaseChip(rel, now) : ''
  return (
    <Investigate.Provider value={{ run: (j, st) => void investigate(j, st), why, busy }}>
    <LogView.Provider value={{ view, pr: view === 'pr' ? pr?.number : undefined, onShown }}>
    <div data-deck-cell className="flex min-w-0 flex-1 flex-col gap-1 overflow-hidden px-3 pb-2 pt-2">
      <div className="flex min-w-0 items-center gap-2">
        <h4 className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-faint">Pull requests &amp; CI</h4>
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
            <span data-deck-ci-runner className="num" title={runnerTitle}>runner <span className="text-fg">{fmtRun(total)}</span></span>
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
function PRRow({ p, now, runs, open, onToggle, onPick, children }: { p: SessionPRLive; now: number; runs?: CIRun[]; open: boolean; onToggle: () => void; onPick: (n: PipeNode) => void; children?: ReactNode }) {
  const live = p.live
  const dot = prDotState(p)
  const v = prVerdict(p, now, runs)
  const review = prReviewText(p)
  const merge = prMergeText(p)
  const age = prAge(p, now)
  const title = live?.title || p.title || ''
  const url = live?.url || p.url
  const nodes = live && live.checks.items.length > 0 ? checkNodes(live.checks.items, now) : []
  return (
    <li data-deck-pr={p.number} data-open={open || undefined} className={open ? 'flex min-h-[72px] shrink flex-col' : 'shrink-0'}>
      <div onClick={onToggle}
        className={`grid min-w-0 shrink-0 cursor-pointer grid-cols-[8px_minmax(40px,1fr)_auto_auto_minmax(64px,168px)_26px_14px] items-center gap-x-2 rounded-[5px] px-1 py-[1px] text-[12.5px] hover:bg-[var(--app-row-hover)] ${open ? 'bg-[var(--app-row-hover)]' : ''}`}>
        <span role="img" aria-label={dot} title={dot} className="pr-dot" data-state={dot} />
        <button type="button" aria-expanded={open} onClick={(e) => { e.stopPropagation(); onToggle() }}
          title={`${title}\n${open ? 'Hide' : 'Show'} its CI`} className="flex min-w-0 items-baseline gap-2 text-left">
          <span className="num shrink-0 text-fg">#{p.number}</span>
          <span className={`truncate ${open ? 'text-fg' : 'text-fg-muted'}`}>{title}</span>
        </button>
        {/* Every cell stays in the grid; what gives way as the deck narrows is
          * hidden inside it, so the columns never shift. */}
        <span className="min-w-0">
          <span data-deck-pr-review className="hidden max-w-[150px] truncate text-[11px] @min-[640px]:block">
            {review && <span className={WORD_TEXT[review.tone]}>{review.text}</span>}
            {review && merge && <span className="text-fg-faint"> · </span>}
            {merge && <span className={WORD_TEXT[merge.tone]} title={merge.title}>{merge.text}</span>}
          </span>
        </span>
        {nodes.length > 0 ? <span className="flex justify-end"><span className="hidden @min-[520px]:inline-flex"><MiniPipeline nodes={nodes} label={`#${p.number}: its checks`} onPick={onPick} /></span></span> : <span />}
        <span data-deck-pr-ci title={v.title ?? v.text} className={`w-full min-w-0 truncate text-[11.5px] ${v.strong ? 'font-medium' : ''} ${WORD_TEXT[v.tone]}`}>{v.text}</span>
        <span data-deck-pr-age className="num text-right text-[11px] text-fg-faint" title={age.title}>{age.text}</span>
        <button type="button" onClick={(e) => { e.stopPropagation(); openExternal(url) }} aria-label={`Open #${p.number} on GitHub`} title="Open the pull request on GitHub"
          className="text-[11px] text-fg-faint hover:text-fg">↗</button>
      </div>
      {open && <div data-deck-pr-detail className="mb-1 ml-[7px] min-h-0 flex-1 overflow-y-auto overscroll-contain border-l border-[var(--app-hairline)] pl-2 pt-0.5">{children}</div>}
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
function RunTime({ run, now }: { run: CIRun; now: number }) {
  const ms = runSpan(run, now)
  if (ms === undefined) return null
  const vs = runVsMedian(run, now)
  return (
    <span data-deck-run-time className="num flex shrink-0 items-baseline gap-1 text-[10.5px] text-fg-faint" title={`The run's wall-clock time, from GitHub's own stamps${vs ? `\n${vs.title}` : ''}`}>
      run <span className={run.status === 'completed' ? 'text-fg' : 'text-warn'}>{fmtRun(ms)}</span>
      {vs && <><span aria-hidden>·</span><VsText vs={vs} /></>}
    </span>
  )
}

/** One job: its mark, name, OS and time against its median; open, its steps. */
function CIJobRow({ sessionId, job, now, open, onToggle, vsCol }: { sessionId: string; job: CIJob; now: number; open: boolean; onToggle: () => void; vsCol?: boolean }) {
  const tone = ciTone(job)
  const vs = vsCol ? jobVsMedian(job, now) : undefined
  const at = keyStep(job)
  const [logFor, setLogFor] = useState<number>()
  return (
    <li data-deck-ci-job={job.id} data-tone={tone}>
      <button type="button" onClick={onToggle} aria-expanded={open} title={`${job.name}${job.labels.length ? `\nRunner: ${job.labels.join(', ')}` : ''}\n${open ? 'Hide' : 'Show'} its steps`}
        className={`grid w-full min-w-0 ${vsCol ? 'grid-cols-[9px_minmax(0,1fr)_auto_minmax(48px,auto)_minmax(0,108px)]' : 'grid-cols-[9px_minmax(0,1fr)_auto_minmax(48px,auto)]'} items-center gap-x-1.5 rounded-[4px] px-1 py-[1px] text-left text-[12px] hover:bg-[var(--app-row-hover)]`}>
        <CIMark tone={tone} />
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className={`truncate ${tone === 'fail' ? 'font-medium text-danger' : 'text-fg'}`}>{job.name}</span>
          {!open && at && <span className={`truncate text-[11px] ${tone === 'fail' ? 'text-danger' : 'text-fg-faint'}`}>{at.name}</span>}
        </span>
        <span className="text-[10px] uppercase tracking-[0.04em] text-fg-faint">{osTag(job.os)}</span>
        <span className={`num whitespace-nowrap text-right text-[11.5px] ${tone === 'running' ? 'text-warn' : 'text-fg-muted'}`}>{fmtRun(ciElapsed(job, now))}</span>
        {vsCol && <VsText vs={vs} />}
      </button>
      {open && (
        <ul className="ml-[8px] border-l border-[var(--app-hairline)] pl-1">
          {job.steps.map((st) => (
            <CIStepRow key={st.number} sessionId={sessionId} job={job} step={st} now={now}
              showLog={logFor === st.number} onLog={() => setLogFor((x) => (x === st.number ? undefined : st.number))} />
          ))}
          {job.steps.length === 0 && <li className="px-1 text-[11px] text-fg-faint">No steps reported yet.</li>}
          {tone === 'fail' && job.status === 'completed' && (
            <li className="flex items-center gap-2 px-1 py-0.5 text-[11px] text-fg-faint">
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
    <li data-deck-ci-step={step.number} data-tone={tone}>
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

