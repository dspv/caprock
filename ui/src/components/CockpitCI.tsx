/**
 * The cockpit's CI block. Its first view, *PRs*, is the repository's pull
 * requests in flight as progress bars toward a release (owner, 2026-10-14, translated:
 * "roughly the current size, showing PRs as progress bars toward release;
 * scrollable; we see PR statuses and CI statuses; from there you can expand
 * to a bigger block, and open the separate page"): each row its number, its
 * title, the four steps Open → CI → Merged → Released as a thin bar with the
 * step it is on coloured — its CI's colour on the CI step — and how long it
 * has been there; the same steps the Pipeline page's rows draw (lib/journey).
 * The list scrolls inside the block; *Expand* makes it taller (remembered),
 * *Pipeline →* opens the page (→, not ↗: it stays in Caprock). It reads the Pipeline's own answer
 * (…/ci/stats, kept by the daemon), asked while the block is unfolded and
 * the window shown, and draws the copy last kept at once.
 *
 * In flight only (owner, 2026-10-16, translated: "on the right it sometimes
 * shows too many PRs, e.g. for caprock-web"): the open pull requests and
 * the ones merged since the newest release, still heading to one
 * (lib/journey `inFlight`); released and closed-unmerged ones are dropped.
 * A repository with no published release (caprock-web pushes its changelog
 * syncs straight to master and tags nothing) has only its open ones in
 * flight. With nothing in flight it says so in one quiet line — *Nothing in
 * flight · last release v0.124.0, 2h ago* — over the three newest merges.
 *
 * (owner, 2026-10-13, translated: "I'd like to move
 * some CI/CD indicators into the right part — try making the indicator switch
 * between views right away, we'll see what sticks"): the session's pull
 * requests and their checks, in one of three views kept per viewer —
 * each PR's checks in one short group (the default, as the deck's rows
 * say them: "✗ 1 failed ✓ 11", every check on hover), one ring with "10/11 · 4m" and the time
 * against the median, or the newest PR's checks by runner OS (ByOS). A click
 * opens the Pipeline page. Each tab names what it shows on hover. Hovering a
 * PR's checks lists them only after the pointer rests there, beside the
 * panel rather than over it (CheckSummary `beside`).
 *
 * Ring and By OS draw the session's own newest PR when the session deck
 * read it with its checks (lib/deckCache, `prs:<session>` and `ci:<session>:<pr>`, redrawn
 * when the deck is told something new). Without one they draw the newest
 * in-flight PR of the same …/ci/stats answer the PRs view reads, asking
 * that PR's checks themselves (…/ci?pr=, kept as `ci:<session>:<pr>`) while
 * the view is shown unfolded (owner, 2026-10-16, translated: "the Ring mode
 * is empty"). With nothing in flight they say so in the same one line;
 * with neither answer kept the block is not drawn.
 */
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { api, type SessionCI, type SessionCIStats, type SessionPRs } from '@/lib/api'
import type { PRCheck, PullRequest } from '@/lib/github'
import { ciActive, orderPRs, osName, osRollup, prChecks, readCockpitCIView, runVsMedian, saveCockpitCIView, fmtRun, type CockpitCIView } from '@/lib/ci'
import { freshText, onDeckAnswer, readDeck } from '@/lib/deckCache'
import { asBoard } from '@/lib/prboard'
import { tabRows, spanText } from '@/lib/prstats'
import { flightLead, inFlight, journey, pipelineRows, stageOf, type Flight, type PipelineRow } from '@/lib/journey'
import { landingOf } from '@/lib/releaseplan'
import { CheckSummary, StateMark } from './CheckSummary'
import { SectionLabel, useFolded } from './Cockpit'
import { JourneyBar, JourneyLegend } from './Journey'
import { CI_IDLE_MS, CI_RUNNING_MS, usePoll } from './SessionDeck'

/** The pull request the Ring and By OS views draw, with its checks. */
type LeadPR = { number: number; live: PullRequest }

/** The most pull requests the PRs view lists (it scrolls). */
const LISTED = 40

/** The PRs view's height, and taller once expanded (remembered per viewer). */
const TALL_KEY = 'caprock.cockpit.pipeline.tall'
function readTall(): boolean {
  try { return localStorage.getItem(TALL_KEY) === '1' } catch { return false }
}

// Each tab says what it shows, on hover and to a screen reader (owner,
// 2026-10-14, translated: "OS mode is unclear").
const VIEWS: { v: CockpitCIView; label: string; title: string }[] = [
  { v: 'dots', label: 'PRs', title: 'PRs: the repository’s pull requests in flight — open, or merged since the last release — on their way to a release, as progress bars' },
  { v: 'ring', label: 'Ring', title: 'Ring: the newest pull request’s checks as one ring — done of all, the time, and against your usual run' },
  { v: 'grid', label: 'By OS', title: 'By OS: the newest pull request’s checks by runner — Linux, macOS, Windows — each with its state and longest time' },
]

