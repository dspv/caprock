/**
 * The session deck (.ai/21-app.md § What the user sees, Session deck): a band
 * under the terminal of the agent in front. Opening it pushes the terminal's
 * bottom up, so Claude Code's prompt sits nearer the middle of the screen
 * than its edge (owner, 2026-10-11, translated: "I basically type in the
 * centre, a bit below the middle of the screen — that's comfortable — and in
 * this new area show data useful to me while I work"), and the room it makes
 * carries the session's live figures in one dense row: the GitHub Actions of
 * its pull request job by job and step by step, the branch with what is not
 * committed or pushed, and the session's latest pull requests with their CI.
 * No chart: the dashboard has those (owner, 2026-10-11: "we already have
 * charts everywhere").
 *
 * The branch is what the workspace already holds; the CI and the pull
 * requests are read from GitHub by the daemon, which keeps each answer, while
 * the deck is open. Nothing is estimated, and a figure that is not reported
 * is left out rather than drawn as zero.
 *
 * Cheap on purpose. It is a sibling of the terminals, so nothing here redraws
 * one. Closed, it is not mounted: no clock, no subscription. While its
 * divider is dragged the band grows over the terminal and the terminal's own
 * box changes once, on release — one fit and one PTY resize, not one per
 * frame. Arrow keys on the divider settle the same way.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { api, errText, type CIJob, type CILog, type CIRun, type CIStep, type SessionPRLive, type SessionRepoCI, type SessionSummary, type Summary } from '@/lib/api'
import { DECK_DEFAULT, DECK_MAX_SHARE, clampDeck, deckKeyStep } from '@/lib/deck'
import { MiniPipeline } from './MiniPipeline'
import { CI_VIEWS, byOSLine, checkNodes, ciActive, ciElapsed, ciTone, fmtRun, investigateMessage, jobNodes, keyStep, osTag, readCIView, releaseChip, releaseDoneText, releaseElapsed, releaseEstimateText, runnerTime, saveCIView, type CITone, type CIView, type PipeNode } from '@/lib/ci'
import { sessionTitle } from '@/lib/sidebar'
import { useCanControl } from '@/lib/useCanControl'
import { githubApi, prTone, type PRTone } from '@/lib/github'
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

/** A job to show in the CI cell: a click on a circle of a mini pipeline. */
export interface CIFocus { view: CIView; pr?: number; job: number; n: number }

