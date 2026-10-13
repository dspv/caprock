/**
 * The PRs & CI tab (.ai/21-app.md § PRs & CI tab): the session deck's Pull
 * requests & CI cell, large (owner, 2026-10-13, translated: "I want to
 * expand the panel bigger, to see the statuses large and in detail, plus
 * statistics … sometimes it's interesting to look"). Opened by Expand beside
 * the deck's Hide; Back to the deck closes it and brings the agent's tab back.
 *
 * Two views, Board first (owner, 2026-10-14): the Board — the pull requests
 * by stage, the agents on each and what they cost, the releases
 * (components/PRBoard.tsx) — and the List. The List has three parts: the repository's figures over two weeks on top (merged per
 * day, time to merge, CI time, red runs, Actions billed); the pull requests
 * on the left — this session's, the repository's newest, or the open ones;
 * the chosen one on the right — its state, review, merge state and diff,
 * the deck's actions, its jobs as a grid of job × runner OS against each
 * one's median, the jobs on the run's clock, and a job's steps and the end
 * of a failed one's log.
 *
 * Asked only while the tab is in front and the window visible (usePoll), and
 * through the deck's own routes and kept answers (lib/deckCache), so opening
 * it shows what the deck last knew at once. The figures cost one more read of
 * GitHub: the repository's newest 100 runs, kept 30 minutes by the daemon.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, errText, type CIJob, type CIRun, type SessionCI, type SessionCIStats, type SessionPRLive, type SessionPRs, type SessionSummary, type SpawnRequest } from '@/lib/api'
import { ciActive, ciTone, fmtRun, investigateMessage, jobVsMedian, keyStep, prReviewText, prVerdict, type CITone } from '@/lib/ci'
import { hasConflict, isBehind, topChip, type DeckWorktree } from '@/lib/prforce'
import { FORCE_LABEL, FORCE_TITLE, usePRForce, type ForceKind } from '@/lib/usePRForce'
import { GRID_OS_LABEL, SCOPE_LABEL, firstPick, jobGrid, spanText, statsWords, tabRows, vsMedianText, type TabPR, type TabScope } from '@/lib/prstats'
import { usageLine } from '@/lib/runnercost'
import { asBoard } from '@/lib/prboard'
import { useCanControl } from '@/lib/useCanControl'
import { openExternal } from '@/lib/nudges'
import { keys } from '@/lib/appkeys'
import { sessionTitle } from '@/lib/sidebar'
import { Bars, Trend } from './DayBars'
import { PRBoardView } from './PRBoard'
import { CI_IDLE_MS, CI_RUNNING_MS, CIMark, DeckSkeleton, ExpandIcon, Freshness, PRS_PENDING_MS, connectGitHub, usePoll } from './SessionDeck'

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

/** Board (the pull requests by stage, the releases) or List (one pull request in detail); Board unless the user chose List. */
type TabView = 'board' | 'list'
const VIEW_KEY = 'caprock.prsTab.view'
function readView(): TabView {
  try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'board' } catch { return 'board' }
}

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
  return (
    <button type="button" data-prs-back onClick={onBack} title="Close this tab and show the agent’s terminal with its deck"
      className="flex h-[26px] shrink-0 items-center gap-1.5 rounded-[6px] px-2 text-[12px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">
      <ExpandIcon back /> Back to the deck
    </button>
  )
}