/** The deck's last answer under key, redrawn when the deck is told a new one. */
export function useDeckAnswer<T>(key: string): { d?: T; at?: number } {
  const snap = useSyncExternalStore(
    (cb) => onDeckAnswer((k) => { if (k === key) cb() }),
    () => readDeck<T>(key),
  )
  return { d: snap?.d, at: snap?.at }
}

/** Where a PR's checks stand: how many of each, and how long since the first started. */
export function checkSummary(items: PRCheck[], now: number): { total: number; pass: number; fail: number; running: number; queued: number; ms?: number } {
  let pass = 0, fail = 0, running = 0, queued = 0
  let start = Infinity, end = 0
  for (const c of items) {
    if (c.state === 'pass') pass++
    else if (c.state === 'fail') fail++
    else if (c.state === 'skipped') { /* counted in the total only */ }
    else if (c.status === 'in_progress') running++
    else queued++
    if (c.started_at) start = Math.min(start, c.started_at)
    end = Math.max(end, c.completed_at || 0)
  }
  const done = running === 0 && queued === 0
  const ms = start === Infinity ? undefined : Math.max(0, (done ? end : now) - start)
  return { total: items.length, pass, fail, running, queued, ms: ms || undefined }
}

export function CockpitCI({ sessionId, repoScope, onOpen }: { sessionId: string; repoScope?: string; onOpen?: () => void }) {
  const [view, setViewState] = useState<CockpitCIView>(readCockpitCIView)
  const setView = (v: CockpitCIView) => { setViewState(v); saveCockpitCIView(v) }
  const [tall, setTallState] = useState(readTall)
  const setTall = (v: boolean) => { setTallState(v); try { localStorage.setItem(TALL_KEY, v ? '1' : '0') } catch { /* this page only */ } }
  const folded = useFolded()
  // The Pipeline's answer: asked only while the block is shown unfolded.
  const [stats, statsAt] = usePoll<SessionCIStats>(!folded && !!onOpen, `cockpit:${sessionId}`, () => api.sessionCIStats(sessionId), () => false, CI_IDLE_MS, `stats:${repoScope || sessionId}`)
  const board = useMemo(() => asBoard(stats?.board), [stats?.board])
  const flight = useMemo(() => {
    const f = inFlight(pipelineRows(tabRows('repo', [], stats?.prs ?? []), board, stats?.prs ?? []), board)
    return { ...f, rows: f.rows.slice(0, LISTED) }
  }, [stats?.prs, board])
  const hasStats = !!stats?.connected && (stats.prs?.length ?? 0) > 0
  const prs = useDeckAnswer<SessionPRs>(`prs:${sessionId}`)
  const rows = orderPRs(prs.d?.prs ?? []).filter((p) => !!p.live)
  // The session's own newest PR when the deck read it with checks, else the newest in flight.
  const deckLead = prs.d?.connected && (rows[0]?.live?.checks.items.length ?? 0) > 0 ? rows[0] : undefined
  const flown = deckLead ? undefined : flightLead(flight)
  const leadNo = deckLead?.number ?? flown?.number ?? 0
  const ci = useDeckAnswer<SessionCI>(leadNo ? `ci:${sessionId}:${leadNo}` : '')
  // That PR's checks, asked only for Ring and By OS shown unfolded, and only when the deck has none.
  const [, ciAt] = usePoll<SessionCI>(view !== 'dots' && !folded && !!onOpen && !deckLead && leadNo > 0, `cockpit-ci:${sessionId}:${leadNo}`, () => api.sessionCI(sessionId, leadNo), (d) => ciActive(d.ci), CI_RUNNING_MS, leadNo ? `ci:${sessionId}:${leadNo}` : undefined)
  const lead: LeadPR | undefined = deckLead?.live ? { number: deckLead.number, live: deckLead.live }
    : flown && ci.d?.pr?.number === flown.number && ci.d.pr.live ? { number: flown.number, live: ci.d.pr.live } : undefined
  const running = rows.some((p) => p.live?.checks.state === 'pending') || lead?.live.checks.state === 'pending'
  // A clock only while a check runs and the window is shown: the elapsed time moves.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (!running) return
    const t = window.setInterval(() => { if (!document.hidden) setNow(Date.now()) }, 1000)
    return () => window.clearInterval(t)
  }, [running, prs.at, ci.at])
  if (!hasStats && !deckLead) return null
  const leadSum = folded && lead ? prChecks(lead, now) : undefined
  const at = view === 'dots' ? (stats?.read_at || stats?.fetched_at || statsAt) : deckLead ? prs.at : (ci.at || ciAt)
  const quiet = hasStats && flight.rows.length === 0 ? <Quiet f={flight} now={now} /> : null
  const listed = flight.rows.length > 0 ? flight.rows : flight.recent

  const faint = (text: string) => <span className="text-[11.5px] text-fg-faint">{text}</span>
  const checksOf = (draw: (p: LeadPR) => ReactNode) =>
    lead ? draw(lead) : quiet ?? (flown ? faint(ci.d?.pr?.number === flown.number ? `#${flown.number}’s checks could not be read.` : `Reading #${flown.number}’s checks…`) : faint('Reading the repository’s pull requests…'))
  const body = view === 'ring' ? checksOf((p) => <Ring p={p} ci={ci.d} now={now} />) : view === 'grid' ? checksOf((p) => <ByOS p={p} ci={ci.d} now={now} />) : (
    !hasStats ? faint('Reading the repository’s pull requests…') : (
      <div className="grid gap-1">
      {quiet}
      {listed.length > 0 && <JourneyLegend className="-mr-1.5 pr-1.5" />}
      {listed.length > 0 && <ul data-cockpit-journey className={`app-scroll -mr-1.5 grid content-start gap-1.5 overflow-y-auto pr-1.5 ${tall ? 'max-h-[440px]' : 'max-h-[176px]'}`}>
        {listed.map((r) => <JourneyRow key={r.number} r={r} now={now} />)}
      </ul>}
      </div>
    )
  )

  return (
    <section aria-label="CI" data-cockpit-ci={view} data-checks-edge className="grid gap-2">
      <SectionLabel right={(
        <span className="flex items-center gap-2">
          <span className="text-[10.5px] text-fg-faint" title={view === 'dots' ? 'When GitHub was last read for the Pipeline' : deckLead ? 'What the session deck last read' : 'When GitHub was last read for this pull request’s checks'}>{at ? freshText(now - at).replace('updated ', '') : ''}</span>
          {/* Folded, the newest PR's checks are its one line, in place of the view tabs. */}
          {leadSum && lead && (
            <span data-fold-only className="flex min-w-0 items-center gap-1.5">
              <span className="num shrink-0 text-[11.5px] text-fg-muted">#{lead.number}</span>
              <CheckSummary s={leadSum} label={`#${lead.number}: its checks`} focusable={false} beside className="shrink-0" />
            </span>
          )}
          {!folded && (
            <span role="tablist" aria-label="CI view" className="flex items-center gap-px rounded-[5px] border border-[var(--app-hairline)] p-px">
              {VIEWS.map((x) => (
                <button key={x.v} type="button" role="tab" aria-selected={view === x.v} data-cockpit-ci-view={x.v} title={x.title} aria-label={x.title} onClick={() => setView(x.v)}
                  className={`rounded-[4px] px-1.5 text-[10.5px] leading-[15px] ${view === x.v ? 'bg-[var(--app-row-hover)] text-fg' : 'text-fg-faint hover:text-fg-muted'}`}>{x.label}</button>
              ))}
            </span>
          )}
        </span>
      )}>CI</SectionLabel>
      {view === 'dots' ? (
        <>
          {body}
          <span className="flex items-center justify-between gap-2 text-[11px]">
            {listed.length > 4 ? (
              <button type="button" data-cockpit-ci-tall aria-expanded={tall} onClick={() => setTall(!tall)} className="text-fg-faint hover:text-fg-muted">{tall ? 'Less' : 'Expand'}</button>
            ) : <span />}
            {onOpen && <button type="button" data-cockpit-ci-open onClick={onOpen} title="Open the Pipeline: its own tab, beside the Dashboard" className="text-accent hover:underline">Pipeline →</button>}
          </span>
        </>
      ) : (
        <button type="button" data-cockpit-ci-open onClick={onOpen} disabled={!onOpen} title="Open the Pipeline page in a tab"
          className="-mx-1.5 rounded-[6px] px-1.5 py-1 text-left hover:bg-[var(--app-row-hover)] disabled:cursor-default disabled:hover:bg-transparent">
          {body}
        </button>
      )}
    </section>
  )
}

