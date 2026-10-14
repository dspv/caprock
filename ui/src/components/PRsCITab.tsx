/**
 * The Pipeline page (.ai/04-ui.md § Pipeline; until 2026-10-14 "Pipeline"):
 * the session deck's Pull requests & CI cell, large (owner, 2026-10-13,
 * translated: "I want to expand the panel bigger, to see the statuses large
 * and in detail, plus statistics"). ⇧⌘B opens it as a tab of its own and
 * brings back the tab before it.
 *
 * One list (owner, 2026-10-14, translated: "PR titles are missing … I'd
 * merge it all into one — PR rows with their statuses, so I understand how
 * things travel, what gets released"): the flow strip on top, then every
 * pull request as a row — its number, its whole title, its labels, its four
 * steps Open → CI → Merged → Released (lib/journey, the cockpit draws the
 * same), how long in the step, its agent cost — in flight first, then
 * merged, then released (ten, then "Show more"), and the releases below. A
 * row opens the pull request in detail over the list's right side: state,
 * review, merge state and diff, the deck's actions, its jobs by runner OS
 * against each one's median, the jobs on the run's clock, a job's steps and
 * the end of a failed one's log.
 *
 * Asked only while the tab is in front and the window visible (usePoll), and
 * through the deck's own routes and kept answers (lib/deckCache), so opening
 * it shows what the deck last knew at once.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, errText, type CIJob, type CIRun, type SessionCI, type SessionCIStats, type SessionPRLive, type SessionPRs, type SessionSummary, type SpawnRequest } from '@/lib/api'
import { ciActive, ciTone, fmtRun, investigateMessage, jobVsMedian, keyStep, prReviewText, prVerdict, type CITone } from '@/lib/ci'
import { hasConflict, isBehind, topChip, type DeckWorktree } from '@/lib/prforce'
import { FORCE_LABEL, FORCE_TITLE, usePRForce, type ForceKind } from '@/lib/usePRForce'
import { GRID_OS_LABEL, SCOPE_LABEL, jobGrid, spanText, tabRows, vsMedianText, type TabPR, type TabScope } from '@/lib/prstats'
import { AGENT_COST_NOTE, asBoard, costText, costTitle } from '@/lib/prboard'
import { journey, pipelineRows, stageOf, type PipelineRow } from '@/lib/journey'
import { useCanControl } from '@/lib/useCanControl'
import { openExternal } from '@/lib/nudges'
import { keys } from '@/lib/appkeys'
import { sessionTitle } from '@/lib/sidebar'
import { FlowStrip, Releases } from './PRBoard'
import { JourneyPills } from './Journey'
import { GitHubPerson } from './GitHubAvatar'
import { CI_IDLE_MS, CI_RUNNING_MS, CIMark, DeckSkeleton, ExpandToggle, Freshness, PRS_PENDING_MS, connectGitHub, usePoll } from './SessionDeck'

export interface PRsCITabProps {
  /** The agent session the tab was opened from: its repository, its pull requests. */
  sessionId: string
  session?: SessionSummary
  /** The tab is in front: only then is anything asked. */
  visible: boolean
  /** Back to the deck: the agent's tab, with its deck open. */
  onBack: () => void
  onToast?: (text: string) => void
  worktrees?: DeckWorktree[]
  onStartAgent?: (req: SpawnRequest, title: string) => Promise<void>
}

const SCOPE_KEY = 'caprock.prsTab.scope'
function readScope(): TabScope {
  try {
    const v = localStorage.getItem(SCOPE_KEY)
    return v === 'session' || v === 'repo' || v === 'open' ? v : 'repo'
  } catch { return 'repo' }
}

/** A refused read with nothing in it (a daemon just started, GitHub down)
 *  never replaces a list that had pull requests: it stays, said to be not
 *  refreshed. */
const keepStats = (prev: SessionCIStats, next: SessionCIStats) => !!next.error && (next.prs?.length ?? 0) === 0 && (prev.prs?.length ?? 0) > 0

export function PRsCITab(props: PRsCITabProps) {
  const { session, onBack } = props
  if (!session) {
    return (
      <div className="flex h-full flex-col items-start gap-3 bg-bg p-6 text-[13px]">
        <p className="text-fg-muted">The session this tab was opened from is no longer listed.</p>
        <BackButton onBack={onBack} />
      </div>
    )
  }
  return <TabBody {...props} session={session} />
}

function BackButton({ onBack }: { onBack: () => void }) {
  return <ExpandToggle collapse onClick={onBack} />
}