function DeckBody({ s, sessionId, changed, branch, ahead, onReviewChanges, onClose, onToast }: SessionDeckProps) {
  const [focus, setFocus] = useState<CIFocus>()
  return (
    // A container, so the branch gives way first as the terminal narrows
    // (the sidebar and the inspector both open). No clock and no event
    // subscription: what it is doing and what it cost are the sidebar's and
    // the inspector's (owner, 2026-10-11: "Spent doesn't help", "Working
    // now is debatable").
    <div className="@container flex min-h-0 flex-1 items-stretch overflow-hidden">
      <CI sessionId={sessionId} s={s} onToast={onToast} focus={focus} />
      <Branch branch={branch || s.git_branch} changed={changed} ahead={ahead} onReview={onReviewChanges} />
      <PRs sessionId={sessionId} onPick={(pr, job) => setFocus((f) => ({ view: 'pr', pr, job, n: (f?.n ?? 0) + 1 }))} />
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

/** The display classes of a cell that is drawn only from a container width up; literal, so Tailwind finds them. */
const SHOWN_FROM: Record<number, string> = {
  720: 'hidden @min-[720px]:flex',
  1000: 'hidden @min-[1000px]:flex',
}

function Cell({ label, after, right, className = '', grow = false, below, children }: { label: string; after?: ReactNode; right?: ReactNode; className?: string; grow?: boolean; below?: 720 | 1000; children: ReactNode }) {
  return (
    <div className={`${below ? SHOWN_FROM[below] : 'flex'} min-w-0 flex-col gap-1 border-r border-[var(--app-hairline)] px-3 pb-2 pt-2 last-of-type:border-r-0 ${grow ? '' : 'overflow-hidden'} ${className}`}>
      <div className="flex items-baseline gap-2">
        <h4 className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-faint">{label}</h4>
        {after}
        {right && <div className="ml-auto min-w-0 truncate text-[11px] text-fg-faint">{right}</div>}
      </div>
      {children}
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

/** How often the CI cell asks again: soon while a job runs, else rarely.
 *  The daemon keeps a commit's runs 10 s while one runs and 2 min once all
 *  settled, so a poll inside that costs GitHub nothing. */
const CI_RUNNING_MS = 12_000
const CI_IDLE_MS = 60_000

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
 * The CI of the session's pull request, live (owner, 2026-10-11, translated:
 * "I want to see which steps run, how long each step takes — a full status
 * informer of the real CI/CD … what failed and with which error, and the
 * time of each stage, because runners are money"). A row per GitHub Actions
 * job with its state, OS and time, ticking while it runs; a job opens into
 * its steps, and a failed step into the lines around its error. The runner
 * time at the top is measured: the finished jobs' GitHub timestamps plus the
 * running ones on the clock, split per OS, never priced. It replaced the
 * Context cell, which repeated the status bar (owner: "sacrifice it for
 * CI/CD"). Asked while the deck is open and the window visible: every 12 s
 * while a job runs, else every minute.
 */
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
const LogView = createContext<{ view: CIView; pr?: number }>({ view: 'pr' })

/**
 * Asks read() while `on`, the deck open and the window visible: every
 * CI_RUNNING_MS while busy() says something runs, else every CI_IDLE_MS.
 * The last answer stays while it is off.
 */
function usePoll<T>(on: boolean, key: string, read: () => Promise<T>, busy: (d: T) => boolean): [T | undefined, number] {
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
          if (fn.current.busy(d)) next = CI_RUNNING_MS
        } catch { /* the last answer stays */ }
      }
      if (alive) timer = window.setTimeout(() => void tick(), next)
    }
    void tick()
    const onVisible = () => { if (!document.hidden) { window.clearTimeout(timer); void tick() } }
    document.addEventListener('visibilitychange', onVisible)
    return () => { alive = false; window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [on, key])
  return [data, at]
}

const VIEW_LABEL: Record<CIView, string> = { pr: 'PR', release: 'Release', main: 'Main' }
const VIEW_TITLE: Record<CIView, string> = {
  pr: 'The CI of this session’s pull request',
  release: 'The repository’s newest release build: a tag push or a published release',
  main: 'The newest run of each workflow on the default branch',
}

/** PR | Release | Main, kept per viewer. */
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

function CI({ sessionId, s, onToast, focus }: { sessionId: string; s: SessionSummary; onToast?: (text: string) => void; focus?: CIFocus }) {
  const canControl = useCanControl()
  const [busy, setBusy] = useState<number>()
  const [view, setViewState] = useState<CIView>(() => readCIView())
  const setView = (v: CIView) => { setViewState(v); saveCIView(v) }
  const [n, setN] = useState(0)
  const [connecting, setConnecting] = useState(false)
  const [open, setOpen] = useState<Record<number, boolean>>({})
  const autoOpened = useRef<Record<string, boolean>>({})
  const [now, setNow] = useState(() => Date.now())

  // The PR whose CI is shown when one was picked from the PRs cell; else the daemon's pick.
  const [prPick, setPrPick] = useState<number>()
  const [reveal, setReveal] = useState<number>()
  useEffect(() => {
    if (!focus) return
    setViewState(focus.view)
    saveCIView(focus.view)
    if (focus.pr) setPrPick(focus.pr)
    setOpen((o) => ({ ...o, [focus.job]: true }))
    setReveal(focus.job)
  }, [focus])
  const pick = (node: PipeNode) => {
    if (!node.jobId) { if (node.url) openExternal(node.url); return }
    setOpen((o) => ({ ...o, [node.jobId!]: true }))
    setReveal(node.jobId)
  }

  const key = `${sessionId}:${n}`
  const [prData, prAt] = usePoll(view === 'pr', `${key}:${prPick ?? ''}`, () => api.sessionCI(sessionId, prPick), (d) => ciActive(d.ci))
  // The release build is asked while the deck is open whatever the view, so
  // its chip shows a build under way from the PR view too.
  const [relData, relAt] = usePoll(true, key, () => api.sessionCIRelease(sessionId), (d) => d.release?.state === 'running')
  const [mainData, mainAt] = usePoll(view === 'main', key, () => api.sessionCIMain(sessionId), (d) => ciActive(d.ci))
  useEffect(() => { setNow(Date.now()) }, [prAt, relAt, mainAt])

  const rel = relData?.release
  const ci = view === 'pr' ? prData?.ci : view === 'main' ? mainData?.ci : undefined
  const runs: CIRun[] = useMemo(() => (view === 'release' ? (rel?.run ? [rel.run] : []) : ci?.runs ?? []), [view, rel?.run, ci?.runs])
  const relRunning = rel?.state === 'running'
  const active = ciActive(ci) || relRunning
  // A clock only while something runs: a settled CI draws once.
  useEffect(() => {
    if (!active) return
    const t = window.setInterval(() => { if (!document.hidden) setNow(Date.now()) }, 1000)
    return () => window.clearInterval(t)
  }, [active])

  // The first failed job of each view opens by itself, once: what failed is the question.
  useEffect(() => {
    if (autoOpened.current[view]) return
    const failed = runs.flatMap((r) => r.jobs).find((j) => ciTone(j) === 'fail')
    if (failed) {
      autoOpened.current[view] = true
      setOpen((o) => ({ ...o, [failed.id]: true }))
    }
  }, [runs, view])

  const connect = async () => {
    setConnecting(true)
    if (await connectGitHub()) setN((x) => x + 1)
    setConnecting(false)
  }

  const pr = prData?.pr
  const jobs = runs.flatMap((r) => r.jobs)
  // A job picked from a mini pipeline comes into view once it is drawn.
  useEffect(() => {
    if (reveal === undefined) return
    const el = document.querySelector<HTMLElement>(`[data-deck-ci-job="${reveal}"]`)
    if (!el) return
    el.scrollIntoView?.({ block: 'nearest' })
    setReveal(undefined)
  }, [reveal, runs])
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
  const connectButton = (label: string) => (
    <button type="button" disabled={connecting} onClick={() => void connect()} title="Reads GitHub Actions through your GitHub CLI login; turn it off in Settings → GitHub"
      className="w-fit text-left text-[12px] text-accent hover:underline disabled:opacity-60">{connecting ? 'connecting…' : label}</button>
  )
  const quiet = (text: string, title?: string) => <p className="truncate text-[12px] text-fg-faint" title={title ?? text}>{text}</p>
  const runList = (manyRuns: boolean) => (
    <ul data-deck-ci-jobs className="-mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {runs.map((run) => (
        <li key={run.id} data-deck-ci-run={run.id}>
          {manyRuns && (
            <div data-deck-ci-run-head className="flex min-w-0 items-center gap-2 px-1 pt-0.5">
              <button type="button" onClick={() => run.html_url && openExternal(run.html_url)} title={`Open the ${run.name} run on GitHub`}
                className="flex min-w-0 items-center gap-1.5 truncate text-left text-[10px] font-semibold uppercase tracking-[0.06em] text-fg-faint hover:text-fg-muted">
                {view === 'main' && <CIMark tone={ciTone(run)} />}<span className="truncate">{run.name}</span>
              </button>
              <MiniPipeline nodes={jobNodes([run], now)} label={`${run.name}: its jobs`} onPick={pick} />
            </div>
          )}
          <ul>
            {run.jobs.map((job) => (
              <CIJobRow key={job.id} sessionId={sessionId} job={job} now={now}
                open={!!open[job.id]} onToggle={() => setOpen((o) => ({ ...o, [job.id]: !o[job.id] }))} />
            ))}
            {run.jobs.length === 0 && <li className="px-1 text-[11px] text-fg-faint">{run.status === 'completed' ? 'No jobs reported.' : 'Waiting for a runner…'}</li>}
          </ul>
        </li>
      ))}
      {ci && ci.by_os.length > 1 && <li className="num truncate px-1 pt-0.5 text-[10.5px] text-fg-faint" title="The finished jobs’ runner time per OS, measured; not priced">{byOSLine(ci)}</li>}
    </ul>
  )

  let body: ReactNode = null
  if (view === 'pr') {
    const data = prData
    if (data && !data.connected) body = pr ? connectButton(`Connect GitHub to see #${pr.number}’s CI`) : quiet('No PR from this session yet.')
    else if (data && !pr) body = quiet('No PR from this session yet.')
    else if (data && pr && !ci) body = quiet(data.error ? `CI not read: ${data.error.message}` : `#${pr.number}: no commit to read CI for.`, data.error?.message)
    else if (data && pr && jobs.length === 0) body = quiet(`No GitHub Actions runs on #${pr.number}’s head commit.`)
    else if (ci) body = runList(runs.length > 1)
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
          {runList(false)}
        </>
      )
    }
  } else {
    const d = mainData
    if (d && d.reason) body = quiet(noRepoLine(d))
    else if (d && !d.connected) body = connectButton(`Connect GitHub to see ${d.branch ?? 'the default branch'}’s CI`)
    else if (d && !ci) body = quiet(d.error ? `CI not read: ${d.error.message}` : 'CI not read.', d.error?.message)
    else if (ci && runs.length === 0) body = quiet(`No GitHub Actions runs on ${ci.branch ?? 'the default branch'}.`)
    else if (ci) body = runList(true)
  }

  const chip = view !== 'release' ? releaseChip(rel, now) : ''
  const lastErr = view === 'release' ? rel?.error : ci?.error
  return (
    <Investigate.Provider value={{ run: (j, st) => void investigate(j, st), why, busy }}>
    <LogView.Provider value={{ view, pr: view === 'pr' ? pr?.number : undefined }}>
    <Cell label="CI" className="min-w-[270px] flex-[2.6_1_0]"
      after={<CIViewSwitch view={view} onChange={setView} />}
      right={((view === 'pr' && pr) || (view === 'main' && ci) || jobs.length > 0) && (
        <span className="flex items-baseline justify-end gap-2">
          {view === 'pr' && pr && <button type="button" onClick={() => openExternal(`${pr.url}/checks`)} title={`${pr.title ?? ''}\nOpen the PR’s checks on GitHub`} className="num hover:text-fg hover:underline">#{pr.number}</button>}
          {view === 'main' && ci?.branch && <span className="mono truncate" title={`${ci.repo}, its default branch`}>{ci.branch}</span>}
          {ci && view !== 'release' && jobs.length > 0 && (
            <span data-deck-ci-runner className="num" title={`Runner time, measured from GitHub’s job times${ciActive(ci) ? ' and the running jobs on the clock' : ''}${ci.by_os.length ? `\nFinished: ${byOSLine(ci)}` : ''}\nNot priced: what a minute costs depends on the plan and the OS.`}>
              runner <span className="text-fg">{fmtRun(total)}</span>
            </span>
          )}
        </span>
      )}>
      {/* A release under way, said from the other views: a slim line under
        * the header, where the header's own figures leave it room. */}
      {chip && (
        <button type="button" data-deck-release-chip onClick={() => setView('release')} title={`A release build is running${rel?.estimate ? `; the time left is an estimate from the last ${rel.estimate.runs} runs` : ''}. Show it.`}
          className="num -mt-0.5 flex w-fit max-w-full shrink-0 items-center gap-1.5 truncate rounded-[4px] border border-warn/40 px-1.5 text-[10.5px] leading-[16px] text-warn hover:bg-warn/10">
          <span aria-hidden className="ci-spin inline-block h-[7px] w-[7px] shrink-0 rounded-full" /><span className="truncate">{chip}</span>
        </button>
      )}
      {body}
      {lastErr && jobs.length > 0 && <p className="truncate text-[10.5px] text-warn" title={lastErr.message}>The last read failed; this is the one before.</p>}
    </Cell>
    </LogView.Provider>
    </Investigate.Provider>
  )
}