/** One pull request's row: its number, title, time on its step and the four steps as a bar. */
function JourneyRow({ r, now }: { r: PipelineRow; now: number }) {
  const since = r.card?.stage_at ?? r.merged_at ?? r.created_at
  return (
    <li data-cockpit-ci-pr={r.number} data-stage={stageOf(r)} className="grid min-w-0 gap-1">
      <span className="flex min-w-0 items-center gap-1.5 text-[12px]">
        <span className="num shrink-0 text-fg-muted">#{r.number}</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg" title={r.title}>{r.title}</span>
        {since ? <span className="num shrink-0 text-[10.5px] text-fg-faint" title={new Date(since).toLocaleString()}>{spanText(Math.max(0, now - since))}</span> : null}
      </span>
      <JourneyBar steps={journey(r)} landing={landingOf(r.labels)?.word} />
    </li>
  )
}

/** Nothing in flight, in one quiet line: *Nothing in flight · last release v0.124.0, 2h ago*. */
function Quiet({ f, now }: { f: Flight; now: number }) {
  const rel = f.release
  return (
    <span data-cockpit-ci-quiet className="truncate text-[11.5px] text-fg-faint" title={rel ? new Date(rel.published_at).toLocaleString() : 'GitHub lists no published release for this repository'}>
      Nothing in flight · {rel ? `last release ${rel.tag}, ${spanText(Math.max(0, now - rel.published_at))} ago` : 'no release published'}
    </span>
  )
}