function TabBody({ sessionId, session: s, visible, onBack, onToast, worktrees, onStartAgent }: PRsCITabProps & { session: SessionSummary }) {
  const canControl = useCanControl()
  const [scope, setScopeState] = useState<TabScope>(readScope)
  const setScope = (v: TabScope) => { setScopeState(v); try { localStorage.setItem(SCOPE_KEY, v) } catch { /* this page only */ } }
  const [n, setN] = useState(0)
  // The pull request opened over the list; none until a row is clicked.
  const [chosen, setChosen] = useState<number>()
  const [now, setNow] = useState(() => Date.now())
  const [connecting, setConnecting] = useState(false)
  const repoScope = s.repo_root || s.cwd || sessionId

  const [stats, statsAt, statsMeta] = usePoll<SessionCIStats>(visible, `${sessionId}:${n}`, () => api.sessionCIStats(sessionId), () => false, CI_IDLE_MS, `stats:${repoScope}`, keepStats)
  const [prs] = usePoll<SessionPRs>(visible, `${sessionId}:${n}`, () => api.sessionPRs(sessionId), (d) => d.prs.some((p) => p.live?.checks.state === 'pending'), PRS_PENDING_MS, `prs:${sessionId}`)
  const sessionPRs = useMemo(() => prs?.prs ?? [], [prs])
  const board = useMemo(() => asBoard(stats?.board), [stats?.board])
  const rows = useMemo(() => pipelineRows(tabRows(scope, sessionPRs, stats?.prs ?? []), board, stats?.prs ?? []), [scope, sessionPRs, stats?.prs, board])
  const pick = chosen ?? 0
  // The detail takes the focus as it opens, so Esc closes it whatever was clicked.
  const detailRef = useRef<HTMLElement>(null)
  useEffect(() => { if (chosen) detailRef.current?.focus({ preventScroll: true }) }, [chosen])
  // What the header says of it: the time GitHub was last read (an answer
  // composed from an older read says so), and why a read failed: a list
  // GitHub refused comes with the one read before, and what did not fit the
  // daemon's GitHub budget is said in `error` too.
  const statsShownAt = stats?.read_at || stats?.fetched_at || statsAt || undefined
  const statsFailed = statsMeta.failed || (!!stats?.error && !statsMeta.loading)
  const statsReason = statsMeta.reason ?? stats?.error?.message
  // Rows not yet re-confirmed — the copy kept from before, an answer that
  // could not be refreshed — are drawn faint until a fresh one lands.
  const unconfirmed = !statsMeta.confirmed || statsFailed
  // The chosen pull request's CI is read only while it is open over the list.
  const [ciData, ciAt] = usePoll<SessionCI>(visible && pick > 0, `${sessionId}:${pick}:${n}`, () => api.sessionCI(sessionId, pick), (d) => ciActive(d.ci), CI_RUNNING_MS, pick > 0 ? `ci:${sessionId}:${pick}` : undefined)
  const ci = ciData?.pr?.number === pick ? ciData : undefined
  const connected = stats?.connected ?? prs?.connected
  useEffect(() => { setNow(Date.now()) }, [statsAt, ciAt, prs])

  // A clock only while a job runs, the tab in front and the window shown.
  const running = ciActive(ci?.ci)
  useEffect(() => {
    if (!running || !visible) return
    const t = window.setInterval(() => { if (!document.hidden) setNow(Date.now()) }, 1000)
    return () => window.clearInterval(t)
  }, [running, visible])

  const row = rows.find((r) => r.number === pick) ?? pipelineRows(tabRows('repo', sessionPRs, stats?.prs ?? []), board, stats?.prs ?? []).find((r) => r.number === pick)
  const runs: CIRun[] = useMemo(() => ci?.ci?.runs ?? [], [ci?.ci?.runs])
  // The chosen pull request as the deck's rows carry it, so the deck's words and actions apply.
  const p: SessionPRLive | undefined = row ? {
    ...(row.mine ?? { session_id: sessionId, url: row.url, number: row.number, title: row.title, last_at: 0 }),
    live: ci?.pr?.live ?? row.mine?.live,
  } : undefined

  const why = !canControl ? 'This device can only watch. To act from it, open the Caprock app on your computer: Settings → Use on your phone, then press Let it control sessions next to this device.'
    : !s.owned ? 'Caprock did not start this session, so it never types into it.'
      : s.status === 'ended' || s.detached ? 'This session is no longer running here, so nothing can be queued to it.' : ''
  const kit = usePRForce({
    sessionId, s, worktrees, onStartAgent, onToast, canControl, connected, why,
    runsOf: (x) => (ci?.pr?.number === x.number ? runs : undefined),
    onDone: () => setN((x) => x + 1),
  })

  const connect = async () => {
    setConnecting(true)
    if (await connectGitHub()) setN((x) => x + 1)
    setConnecting(false)
  }
  const ready = !stats?.reason && stats?.connected !== false
  const counts = { session: sessionPRs.length, repo: tabRows('repo', sessionPRs, stats?.prs ?? []).length, open: tabRows('open', sessionPRs, stats?.prs ?? []).length }

  return (
    <div data-prs-tab onKeyDown={(e) => {
      if (e.key !== 'Escape') return
      if (kit.confirm) kit.setConfirm(undefined)
      else if (pick) setChosen(undefined)
      else return
      e.preventDefault()
    }}
      className="relative @container/prs flex h-full min-h-0 flex-col bg-bg">
      <div className="app-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        <header className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="shrink-0 text-[15px] font-semibold" title="Each pull request on its way: opened, its CI, merged, released">Pipeline</h1>
          {stats?.repo && <span className="mono truncate text-[12px] text-fg-muted">{stats.repo}</span>}
          <span className="ml-auto flex min-w-0 max-w-[50%] items-center justify-end gap-2 text-[11.5px]">
            <Freshness at={statsShownAt} loading={statsMeta.loading} failed={statsFailed} reason={statsReason} confirmed={statsMeta.confirmed} onRetry={statsMeta.retry} />
          </span>
          <BackButton onBack={onBack} />
        </header>
        {stats?.reason ? (
          <p className="text-[13px] text-fg-muted">{stats.reason === 'not_github' ? 'This session’s repository is not on GitHub.' : 'This session’s folder is not a git repository with a remote.'}</p>
        ) : stats && !stats.connected ? (
          <div className="flex items-center gap-3 rounded-[var(--radius-panel)] border border-border bg-panel px-4 py-3 text-[13px]">
            <span className="text-fg-muted">The figures, the repository’s pull requests and their CI are read from GitHub.</span>
            <button type="button" data-prs-connect disabled={connecting} onClick={() => void connect()} title="Reads GitHub through your GitHub CLI login; turn it off in Settings → GitHub"
              className="text-accent hover:underline disabled:opacity-60">{connecting ? 'connecting…' : 'Connect GitHub'}</button>
          </div>
        ) : null}
        {ready && (board ? <FlowStrip board={board} />
          : !stats ? <DeckSkeleton label="Reading the figures" />
            : stats.error && (stats.prs?.length ?? 0) === 0 ? <p className="truncate text-[12px] text-warn" title={stats.error.message}>Not read: {stats.error.message}</p> : null)}
        {ready && (
          <PipelineList rows={rows} scope={scope} onScope={setScope} pick={pick} onPick={(num) => setChosen(num === pick ? undefined : num)} now={now}
            counts={counts} loaded={!!prs || !!stats} dim={unconfirmed} />
        )}
        {ready && board && board.releases.length > 0 && <Releases releases={board.releases} prs={stats?.prs ?? []} now={now} onOpen={(num) => setChosen(num)} />}
      </div>
      {/* The chosen pull request over the list's right side, so the list
        * keeps its width (owner, 2026-10-14: readable at 1512 with the agent
        * panel open). Esc or × closes it. */}
      {p && row && (
        <section data-prs-detail role="dialog" aria-label={`#${row.number} in detail`} ref={detailRef} tabIndex={-1}
          className="app-scroll outline-none absolute inset-y-0 right-0 z-20 w-[min(640px,94%)] overflow-y-auto border-l border-border bg-panel shadow-[var(--shadow-pop,0_8px_28px_rgba(0,0,0,0.28))]">
          <div className="sticky top-0 z-10 flex items-center justify-end border-b border-border bg-panel/95 px-2 py-1 backdrop-blur">
            <button type="button" data-prs-detail-close onClick={() => setChosen(undefined)} title="Close (Esc)" aria-label="Close the pull request’s detail"
              className="rounded-[5px] px-2 text-[16px] leading-[22px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">×</button>
          </div>
          <Detail p={p} row={row} ci={ci} runs={runs} now={now} sessionId={sessionId} kit={kit} connected={connected}
            why={why} onInvestigated={(t) => onToast?.(t)} sessionName={sessionTitle(s)} onConnect={() => void connect()} />
        </section>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- the list

/** How many released rows show before "Show more". */
const RELEASED_SHOWN = 10

function PipelineList({ rows, scope, onScope, pick, onPick, now, counts, loaded, dim }: { rows: PipelineRow[]; scope: TabScope; onScope: (s: TabScope) => void; pick: number; onPick: (n: number) => void; now: number; counts: Record<TabScope, number>; loaded: boolean; dim: boolean }) {
  const [allReleased, setAllReleased] = useState(false)
  const released = rows.filter((r) => stageOf(r) === 'released')
  const hidden = allReleased ? 0 : Math.max(0, released.length - RELEASED_SHOWN)
  const keep = new Set(released.slice(0, allReleased ? released.length : RELEASED_SHOWN).map((r) => r.number))
  const shown = rows.filter((r) => stageOf(r) !== 'released' || keep.has(r.number))
  return (
    <section data-prs-list aria-label="Pull requests" className="flex min-w-0 flex-col rounded-[var(--radius-panel)] border border-border bg-panel shadow-[var(--shadow-panel)]">
      <div role="tablist" aria-label="Which pull requests" className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border bg-panel-2/60 px-2 py-1.5 text-[11.5px]">
        {(['session', 'repo', 'open'] as TabScope[]).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={scope === k} data-prs-scope={k} onClick={() => onScope(k)}
            className={`whitespace-nowrap rounded-[5px] px-2 py-[2px] ${scope === k ? 'bg-[var(--app-row-active)] text-fg' : 'text-fg-muted hover:text-fg'}`}>
            {SCOPE_LABEL[k]} <span className="num text-fg-faint">{counts[k]}</span>
          </button>
        ))}
        <span className="ml-auto hidden text-[11px] text-fg-faint @min-[640px]/prs:inline" title={AGENT_COST_NOTE}>Open → CI → Merged → Released · agent cost at list price</span>
      </div>
      {!loaded ? <div className="p-2"><DeckSkeleton label="Reading the pull requests" /></div> : rows.length === 0 ? (
        <p className="p-3 text-[12px] text-fg-faint">{scope === 'session' ? 'No PR from this session yet.' : scope === 'open' ? 'Nothing open.' : 'No pull requests read.'}</p>
      ) : (
        <ul>
          {shown.map((r) => <PipelineItem key={r.number} r={r} on={r.number === pick} onPick={() => onPick(r.number)} now={now} dim={dim || !!r.card?.stale} />)}
          {hidden > 0 && (
            <li><button type="button" data-prs-more onClick={() => setAllReleased(true)} className="w-full px-3 py-2 text-left text-[12px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">Show {hidden} more released</button></li>
          )}
        </ul>
      )}
    </section>
  )
}

/** One pull request: number, its whole title, labels, the four steps, agent cost. */
function PipelineItem({ r, on, onPick, now, dim }: { r: PipelineRow; on: boolean; onPick: () => void; now: number; dim: boolean }) {
  const steps = journey(r)
  const at = r.card?.stage_at ?? r.merged_at ?? r.created_at
  const cost = r.card ? costText(r.card.spend) : ''
  return (
    <li data-prs-row={r.number} data-stage={stageOf(r)} data-prs-unconfirmed={dim ? '' : undefined}>
      <button type="button" onClick={onPick} aria-current={on || undefined}
        title={dim ? 'Not re-confirmed: from an earlier read of GitHub' : undefined}
        className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 border-b border-[var(--app-hairline)] px-3 py-2 text-left hover:bg-[var(--app-row-hover)] @max-[720px]/prs:grid-cols-1 ${on ? 'bg-[var(--app-row-active)] shadow-[inset_2px_0_0_var(--color-accent)]' : ''} ${dim ? 'opacity-60' : ''}`}>
        <span className="flex min-w-0 items-start gap-2">
          <span className="num mt-[1px] shrink-0 text-[12px] text-fg-muted">#{r.number}</span>
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 text-[13px] leading-[1.35] text-fg">{r.title}</span>
            {(r.labels?.length || r.author || r.mine) && (
              <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-fg-faint">
                {r.labels?.map((l) => <LabelChip key={l.name} name={l.name} color={l.color} />)}
                {r.author && <GitHubPerson login={r.author} url={r.author_avatar} size={13} className="min-w-0" />}
                {r.mine && <span className="text-accent">this session</span>}
              </span>
            )}
          </span>
        </span>
        <span className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1 @max-[720px]/prs:justify-start">
          <JourneyPills steps={steps} />
          {at ? <span className="num w-[52px] shrink-0 text-right text-[11px] text-fg-faint" title={new Date(at).toLocaleString()}>{spanText(Math.max(0, now - at))}</span> : null}
          <span className="num w-[56px] shrink-0 text-right text-[11.5px] text-fg-muted" title={r.card ? costTitle(r.card.spend) : undefined}>
            {cost || <span className="text-fg-faint">–</span>}
            {r.card && r.card.spend.live > 0 && <span className="ml-1 text-ok" title={`${r.card.spend.live} agent session${r.card.spend.live === 1 ? '' : 's'} running on it now`}>●</span>}
          </span>
        </span>
      </button>
    </li>
  )
}

/** A GitHub label: its colour as a dot, its name. */
function LabelChip({ name, color }: { name: string; color?: string }) {
  const c = color && /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : 'var(--color-fg-faint)'
  return (
    <span data-prs-label={name} className="inline-flex h-[17px] max-w-[160px] items-center gap-1 rounded-full border border-[var(--app-hairline-strong)] px-1.5 text-[10.5px] text-fg-muted">
      <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: c }} />
      <span className="truncate">{name}</span>
    </span>
  )
}

// ---------------------------------------------------------------- the chosen one

type Kit = ReturnType<typeof usePRForce>

const PILL: Record<string, string> = {
  ok: 'border-ok/40 bg-ok/10 text-ok', fail: 'border-danger/45 bg-danger/10 text-danger', pending: 'border-warn/40 bg-warn/10 text-warn',
  warn: 'border-warn/40 bg-warn/10 text-warn', muted: 'border-[var(--app-hairline)] text-fg-muted', faint: 'border-[var(--app-hairline)] text-fg-faint',
  merged: 'border-merged/45 bg-merged/10 text-merged',
}
function Pill({ tone, children, title, data }: { tone: string; children: ReactNode; title?: string; data?: string }) {
  return <span data-prs-pill={data} title={title} className={`inline-flex h-[24px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[12px] font-medium ${PILL[tone] ?? PILL.muted}`}>{children}</span>
}

function Detail({ p, row, ci, runs, now, sessionId, kit, connected, why, onInvestigated, sessionName, onConnect }: {
  p: SessionPRLive; row: TabPR; ci?: SessionCI; runs: CIRun[]; now: number; sessionId: string; kit: Kit; connected?: boolean
  why: string; onInvestigated: (t: string) => void; sessionName: string; onConnect: () => void
}) {
  const live = p.live
  const v = live ? prVerdict(p, now, runs) : undefined
  const review = prReviewText(p)
  const chip = topChip(p).chip
  const state = live?.state ?? row.state
  const jobs = runs.flatMap((r) => r.jobs)
  const [jobId, setJobId] = useState<number>()
  // The first failed job opens by itself: what failed is the question.
  const failed = jobs.find((j) => ciTone(j) === 'fail')
  const job = jobs.find((j) => j.id === jobId) ?? failed
  useEffect(() => { setJobId(undefined) }, [p.number])
  const created = live?.created_at ?? row.created_at
  const merged = live?.merged_at ?? row.merged_at
  return (
    <div data-prs-pr={p.number}>
      <div className="flex flex-col gap-2 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Pill tone={state === 'merged' ? 'merged' : state === 'open' ? (live?.draft ? 'muted' : 'ok') : 'faint'} data="state">{live?.draft && state === 'open' ? 'Draft' : state[0]!.toUpperCase() + state.slice(1)}</Pill>
          <span className="num shrink-0 text-[13px] text-fg-muted">#{p.number}</span>
          <h2 className="min-w-0 truncate text-[15px] font-semibold" title={live?.title ?? row.title}>{live?.title ?? row.title}</h2>
          <button type="button" onClick={() => openExternal(live?.url || row.url)} className="ml-auto shrink-0 text-[12px] text-fg-faint hover:text-fg-muted hover:underline">GitHub ↗</button>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {v && <Pill tone={v.tone} title={v.title} data="ci">{v.text}</Pill>}
          {chip && <Pill tone={chip.tone === 'fail' ? 'fail' : chip.tone === 'warn' ? 'warn' : 'muted'} title={chip.title} data="merge">{chip.word}</Pill>}
          {!chip && state === 'open' && live?.mergeable === true && <Pill tone="ok" data="merge">mergeable</Pill>}
          {review && <Pill tone={review.tone} title={review.title} data="review">{review.text}</Pill>}
          {live?.branch && <span className="mono truncate text-[11.5px] text-fg-muted">{live.branch} → {live.base}</span>}
          {live?.additions !== undefined && (
            <span data-prs-diff className="num whitespace-nowrap text-[12px]" title={`${live.changed_files ?? '?'} files · ${live.commits ?? '?'} commits`}>
              <span className="text-ok">+{live.additions.toLocaleString('en-US')}</span> <span className="text-danger">−{(live.deletions ?? 0).toLocaleString('en-US')}</span>
              <span className="text-fg-faint"> · {live.changed_files} files · {live.commits} commits</span>
            </span>
          )}
          <span className="text-[11.5px] text-fg-faint">
            {created ? `opened ${spanText(Math.max(0, now - created))} ago` : ''}{merged && created ? ` · merged in ${spanText(merged - created)}` : ''}
          </span>
        </div>
        <Actions p={p} kit={kit} connected={connected} onConnect={onConnect} />
      </div>
      {connected === false ? null : !ci ? (
        <div className="border-t border-border px-4 py-3"><DeckSkeleton label="Reading the CI" /></div>
      ) : !ci.ci ? (
        <p className="border-t border-border px-4 py-3 text-[12px] text-fg-faint">{ci.error ? `CI not read: ${ci.error.message}` : `#${p.number}: no commit to read CI for.`}</p>
      ) : jobs.length === 0 ? (
        <p className="border-t border-border px-4 py-3 text-[12px] text-fg-faint">No GitHub Actions runs on #{p.number}’s head commit.</p>
      ) : (
        <>
          <Part title="Checks · job × runner" right={<RunLine runs={runs} now={now} />}>
            <Grid runs={runs} now={now} on={job?.id} onPick={(id) => setJobId(id)} />
          </Part>
          <Part title="Timeline" right="each job on the run’s clock; the tick is its median">
            <Timeline jobs={jobs} now={now} />
          </Part>
          {job && <JobPart key={job.id} job={job} runs={runs} sessionId={sessionId} pr={p} why={why} onInvestigated={onInvestigated} sessionName={sessionName} />}
        </>
      )}
    </div>
  )
}

function Part({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="border-t border-border px-4 py-3">
      <div className="mb-2 flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h3 className="shrink-0 text-[11px] font-medium uppercase tracking-[0.12em] text-fg-muted">{title}</h3>
        {right && <span className="min-w-0 text-[11.5px] text-fg-faint">{right}</span>}
      </div>
      {children}
    </div>
  )
}

function RunLine({ runs, now }: { runs: CIRun[]; now: number }) {
  const span = runs.length === 1 ? (runs[0]!.status === 'completed' ? (runs[0]!.updated_at ?? 0) - (runs[0]!.started_at ?? 0) : now - (runs[0]!.started_at ?? now)) : 0
  const runner = runs.flatMap((r) => r.jobs).reduce((t, j) => t + (j.duration_ms ?? (j.started_at && j.status !== 'completed' ? now - j.started_at : 0)), 0)
  return <span className="num">{span > 0 ? `run ${fmtRun(span)} · ` : ''}runner {fmtRun(runner)}</span>
}

const CELL: Record<CITone, string> = {
  fail: 'border-danger/45 bg-danger/10', running: 'border-warn/40 bg-warn/[0.07]', pass: 'border-[var(--app-hairline)] bg-[var(--app-row-hover)]',
  queued: 'border-dashed border-[var(--app-hairline-strong)]', skipped: 'border-[var(--app-hairline)]',
}
const VS_TEXT = { warn: 'text-warn', ok: 'text-ok', muted: 'text-fg-faint' } as const

function Grid({ runs, now, on, onPick }: { runs: CIRun[]; now: number; on?: number; onPick: (id: number) => void }) {
  const g = jobGrid(runs)
  return (
    <div data-prs-grid className="grid gap-[4px]" style={{ gridTemplateColumns: `minmax(84px, 0.9fr) repeat(${g.oses.length}, minmax(0, 1fr))` }}>
      <span />
      {g.oses.map((o) => <span key={o} className="px-2 text-[10.5px] uppercase tracking-[0.12em] text-fg-faint">{GRID_OS_LABEL[o]}</span>)}
      {g.families.map((f) => (
        <GridRow key={f} family={f}>
          {g.oses.map((o) => {
            const j = g.cell(f, o)
            if (!j) return <span key={o} aria-hidden className="rounded-[6px] border border-dashed border-[var(--app-hairline)]" />
            const tone = ciTone(j)
            const ms = j.duration_ms ?? (j.started_at && tone === 'running' ? now - j.started_at : undefined)
            const vs = tone === 'pass' ? vsMedianText(j.duration_ms, j.baseline?.median_ms) : undefined
            const running = tone === 'running' ? jobVsMedian(j, now) : undefined
            const step = keyStep(j)
            return (
              <button key={o} type="button" data-prs-cell={j.id} data-tone={tone} onClick={() => onPick(j.id)} aria-pressed={on === j.id}
                title={`${j.name}${j.baseline ? `\nmedian ${fmtRun(j.baseline.median_ms)}, the last ${j.baseline.runs} successful runs` : ''}`}
                className={`flex min-h-[46px] min-w-0 flex-col justify-center rounded-[6px] border px-2 text-left ${CELL[tone]} ${on === j.id ? 'ring-1 ring-accent' : ''}`}>
                <span className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
                  <CIMark tone={tone} />
                  <span className="num text-[12.5px] text-fg">{ms !== undefined ? fmtRun(ms) : tone === 'queued' ? 'queued' : ''}</span>
                  {vs && <span className={`num text-[11px] @max-[900px]/prs:hidden ${VS_TEXT[vs.tone]}`}>{vs.text}</span>}
                </span>
                {(tone === 'fail' || tone === 'running') && step && (
                  <span className={`truncate text-[11px] ${tone === 'fail' ? 'text-danger' : 'text-fg-muted'}`}>
                    {tone === 'fail' ? 'failed at ' : 'on '}{step.name}{running ? ` · ${running.text}` : ''}
                  </span>
                )}
              </button>
            )
          })}
        </GridRow>
      ))}
    </div>
  )
}

function GridRow({ family, children }: { family: string; children: ReactNode }) {
  return (
    <>
      <span className="self-center truncate pr-2 text-[12.5px] text-fg" title={family}>{family}</span>
      {children}
    </>
  )
}

function Timeline({ jobs, now }: { jobs: CIJob[]; now: number }) {
  const shown = jobs.filter((j) => j.started_at)
  if (shown.length === 0) return <p className="text-[12px] text-fg-faint">No job has started yet.</p>
  const t0 = Math.min(...shown.map((j) => j.started_at!))
  const end = Math.max(...shown.map((j) => Math.max(j.completed_at ?? now, j.started_at! + (j.baseline?.median_ms ?? 0))))
  const span = Math.max(end - t0, 1)
  const pct = (t: number) => `${((t - t0) / span) * 100}%`
  return (
    <div data-prs-timeline className="flex flex-col gap-[3px]">
      {shown.map((j) => {
        const tone = ciTone(j)
        const to = j.completed_at ?? now
        const fill = tone === 'fail' ? 'var(--color-danger)' : tone === 'running' ? 'var(--color-warn)' : tone === 'pass' ? 'var(--color-ok)' : 'var(--color-fg-faint)'
        return (
          <div key={j.id} className="flex h-[18px] items-center gap-2" title={`${j.name}: ${fmtRun(to - j.started_at!)}${j.baseline ? ` · median ${fmtRun(j.baseline.median_ms)}` : ''}`}>
            <span className="w-[38%] max-w-[220px] shrink-0 truncate text-right text-[11.5px] text-fg-muted">{j.name}</span>
            <span className="relative h-[9px] flex-1 rounded-[3px] bg-[var(--app-row-hover)]">
              <span className="absolute top-0 h-full rounded-[3px]" style={{ left: pct(j.started_at!), width: `max(3px, calc(${pct(to)} - ${pct(j.started_at!)}))`, background: fill, opacity: tone === 'running' ? 0.75 : 1 }} />
              {j.baseline && <span aria-hidden className="absolute -top-[3px] h-[15px] w-[2px] rounded bg-fg-muted" style={{ left: pct(j.started_at! + j.baseline.median_ms) }} />}
            </span>
            <span className="num w-[52px] shrink-0 text-right text-[11px] text-fg-faint">{fmtRun(to - j.started_at!)}</span>
          </div>
        )
      })}
      <span className="num mt-1 text-right text-[10.5px] text-fg-faint">{fmtRun(span)} from the first job’s start</span>
    </div>
  )
}

/** A job's steps; for a failed one, the end of its log, Investigate and its link. */
function JobPart({ job, runs, sessionId, pr, why, onInvestigated, sessionName }: { job: CIJob; runs: CIRun[]; sessionId: string; pr: SessionPRLive; why: string; onInvestigated: (t: string) => void; sessionName: string }) {
  const tone = ciTone(job)
  const step = keyStep(job)
  const [log, setLog] = useState<{ lines: string[]; error_line: number } | { error: string }>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (tone !== 'fail') return
    let on = true
    api.sessionCILog(sessionId, job.id, 'pr', pr.number).then((l) => { if (on) setLog(l) }, (e) => { if (on) setLog({ error: errText(e) }) })
    return () => { on = false }
  }, [tone, sessionId, job.id, pr.number])
  const investigate = async () => {
    if (why) return
    setBusy(true)
    const lines = log && 'lines' in log ? log.lines : []
    const run = runs.find((r) => r.id === job.run_id)
    const text = investigateMessage({ pr: { number: pr.number, title: pr.live?.title ?? pr.title, url: pr.live?.url ?? pr.url }, workflow: run?.name, job, step: step?.name, lines })
    try {
      const res = await api.queueSend(sessionId, text)
      onInvestigated(`${res.sent ? 'Sent to' : 'Queued for'} ${sessionName}`)
    } catch (e) {
      onInvestigated(`Not queued: ${errText(e)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Part title={`${job.name}${step ? ` › ${step.name}` : ''}`} right={job.html_url ? <button type="button" onClick={() => openExternal(job.html_url!)} className="hover:text-fg-muted hover:underline">open on GitHub ↗</button> : undefined}>
      <ol data-prs-steps className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] gap-x-6">
        {job.steps.map((st) => (
          <li key={st.number} className={`flex min-w-0 items-center gap-1.5 rounded-[4px] px-1 text-[11.5px] leading-[20px] ${ciTone(st) === 'fail' ? 'bg-danger/10 text-danger' : 'text-fg-muted'}`}>
            <CIMark tone={ciTone(st)} /><span className="min-w-0 flex-1 truncate">{st.name}</span>
            {st.duration_ms !== undefined && <span className="num shrink-0 text-fg-faint">{fmtRun(st.duration_ms)}</span>}
          </li>
        ))}
      </ol>
      {tone === 'fail' && (
        <div className="mt-2 flex flex-col gap-2">
          {!log ? <p className="text-[11.5px] text-fg-faint">Reading the end of the log…</p> : 'error' in log ? <p className="text-[11.5px] text-warn">Log not read: {log.error}</p> : (
            <pre data-prs-log className="app-scroll max-h-[240px] overflow-auto rounded-[6px] border border-[var(--app-hairline)] bg-[var(--color-term-bg)] px-3 py-2 font-mono text-[11.5px] leading-[1.6] text-[#c9c5be]">
              {log.lines.map((l, i) => <div key={i} className={i === log.error_line ? 'ci-error-line text-[#ff8080]' : ''}>{l || ' '}</div>)}
            </pre>
          )}
          <span>
            <button type="button" data-prs-investigate disabled={!!why || busy} onClick={() => void investigate()}
              title={why || 'Queue this failure — the job, its step, its link and the end of its log — into this agent, to investigate and fix'}
              className="rounded-[6px] border border-accent/50 px-2.5 py-1 text-[12px] font-medium text-accent hover:bg-accent/10 disabled:cursor-not-allowed disabled:border-[var(--app-hairline)] disabled:text-fg-faint">
              {busy ? 'Queueing…' : 'Investigate'}
            </button>
          </span>
        </div>
      )}
    </Part>
  )
}

/** The deck's actions on the chosen pull request: each asks first, in a line, never a modal. */
function Actions({ p, kit, connected, onConnect }: { p: SessionPRLive; kit: Kit; connected?: boolean; onConnect: () => void }) {
  const live = p.live
  if (connected === false) {
    return <button type="button" onClick={onConnect} className="w-fit text-[12px] text-accent hover:underline">Connect GitHub to act on #{p.number}</button>
  }
  if (!live || live.state !== 'open') return null
  const kinds: ForceKind[] = []
  if (hasConflict(p)) kinds.push('conflict')
  else if (isBehind(p)) kinds.push('update')
  if (live.checks.items.length > 0) kinds.push('ci', 'rerun')
  if (kinds.length === 0) return null
  const c = kit.confirm?.pr === p.number ? kit.confirm : undefined
  const g = kit.progress[p.number]
  return (
    <div data-prs-actions className="flex min-w-0 flex-wrap items-center gap-2 text-[12px]">
      {c ? (
        <>
          <span data-prs-confirm className="min-w-0 truncate text-fg">{kit.confirmText(p, c.kind)}</span>
          <button type="button" autoFocus onClick={() => void kit.force(p, c.kind)} className="shrink-0 rounded-[6px] border border-accent/60 bg-accent/10 px-2.5 py-1 font-medium text-accent hover:bg-accent/20">Confirm</button>
          <button type="button" onClick={() => kit.setConfirm(undefined)} title={`Cancel (${keys('Esc')})`} className="shrink-0 rounded-[6px] px-2 py-1 text-fg-muted hover:bg-[var(--app-row-hover)]">Cancel</button>
        </>
      ) : kinds.map((k) => {
        const no = kit.forceWhy(p, k)
        return (
          <button key={k} type="button" data-prs-action={k} disabled={!!no || kit.forcing === p.number} onClick={() => kit.setConfirm({ pr: p.number, kind: k })} title={no || FORCE_TITLE[k]}
            className={`shrink-0 rounded-[6px] border px-2.5 py-1 disabled:cursor-not-allowed disabled:border-[var(--app-hairline)] disabled:text-fg-faint ${k === 'ci' || k === 'conflict' ? 'border-accent/60 text-accent hover:bg-accent/10' : 'border-[var(--app-hairline-strong)] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg'}`}>
            {FORCE_LABEL[k]}
          </button>
        )
      })}
      {!c && g && <span className="text-[11.5px] text-accent">{g.text}</span>}
    </div>
  )
}