/** One job: its mark, name, OS and time; open, its steps. */
function CIJobRow({ sessionId, job, now, open, onToggle }: { sessionId: string; job: CIJob; now: number; open: boolean; onToggle: () => void }) {
  const tone = ciTone(job)
  const at = keyStep(job)
  const [logFor, setLogFor] = useState<number>()
  return (
    <li data-deck-ci-job={job.id} data-tone={tone}>
      <button type="button" onClick={onToggle} aria-expanded={open} title={`${job.name}${job.labels.length ? `\nRunner: ${job.labels.join(', ')}` : ''}\n${open ? 'Hide' : 'Show'} its steps`}
        className="grid w-full min-w-0 grid-cols-[9px_minmax(0,1fr)_auto_minmax(48px,auto)] items-center gap-x-1.5 rounded-[4px] px-1 py-[1px] text-left text-[12px] hover:bg-[var(--app-row-hover)]">
        <CIMark tone={tone} />
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className={`truncate ${tone === 'fail' ? 'font-medium text-danger' : 'text-fg'}`}>{job.name}</span>
          {!open && at && <span className={`truncate text-[11px] ${tone === 'fail' ? 'text-danger' : 'text-fg-faint'}`}>{at.name}</span>}
        </span>
        <span className="text-[10px] uppercase tracking-[0.04em] text-fg-faint">{osTag(job.os)}</span>
        <span className={`num whitespace-nowrap text-right text-[11.5px] ${tone === 'running' ? 'text-warn' : 'text-fg-muted'}`}>{fmtRun(ciElapsed(job, now))}</span>
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
  const { view, pr } = useContext(LogView)
  const [log, setLog] = useState<CILog>()
  const [err, setErr] = useState('')
  const pre = useRef<HTMLPreElement>(null)
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
  }, [log])
  return (
    <div data-deck-ci-log className="my-1 mr-1 overflow-hidden rounded-[5px] border border-[var(--app-hairline)]">
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

/** How often the PR cell asks again: sooner while a check is running. The
 *  daemon keeps each pull request for about as long, so a poll it can answer
 *  from what it holds costs GitHub nothing. */
const PRS_PENDING_MS = 20_000
const PRS_IDLE_MS = 60_000

const PR_DOT: Record<PRTone, string> = {
  ok: 'bg-ok', fail: 'bg-danger', pending: 'bg-warn', merged: 'bg-[#a371f7]', closed: 'bg-fg-faint', none: 'bg-fg-faint/70',
}

/** The branch the session works on, what is not committed and what is not pushed. */
function Branch({ branch, changed, ahead, onReview }: { branch?: string; changed?: number; ahead?: number; onReview?: () => void }) {
  if (!branch) return null
  const bits = [
    typeof changed === 'number' ? (changed ? `${changed} not committed` : 'clean') : '',
    ahead ? `${ahead} not pushed` : '',
  ].filter(Boolean)
  return (
    <Cell label="Branch" className="w-[176px] shrink-0" below={720}>
      <p className="mono truncate text-[13px] font-medium text-fg" title={branch}>{branch}</p>
      {bits.length > 0 && <p className={`truncate text-[11.5px] ${changed || ahead ? 'text-warn' : 'text-fg-muted'}`}>{bits.join(' · ')}</p>}
      {onReview && !!changed && (
        <button type="button" onClick={onReview} className="flex w-fit items-center gap-1.5 text-left text-[11.5px] text-accent underline-offset-2 hover:underline">Review changes <kbd aria-hidden className="app-kbd-key">{keys('⇧⌘G')}</kbd></button>
      )}
    </Cell>
  )
}

/** One PR's state in a few characters: CI first, then the review. */
interface PRStatus {
  /** The CI in a few characters, "CI" included where it reads so; '' when there is none to show. */
  ci: string
  /** What the CI label means, when it needs saying. */
  ciTitle?: string
  ciTone: PRTone
  /** Where the CI is looked at: the failing or running job, else the PR's checks. */
  ciUrl?: string
  /** merged, closed, draft, approved…; '' for a plain open PR. */
  state: string
  tone: PRTone
}

/** How long after a PR was opened an empty check list still means "not started yet" rather than "no CI here". */
const CI_START_GRACE_MS = 10 * 60_000

/** One PR's CI and state, in two columns that line up row to row. */
function prStatus(p: SessionPRLive, now = Date.now()): PRStatus {
  const pr = p.live
  if (!pr) {
    if (p.merged_at) return { ci: '', ciTone: 'none', state: 'merged', tone: 'merged' }
    if (p.closed_at) return { ci: '', ciTone: 'none', state: 'closed', tone: 'closed' }
    return { ci: '', ciTone: 'none', state: 'open', tone: 'none' }
  }
  const c = pr.checks
  const total = c.items.length
  let ci = ''
  let ciTone: PRTone = 'none'
  let ciUrl: string | undefined = total ? `${pr.url}/checks` : undefined
  if (c.state === 'fail') {
    const failed = c.items.filter((i) => i.state === 'fail')
    ci = `CI ✗ ${failed[0]?.name ?? 'failed'}${failed.length > 1 ? ` +${failed.length - 1}` : ''}`
    ciTone = 'fail'
    ciUrl = failed.find((i) => i.url)?.url ?? ciUrl
  } else if (c.state === 'pending') {
    ci = `CI ${total - c.pending}/${total} running`
    ciTone = 'pending'
    ciUrl = c.items.find((i) => i.state === 'pending' && i.url)?.url ?? ciUrl
  } else if (c.state === 'pass') {
    ci = `CI ✓ ${total} passed`
    ciTone = 'ok'
  }
  // No checks at all. Right after a PR opens (or a push) GitHub has often not
  // registered them yet; a while later it means no workflow ran on it.
  let ciTitle: string | undefined
  if (!ci && pr.state === 'open' && total === 0) {
    const since = p.opened_at || p.last_at
    if (since && now - since < CI_START_GRACE_MS) {
      ci = 'CI not started'
      ciTitle = 'GitHub has not reported any checks for this PR yet — they usually appear within a minute of a push'
    } else {
      ci = 'no checks'
      ciTitle = 'No CI workflow ran on this PR'
    }
  }
  const review = pr.state === 'open' ? (pr.review === 'approved' ? 'approved' : pr.review === 'changes_requested' ? 'changes' : '') : ''
  const state = pr.state !== 'open' ? pr.state : pr.draft ? 'draft' : review
  const tone: PRTone = pr.state !== 'open' ? prTone(pr) : pr.review === 'changes_requested' ? 'fail' : pr.review === 'approved' ? 'ok' : 'none'
  return { ci, ciTitle, ciTone, ciUrl, state, tone }
}

const STATUS_TEXT: Record<PRTone, string> = {
  ok: 'text-ok', fail: 'text-danger', pending: 'text-warn', merged: 'text-[#a371f7]', closed: 'text-fg-faint', none: 'text-fg-muted',
}

/**
 * The session's latest pull requests and their CI (owner, 2026-10-11: "I'd
 * look at the statuses of the latest PRs, CI on them if possible"). Asked of
 * the daemon while the deck is open and the window is visible: every 20 s
 * while a check runs, else every minute.
 */
function PRs({ sessionId, onPick }: { sessionId: string; onPick?: (pr: number, job: number) => void }) {
  const [data, setData] = useState<{ connected: boolean; prs: SessionPRLive[] }>()
  const [connecting, setConnecting] = useState(false)
  const [n, setN] = useState(0)
  useEffect(() => {
    let alive = true
    let timer = 0
    const tick = async () => {
      let next = PRS_IDLE_MS
      if (!document.hidden) {
        try {
          const d = await api.sessionPRs(sessionId)
          if (!alive) return
          setData(d)
          if (d.prs.some((p) => p.live?.checks.state === 'pending')) next = PRS_PENDING_MS
        } catch { /* the last answer stays */ }
      }
      if (alive) timer = window.setTimeout(() => void tick(), next)
    }
    void tick()
    const onVisible = () => { if (!document.hidden) { window.clearTimeout(timer); void tick() } }
    document.addEventListener('visibilitychange', onVisible)
    return () => { alive = false; window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [sessionId, n])

  const connect = async () => {
    setConnecting(true)
    if (await connectGitHub()) setN((x) => x + 1)
    setConnecting(false)
  }
  const prs = data?.prs ?? []
  return (
    <Cell label="Pull requests" className="min-w-[220px] flex-[2.2_1_0]"
      right={data && !data.connected && prs.length > 0
        ? <button type="button" disabled={connecting} onClick={() => void connect()} title="Reads CI and reviews through your GitHub CLI login; turn it off in Settings → GitHub" className="text-accent hover:underline disabled:opacity-60">{connecting ? 'connecting…' : 'connect GitHub for CI'}</button>
        : undefined}>
      {data && prs.length === 0 && <p className="text-[12px] text-fg-faint">No PR from this session yet.</p>}
      <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1">
        {prs.map((p) => {
          const st = prStatus(p)
          const piped = !!p.live && p.live.checks.items.length > 0
          // With a pipeline drawn, its summary in words is shown only where
          // the deck is wide: the circles say it first.
          const words = piped ? 'hidden @min-[1100px]:block' : ''
          return (
            <li key={p.url} data-deck-pr={p.number}
              className="grid min-w-0 grid-cols-[8px_minmax(0,1fr)_auto_auto_56px] items-center gap-x-2 rounded-[5px] text-[12.5px] hover:bg-[var(--app-row-hover)]">
              <span aria-hidden className={`h-2 w-2 rounded-full ${PR_DOT[st.ciTone === 'none' ? st.tone : st.ciTone]}`} />
              <button type="button" onClick={() => openExternal(p.live?.url || p.url)} title={`${p.live?.title || p.title || ''}\nOpen the pull request on GitHub`}
                className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-left">
                <span className="num text-fg">#{p.number}</span>
                <span className="truncate text-fg-muted">{p.live?.title || p.title}</span>
              </button>
              {piped
                ? <MiniPipeline nodes={checkNodes(p.live!.checks.items, Date.now())} label={`#${p.number}: its checks`}
                    onPick={(node) => { if (node.jobId && onPick) onPick(p.number, node.jobId); else if (node.url) openExternal(node.url) }} />
                : <span />}
              {st.ci && st.ciUrl
                ? <button type="button" data-deck-ci onClick={() => openExternal(st.ciUrl!)} title="Open the CI run on GitHub"
                    className={`max-w-[112px] truncate text-left font-medium underline-offset-2 hover:underline ${words} ${STATUS_TEXT[st.ciTone]}`}>{st.ci}</button>
                : <span data-deck-ci-none={st.ciTitle ? '' : undefined} title={st.ciTitle} className={`max-w-[112px] truncate ${words} ${st.ciTitle ? 'text-fg-faint' : `font-medium ${STATUS_TEXT[st.ciTone]}`}`}>{st.ci}</span>}
              <span className={`col-start-5 truncate font-medium ${STATUS_TEXT[st.tone]}`}>{st.state}</span>
            </li>
          )
        })}
      </ul>
    </Cell>
  )
}