/** One ring for the lead PR: its checks done of all, its time, and its run against the median. */
function Ring({ p, ci, now }: { p: LeadPR; ci?: SessionCI; now: number }) {
  const s = checkSummary(p.live.checks.items, now)
  const r = 15
  const c = 2 * Math.PI * r
  const arc = (n: number) => (s.total ? (n / s.total) * c : 0)
  const segs: { n: number; color: string }[] = [
    { n: s.pass, color: 'var(--color-ok)' }, { n: s.fail, color: 'var(--color-danger)' }, { n: s.running, color: 'var(--color-warn)' },
  ]
  let off = 0
  const run = ci?.pr?.number === p.number ? ci.ci?.runs?.[0] : undefined
  const vs = run ? runVsMedian(run, now) : undefined
  const done = s.pass + s.fail
  return (
    <span data-cockpit-ci-ring className="flex items-center gap-3">
      <svg width="38" height="38" viewBox="0 0 38 38" role="img" aria-label={`${done} of ${s.total} checks done`} className="shrink-0 -rotate-90">
        <circle cx="19" cy="19" r={r} fill="none" stroke="var(--app-hairline)" strokeWidth="4" />
        {segs.map((g, i) => {
          const len = arc(g.n)
          const el = len > 0 ? <circle key={i} cx="19" cy="19" r={r} fill="none" stroke={g.color} strokeWidth="4" strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-off} className={g.color.includes('warn') ? 'animate-pulse motion-reduce:animate-none' : ''} /> : null
          off += len
          return el
        })}
      </svg>
      <span className="grid min-w-0 gap-0.5">
        <span className="num text-[15px] font-semibold leading-none text-fg">{done}/{s.total}{s.ms ? <span className="text-[12px] font-normal text-fg-muted"> · {fmtRun(s.ms)}</span> : null}</span>
        <span className="truncate text-[11px] text-fg-muted">
          #{p.number}{s.fail ? <span className="text-danger"> · {s.fail} failed</span> : null}{s.running ? <span className="text-warn"> · {s.running} running</span> : null}
          {vs ? <span className={vs.tone === 'warn' ? 'text-warn' : 'text-fg-faint'}> · {vs.text}</span> : null}
        </span>
      </span>
    </span>
  )
}

const OS_WORD = { pass: 'passed', fail: 'failed', running: 'running', queued: 'queued', skipped: 'skipped' } as const
const OS_TEXT = { pass: 'text-ok', fail: 'text-danger', running: 'text-warn', queued: 'text-fg-muted', skipped: 'text-fg-faint' } as const

/**
 * The newest PR's checks by runner OS, one line each: *Linux ✓ passed 1m 48s
 * · 4 checks*, *Windows ● running 2m 10s*. It used to be a job × OS matrix
 * that showed only once the PR's row had been opened in the deck, and said
 * so in place of anything else; this reads the checks the PR row already
 * carries (with their jobs when the deck read them), so it always has
 * something to show unless no check names an OS.
 */
function ByOS({ p, ci, now }: { p: LeadPR; ci?: SessionCI; now: number }) {
  const runs = ci?.pr?.number === p.number ? ci.ci?.runs : undefined
  const sum = prChecks(p, now, runs)
  const rows = sum ? osRollup(sum.nodes) : []
  if (rows.length === 0) return <span className="text-[11.5px] text-fg-faint">#{p.number}’s checks name no runner OS.</span>
  return (
    <span data-cockpit-ci-os className="grid grid-cols-[auto_10px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 text-[11.5px]">
      {rows.map((r) => (
        <span key={r.os} data-os={r.os} data-tone={r.tone} className="contents">
          <span className="text-fg">{osName(r.os)}</span>
          <StateMark tone={r.tone} />
          <span className={`truncate ${OS_TEXT[r.tone]}`}>{OS_WORD[r.tone]}{r.ms ? <span className="num text-fg-muted"> {fmtRun(r.ms)}</span> : null}</span>
          <span className="num text-right text-fg-faint">{r.counts.total} {r.counts.total === 1 ? 'check' : 'checks'}</span>
        </span>
      ))}
    </span>
  )
}