function TabBody({ sessionId, session: s, visible, onBack, onToast, worktrees, onStartAgent }: PRsCITabProps & { session: SessionSummary }) {
  const canControl = useCanControl()
  const [scope, setScopeState] = useState<TabScope>(readScope)
  const setScope = (v: TabScope) => { setScopeState(v); try { localStorage.setItem(SCOPE_KEY, v) } catch { /* this page only */ } }
  const [view, setViewState] = useState<TabView>(readView)
  const setView = (v: TabView) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v) } catch { /* this page only */ } }
  const [n, setN] = useState(0)
  const [chosen, setChosen] = useState<number>()
  const [now, setNow] = useState(() => Date.now())
  const [connecting, setConnecting] = useState(false)
  const repoScope = s.repo_root || s.cwd || sessionId

  const [stats, statsAt, statsMeta] = usePoll<SessionCIStats>(visible, `${sessionId}:${n}`, () => api.sessionCIStats(sessionId), () => false, CI_IDLE_MS, `stats:${repoScope}`)
  const [prs] = usePoll<SessionPRs>(visible, `${sessionId}:${n}`, () => api.sessionPRs(sessionId), (d) => d.prs.some((p) => p.live?.checks.state === 'pending'), PRS_PENDING_MS, `prs:${sessionId}`)
  const sessionPRs = useMemo(() => prs?.prs ?? [], [prs])
  const rows = useMemo(() => tabRows(scope, sessionPRs, stats?.prs ?? []), [scope, sessionPRs, stats?.prs])
  const pick = chosen ?? firstPick(rows, sessionPRs) ?? 0
  const board = useMemo(() => asBoard(stats?.board), [stats?.board])
  const boardOn = view === 'board' && !stats?.reason && stats?.connected !== false
  // A card opens its pull request in the List view, in a scope that lists it.
  const openFromBoard = (num: number) => {
    if (!tabRows(scope, sessionPRs, stats?.prs ?? []).some((r) => r.number === num)) setScope('repo')
    setChosen(num)
    setView('list')
  }
  // The chosen pull request's CI is read only while the List view shows it.
  const [ciData, ciAt] = usePoll<SessionCI>(visible && view === 'list' && pick > 0,`${sessionId}:${pick}:${n}`, () => api.sessionCI(sessionId, pick), (d) => ciActive(d.ci), CI_RUNNING_MS, pick > 0 ? `ci:${sessionId}:${pick}` : undefined)
  const ci = ciData?.pr?.number === pick ? ciData : undefined
  const connected = stats?.connected ?? prs?.connected
  const owner = stats?.repo?.split('/')[0] ?? ''
  const [usage] = usePoll(visible && !!connected && !!owner, `${sessionId}:${owner}`, () => api.actionsUsage(owner), () => false)
  useEffect(() => { setNow(Date.now()) }, [statsAt, ciAt, prs])

  // A clock only while a job runs, the tab in front and the window shown.
  const running = ciActive(ci?.ci)
  useEffect(() => {
    if (!running || !visible) return
    const t = window.setInterval(() => { if (!document.hidden) setNow(Date.now()) }, 1000)
    return () => window.clearInterval(t)
  }, [running, visible])

  const row = rows.find((r) => r.number === pick)
  const runs: CIRun[] = useMemo(() => ci?.ci?.runs ?? [], [ci?.ci?.runs])
  // The chosen pull request as the deck's rows carry it, so the deck's words and actions apply.
  const p: SessionPRLive | undefined = row ? {
    ...(row.mine ?? { session_id: sessionId, url: row.url, number: row.number, title: row.title, last_at: 0 }),
    live: ci?.pr?.live ?? row.mine?.live,
  } : undefined

  const why = !canControl ? 'This device may only watch: queue it from the Mac, or make this device a controller in Settings.'
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

  return (
    <div data-prs-tab onKeyDown={(e) => { if (e.key === 'Escape' && kit.confirm) { kit.setConfirm(undefined); e.preventDefault() } }}
      className="app-scroll @container/prs flex h-full min-h-0 flex-col gap-3 overflow-y-auto bg-bg p-4">
      <header className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="shrink-0 text-[15px] font-semibold">Pull requests &amp; CI</h1>
        {stats?.repo && <span className="mono truncate text-[12px] text-fg-muted">{stats.repo}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[11.5px]">
          <Freshness at={stats?.fetched_at || statsAt || undefined} loading={statsMeta.loading} failed={statsMeta.failed} />
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
      ) : <ViewSwitch view={view} onView={setView} />}

      {boardOn ? (
        board ? <PRBoardView board={board} prs={stats?.prs ?? []} now={now} onOpen={openFromBoard} />
          : !stats ? <DeckSkeleton label="Reading the pull requests" />
            : stats.error ? <p className="truncate text-[12px] text-warn" title={stats.error.message}>Not read: {stats.error.message}</p>
              : <p className="text-[12.5px] text-fg-muted">The board comes with a newer Caprock daemon: restart it after the update. The List view works meanwhile.</p>
      ) : (
        <>
          {stats?.reason || stats?.connected === false ? null : stats?.stats ? <StatsStrip st={stats.stats} usage={usageLine(usage)} />
            : !stats ? <DeckSkeleton label="Reading the figures" /> : stats.error ? <p className="truncate text-[12px] text-warn" title={stats.error.message}>Not read: {stats.error.message}</p> : null}
          <div className="grid min-h-[420px] flex-1 grid-cols-[minmax(280px,0.8fr)_minmax(0,1.4fr)] gap-3 @max-[760px]/prs:grid-cols-1">
            <PRList rows={rows} scope={scope} onScope={setScope} pick={pick} onPick={setChosen} now={now} counts={{ session: sessionPRs.length, repo: tabRows('repo', sessionPRs, stats?.prs ?? []).length, open: tabRows('open', sessionPRs, stats?.prs ?? []).length }} loaded={!!prs || !!stats} />
            <section data-prs-detail aria-label="The chosen pull request" className="app-scroll min-h-0 min-w-0 overflow-y-auto rounded-[var(--radius-panel)] border border-border bg-panel shadow-[var(--shadow-panel)]">
              {p ? (
                <Detail p={p} row={row!} ci={ci} runs={runs} now={now} sessionId={sessionId} kit={kit} connected={connected}
                  why={why} onInvestigated={(t) => onToast?.(t)} sessionName={sessionTitle(s)} onConnect={() => void connect()} />
              ) : (
                <p className="p-4 text-[13px] text-fg-muted">{rows.length === 0 && (prs || stats) ? 'No pull requests here.' : 'Pick a pull request.'}</p>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- the view switch

const VIEW_LABEL: Record<TabView, string> = { board: 'Board', list: 'List' }
const VIEW_TITLE: Record<TabView, string> = {
  board: 'The pull requests by stage — draft, CI running, needing a fix, ready, merged, released — with the agents on each and what they cost, and the releases',
  list: 'The figures over two weeks, and one pull request in detail: its checks, jobs and logs',
}

function ViewSwitch({ view, onView }: { view: TabView; onView: (v: TabView) => void }) {
  return (
    <div role="tablist" aria-label="View" data-prs-view={view} className="flex w-fit shrink-0 items-center gap-0.5 rounded-[7px] border border-[var(--app-hairline)] bg-panel-2/60 p-0.5 text-[12px]">
      {(['board', 'list'] as TabView[]).map((v) => (
        <button key={v} type="button" role="tab" aria-selected={view === v} data-prs-view-tab={v} onClick={() => onView(v)} title={VIEW_TITLE[v]}
          className={`rounded-[5px] px-2.5 py-[3px] ${view === v ? 'bg-[var(--app-row-active)] font-medium text-fg' : 'text-fg-muted hover:text-fg'}`}>
          {VIEW_LABEL[v]}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- the figures

function Stat({ label, value, note, title, children }: { label: string; value: ReactNode; note: ReactNode; title?: string; children?: ReactNode }) {
  return (
    <div data-prs-stat={label} title={title} className="flex min-w-0 flex-col gap-1">
      <div className="truncate text-[10.5px] uppercase tracking-[0.12em] text-fg-faint">{label}</div>
      <div className="flex items-end justify-between gap-2">
        <div className="num truncate text-[22px] font-semibold leading-none text-fg">{value}</div>
        {children}
      </div>
      <div className="line-clamp-2 text-[11px] leading-[1.35] text-fg-muted">{note}</div>
    </div>
  )
}

function StatsStrip({ st, usage }: { st: NonNullable<SessionCIStats['stats']>; usage?: ReturnType<typeof usageLine> }) {
  const w = statsWords(st)
  const labels = st.days.map((d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
  const days = st.days.length
  const wf = st.ci.workflows[0]
  return (
    <section data-prs-stats aria-label="The repository over two weeks" className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-x-6 gap-y-4 rounded-[var(--radius-panel)] border border-border bg-panel px-4 py-3 shadow-[var(--shadow-panel)]">
      <Stat label={`Merged · ${days} days`} value={w.merged.total} note={`${w.merged.last7} in the last 7 · ${w.merged.today} today`}
        title={`Pull requests merged each day, from GitHub's stamps, counted from the repository's ${st.prs_listed} most recently updated pull requests`}>
        <Bars values={st.merged} labels={labels} unit="merged" />
      </Stat>
      <Stat label="Time to merge" value={w.ttm?.text ?? '–'} note={w.ttmNote} title={w.ttm?.title} />
      {w.ci && wf ? (
        <Stat label={`CI time · ${w.ci.name}`} value={w.ci.text} note={w.ci.note} title={`The median wall-clock time of the ${wf.name} workflow's successful runs, start to finish, from GitHub's run times; the line is the same median per day`}>
          <Trend values={wf.daily_median_ms} labels={labels} />
        </Stat>
      ) : <Stat label="CI time" value="–" note="fewer than two successful runs" />}
      {w.red ? (
        <Stat label="Red runs" value={w.red.text} note={w.red.note} title={w.red.title}>
          <Bars values={st.ci.per_day.map((d) => d.runs)} red={st.ci.per_day.map((d) => d.red)} labels={labels} unit="runs" />
        </Stat>
      ) : <Stat label="Red runs" value="–" note={`no finished runs in ${days} days`} />}
      {usage && (
        usage.kind === 'available'
          ? <Stat label="Actions this month" value={usage.text.replace(/^Actions this month: /, '').split(' · ')[0]} note={`${usage.text.split(' · ')[1] ?? ''} billed, GitHub’s report`} title={usage.title} />
          : <Stat label="Actions this month" value="–" note={usage.text} title={usage.title} />
      )}
    </section>
  )
}

// ---------------------------------------------------------------- the list

function PRList({ rows, scope, onScope, pick, onPick, now, counts, loaded }: { rows: TabPR[]; scope: TabScope; onScope: (s: TabScope) => void; pick: number; onPick: (n: number) => void; now: number; counts: Record<TabScope, number>; loaded: boolean }) {
  return (
    <section data-prs-list aria-label="Pull requests" className="flex min-h-0 min-w-0 flex-col rounded-[var(--radius-panel)] border border-border bg-panel shadow-[var(--shadow-panel)]">
      <div role="tablist" aria-label="Which pull requests" className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border bg-panel-2/60 px-2 py-1.5 text-[11.5px]">
        {(['session', 'repo', 'open'] as TabScope[]).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={scope === k} data-prs-scope={k} onClick={() => onScope(k)}
            className={`whitespace-nowrap rounded-[5px] px-2 py-[2px] ${scope === k ? 'bg-[var(--app-row-active)] text-fg' : 'text-fg-muted hover:text-fg'}`}>
            {SCOPE_LABEL[k]} <span className="num text-fg-faint">{counts[k]}</span>
          </button>
        ))}
      </div>
      {!loaded ? <div className="p-2"><DeckSkeleton label="Reading the pull requests" /></div> : rows.length === 0 ? (
        <p className="p-3 text-[12px] text-fg-faint">{scope === 'session' ? 'No PR from this session yet.' : scope === 'open' ? 'Nothing open.' : 'No pull requests read.'}</p>
      ) : (
        <ul className="app-scroll min-h-0 flex-1 overflow-y-auto">
          {rows.map((r) => <PRItem key={r.number} r={r} on={r.number === pick} onPick={() => onPick(r.number)} now={now} />)}
        </ul>
      )}
    </section>
  )
}

function PRItem({ r, on, onPick, now }: { r: TabPR; on: boolean; onPick: () => void; now: number }) {
  const at = r.merged_at ?? r.created_at
  const v = r.mine?.live ? prVerdict(r.mine, now) : undefined
  return (
    <li data-prs-row={r.number}>
      <button type="button" onClick={onPick} aria-current={on || undefined}
        className={`block w-full border-b border-[var(--app-hairline)] px-3 py-2 text-left hover:bg-[var(--app-row-hover)] ${on ? 'bg-[var(--app-row-active)] shadow-[inset_2px_0_0_var(--color-accent)]' : ''}`}>
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden className="pr-dot" data-state={r.draft && r.state === 'open' ? 'draft' : r.state} />
          <span className="num shrink-0 text-[12px] text-fg-muted">#{r.number}</span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{r.title}</span>
          {at ? <span className="num shrink-0 text-[11px] text-fg-faint" title={new Date(at).toLocaleString()}>{spanText(Math.max(0, now - at))}</span> : null}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-2 pl-[18px] text-[11.5px]">
          {v ? <span className={`min-w-0 truncate ${v.tone === 'fail' ? 'text-danger' : v.tone === 'pending' ? 'text-warn' : v.tone === 'ok' ? 'text-ok' : 'text-fg-muted'}`} title={v.title}>{v.text}</span>
            : <span className="min-w-0 truncate text-fg-faint">{r.state === 'merged' && r.merged_at && r.created_at ? `merged in ${spanText(r.merged_at - r.created_at)}` : r.state}</span>}
          {r.mine && <span className="ml-auto shrink-0 text-[11px] text-accent">this session</span>}
        </span>
      </button>
    </li>
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

