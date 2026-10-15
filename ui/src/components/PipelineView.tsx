/**
 * The Pipeline (.ai/04-ui.md § Pipeline): one repository's pull requests on
 * their way to a release, a page of the dashboard (screens/Pipeline.tsx, at
 * #/pipeline) since 2026-10-15 — it was a tab of its own, and read badly
 * (owner, translated: "everything reads very, very badly … Pipeline is part
 * of the Dashboard, just a separate page"). So it is drawn as the dashboard
 * draws: the figures as Stat tiles in a panel, the list and the releases as
 * panels, captions and secondary text at the dashboard's sizes and contrast.
 *
 * One list (owner, 2026-10-14, translated: "PR titles are missing … I'd
 * merge it all into one — PR rows with their statuses, so I understand how
 * things travel, what gets released"): the figures on top, then every pull
 * request as a row — its number, its whole title, its labels, its four steps
 * Open → CI → Merged → Released (lib/journey, the cockpit draws the same),
 * how long in the step, its agent cost — in flight first, then merged, then
 * released (ten, then "Show more"), and the releases below. A row opens the
 * pull request in detail beside the list (under it on a narrow window):
 * state, review, merge state and diff, the deck's actions, its jobs by runner
 * OS against each one's median, the jobs on the run's clock, a job's steps
 * and the end of a failed one's log.
 *
 * Asked only while the page is in front and the window visible (usePoll),
 * through the deck's own routes and kept answers (lib/deckCache), so opening
 * it shows what was last known at once.
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
import { FlowFigures, Releases } from './PRBoard'
import { JourneyPills } from './Journey'
import { GitHubPerson } from './GitHubAvatar'
import { Panel } from './ui'
import { CI_IDLE_MS, CI_RUNNING_MS, CIMark, DeckSkeleton, ExpandToggle, Freshness, PRS_PENDING_MS, connectGitHub, usePoll } from './SessionDeck'

export interface PipelineViewProps {
  /** The agent session the page reads through: its repository, its pull requests. */
  sessionId: string
  session?: SessionSummary
  /** The page is in front: only then is anything asked. */
  visible: boolean
  /** Back to where ⇧⌘B was pressed (the app); absent, no Back. */
  onBack?: () => void
  onToast?: (text: string) => void
  worktrees?: DeckWorktree[]
  onStartAgent?: (req: SpawnRequest, title: string) => Promise<void>
  /** The repository picker, at the head of the page (screens/Pipeline.tsx). */
  picker?: ReactNode
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
export const keepStats = (prev: SessionCIStats, next: SessionCIStats) => !!next.error && (next.prs?.length ?? 0) === 0 && (prev.prs?.length ?? 0) > 0

/** The kept answer's key: per repository, so every session in it shares one. */
export function statsKey(s: Pick<SessionSummary, 'repo_root' | 'cwd'> | undefined, sessionId: string): string {
  return `stats:${s?.repo_root || s?.cwd || sessionId}`
}

/** The Pipeline's one answer — the repository's pull requests and figures — read while `on`. Home's card asks through the same. */
export function usePipelineStats(sessionId: string, s: SessionSummary | undefined, on: boolean, n = 0) {
  return usePoll<SessionCIStats>(on && !!sessionId, `${sessionId}:${n}`, () => api.sessionCIStats(sessionId), () => false, CI_IDLE_MS, sessionId ? statsKey(s, sessionId) : undefined, keepStats)
}

export function PipelineView(props: PipelineViewProps) {
  const { session, onBack, picker } = props
  if (!session) {
    return (
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-3">{picker}{onBack && <span className="ml-auto"><BackButton onBack={onBack} /></span>}</div>
        <p className="text-[13px] text-fg-muted">The session this page was opened from is no longer listed.</p>
      </div>
    )
  }
  return <ViewBody {...props} session={session} />
}

function BackButton({ onBack }: { onBack: () => void }) {
  return <ExpandToggle collapse onClick={onBack} />
}

function ViewBody({ sessionId, session: s, visible, onBack, onToast, worktrees, onStartAgent, picker }: PipelineViewProps & { session: SessionSummary }) {
  const canControl = useCanControl()
  const [scope, setScopeState] = useState<TabScope>(readScope)
  const setScope = (v: TabScope) => { setScopeState(v); try { localStorage.setItem(SCOPE_KEY, v) } catch { /* this page only */ } }
  const [n, setN] = useState(0)
  // The pull request opened beside the list; none until a row is clicked.
  const [chosen, setChosen] = useState<number>()
  const [now, setNow] = useState(() => Date.now())
  const [connecting, setConnecting] = useState(false)

  const [stats, statsAt, statsMeta] = usePipelineStats(sessionId, s, visible, n)
  const [prs] = usePoll<SessionPRs>(visible, `${sessionId}:${n}`, () => api.sessionPRs(sessionId), (d) => d.prs.some((p) => p.live?.checks.state === 'pending'), PRS_PENDING_MS, `prs:${sessionId}`)
  const sessionPRs = useMemo(() => prs?.prs ?? [], [prs])
  const board = useMemo(() => asBoard(stats?.board), [stats?.board])
  const rows = useMemo(() => pipelineRows(tabRows(scope, sessionPRs, stats?.prs ?? []), board, stats?.prs ?? []), [scope, sessionPRs, stats?.prs, board])
  const pick = chosen ?? 0
  // Another repository picked: what was open over the old one closes.
  useEffect(() => { setChosen(undefined) }, [sessionId])
  // The detail takes the focus as it opens, so Esc closes it whatever was
  // clicked; under the list (a narrow window) that also brings it into view.
  const detailRef = useRef<HTMLElement>(null)
  useEffect(() => { if (chosen) detailRef.current?.focus() }, [chosen])
  // What the head says of it: the time GitHub was last read (an answer
  // composed from an older read says so), and why a read failed: a list
  // GitHub refused comes with the one read before, and what did not fit the
  // daemon's GitHub budget is said in `error` too.
  const statsShownAt = stats?.read_at || stats?.fetched_at || statsAt || undefined
  const statsFailed = statsMeta.failed || (!!stats?.error && !statsMeta.loading)
  const statsReason = statsMeta.reason ?? stats?.error?.message
  // Rows not yet re-confirmed — the copy kept from before, an answer that
  // could not be refreshed — are drawn faint until a fresh one lands.
  const unconfirmed = !statsMeta.confirmed || statsFailed
  // The chosen pull request's CI is read only while it is open.
  const [ciData, ciAt] = usePoll<SessionCI>(visible && pick > 0, `${sessionId}:${pick}:${n}`, () => api.sessionCI(sessionId, pick), (d) => ciActive(d.ci), CI_RUNNING_MS, pick > 0 ? `ci:${sessionId}:${pick}` : undefined)
  const ci = ciData?.pr?.number === pick ? ciData : undefined
  const connected = stats?.connected ?? prs?.connected
  useEffect(() => { setNow(Date.now()) }, [statsAt, ciAt, prs])

  // A clock only while a job runs, the page in front and the window shown.
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
      className="@container/pipe grid min-w-0 gap-3">
      <div data-prs-head className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        {picker}
        <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1 text-[12px] text-fg-muted">
          <Freshness at={statsShownAt} loading={statsMeta.loading} failed={statsFailed} reason={statsReason} confirmed={statsMeta.confirmed} onRetry={statsMeta.retry} />
          {onBack && <BackButton onBack={onBack} />}
        </span>
      </div>
      {stats?.reason ? (
        <p className="rounded-[var(--radius-panel)] border border-border bg-panel px-3 py-3 text-[13px] text-fg-muted">{stats.reason === 'not_github' ? 'This repository is not on GitHub.' : 'This folder is not a git repository with a remote.'}</p>
      ) : stats && !stats.connected ? (
        <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-panel)] border border-border bg-panel px-3 py-3 text-[13px]">
          <span className="text-fg-muted">The figures, the repository’s pull requests and their CI are read from GitHub.</span>
          <button type="button" data-prs-connect disabled={connecting} onClick={() => void connect()} title="Reads GitHub through your GitHub CLI login; turn it off in Settings → GitHub"
            className="font-medium text-accent hover:underline disabled:opacity-60">{connecting ? 'connecting…' : 'Connect GitHub'}</button>
        </div>
      ) : null}
      {ready && (
        <Panel title={stats?.repo ? <>Flow · <span className="mono normal-case tracking-normal text-fg">{stats.repo}</span></> : 'Flow'}
          right={<span title="Read from GitHub: the newest pull requests listed, the runs of the last 14 days">GitHub · last {board?.flow.days ?? 14} days</span>}>
          {board ? <FlowFigures board={board} />
            : !stats ? <div className="px-3 py-2"><DeckSkeleton label="Reading the figures" /></div>
              : stats.error && (stats.prs?.length ?? 0) === 0 ? <p className="truncate px-3 py-3 text-[13px] text-warn" title={stats.error.message}>Not read: {stats.error.message}</p>
                : <p className="px-3 py-3 text-[13px] text-fg-muted">No figures yet.</p>}
        </Panel>
      )}
      {ready && (
        <div className={`grid min-w-0 items-start gap-3 ${p && row ? '@min-[1100px]/pipe:grid-cols-[minmax(0,1fr)_minmax(440px,600px)]' : ''}`}>
          <PipelineList rows={rows} scope={scope} onScope={setScope} pick={pick} onPick={(num) => setChosen(num === pick ? undefined : num)} now={now}
            counts={counts} loaded={!!prs || !!stats} dim={unconfirmed} />
          {/* The chosen pull request beside the list, held in view as the
            * list scrolls; under it on a narrow window. Esc or × closes it. */}
          {p && row && (
            <section data-prs-detail role="dialog" aria-label={`#${row.number} in detail`} ref={detailRef} tabIndex={-1}
              className="app-scroll min-w-0 rounded-[var(--radius-panel)] border border-border bg-panel shadow-[var(--shadow-panel)] outline-none @min-[1100px]/pipe:sticky @min-[1100px]/pipe:top-14 @min-[1100px]/pipe:max-h-[calc(100dvh-140px)] @min-[1100px]/pipe:overflow-y-auto">
              <header className="sticky top-0 z-10 flex items-center justify-between gap-3 rounded-t-[var(--radius-panel)] border-b border-border bg-panel-2 px-3 py-2">
                <h2 className="text-[11px] font-medium uppercase tracking-[0.12em] text-fg-muted">Pull request #{row.number}</h2>
                <button type="button" data-prs-detail-close onClick={() => setChosen(undefined)} title={`Close (${keys('Esc')})`} aria-label="Close the pull request’s detail"
                  className="rounded-[5px] px-2 text-[16px] leading-[22px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">×</button>
              </header>
              <Detail p={p} row={row} ci={ci} runs={runs} now={now} sessionId={sessionId} kit={kit} connected={connected}
                why={why} onInvestigated={(t) => onToast?.(t)} sessionName={sessionTitle(s)} onConnect={() => void connect()} />
            </section>
          )}
        </div>
      )}
      {ready && board && board.releases.length > 0 && <Releases releases={board.releases} prs={stats?.prs ?? []} now={now} onOpen={(num) => setChosen(num)} />}
    </div>
  )
}

// ---------------------------------------------------------------- the list

/** How many released rows show before "Show more". */
const RELEASED_SHOWN = 10

/** The list's columns: the pull request, its journey, the time in its step, its agent cost. */
const ROW_GRID = 'grid grid-cols-[minmax(0,1fr)_auto_64px_88px] items-center gap-x-4 @max-[820px]/list:grid-cols-[minmax(0,1fr)_auto]'

function PipelineList({ rows, scope, onScope, pick, onPick, now, counts, loaded, dim }: { rows: PipelineRow[]; scope: TabScope; onScope: (s: TabScope) => void; pick: number; onPick: (n: number) => void; now: number; counts: Record<TabScope, number>; loaded: boolean; dim: boolean }) {
  const [allReleased, setAllReleased] = useState(false)
  const released = rows.filter((r) => stageOf(r) === 'released')
  const hidden = allReleased ? 0 : Math.max(0, released.length - RELEASED_SHOWN)
  const keep = new Set(released.slice(0, allReleased ? released.length : RELEASED_SHOWN).map((r) => r.number))
  const shown = rows.filter((r) => stageOf(r) !== 'released' || keep.has(r.number))
  return (
    <Panel title="Pull requests" right={
      // The same control as Home's agent filter: a filled pill for the one shown.
      <span role="tablist" aria-label="Which pull requests" className="inline-flex flex-wrap items-center gap-0.5 rounded-md bg-panel-2 p-0.5">
        {(['session', 'repo', 'open'] as TabScope[]).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={scope === k} data-prs-scope={k} onClick={() => onScope(k)}
            className={`whitespace-nowrap rounded-[5px] px-2.5 py-1 text-[12px] transition-colors motion-reduce:transition-none ${scope === k ? 'bg-accent font-medium text-panel' : 'text-fg hover:text-accent'}`}>
            {SCOPE_LABEL[k]} <span className={`num ${scope === k ? '' : 'text-fg-muted'}`}>{counts[k]}</span>
          </button>
        ))}
      </span>
    }>
      <section data-prs-list aria-label="Pull requests" className="@container/list min-w-0">
        {!loaded ? <div className="p-3"><DeckSkeleton label="Reading the pull requests" /></div> : rows.length === 0 ? (
          <p className="px-3 py-3 text-[13px] text-fg-muted">{scope === 'session' ? 'No pull request from this session yet.' : scope === 'open' ? 'Nothing open.' : 'No pull requests read.'}</p>
        ) : (
          <>
            <div aria-hidden className={`${ROW_GRID} border-b border-border px-3 py-1.5 text-[10.5px] uppercase tracking-[0.12em] text-fg-muted @max-[820px]/list:hidden`}>
              <span>Pull request</span>
              <span className="whitespace-nowrap">Open → CI → Merged → Released</span>
              <span className="text-right">In step</span>
              <span className="whitespace-nowrap text-right" title={AGENT_COST_NOTE}>Agent cost</span>
            </div>
            <ul>
              {shown.map((r) => <PipelineItem key={r.number} r={r} on={r.number === pick} onPick={() => onPick(r.number)} now={now} dim={dim || !!r.card?.stale} />)}
              {hidden > 0 && (
                <li><button type="button" data-prs-more onClick={() => setAllReleased(true)} className="w-full px-3 py-2.5 text-left text-[13px] text-accent hover:bg-[var(--app-row-hover)]">Show {hidden} more released</button></li>
              )}
            </ul>
          </>
        )}
      </section>
    </Panel>
  )
}

/** One pull request: number, its whole title, labels, the four steps, the time in its step, agent cost. */
function PipelineItem({ r, on, onPick, now, dim }: { r: PipelineRow; on: boolean; onPick: () => void; now: number; dim: boolean }) {
  const steps = journey(r)
  const at = r.card?.stage_at ?? r.merged_at ?? r.created_at
  const cost = r.card ? costText(r.card.spend) : ''
  return (
    <li data-prs-row={r.number} data-stage={stageOf(r)} data-prs-unconfirmed={dim ? '' : undefined} className="border-b border-border last:border-b-0">
      <button type="button" onClick={onPick} aria-current={on || undefined}
        title={dim ? 'Not re-confirmed: from an earlier read of GitHub' : undefined}
        className={`${ROW_GRID} w-full gap-y-2 px-3 py-2.5 text-left transition-colors hover:bg-[var(--app-row-hover)] motion-reduce:transition-none ${on ? 'bg-[var(--app-row-active)] shadow-[inset_3px_0_0_var(--color-accent)]' : ''} ${dim ? 'opacity-60' : ''}`}>
        <span className="flex min-w-0 items-baseline gap-2 @max-[820px]/list:col-span-2">
          <span className="num shrink-0 text-[13px] text-fg-muted">#{r.number}</span>
          <span className="min-w-0 flex-1">
            <span data-prs-title className="block text-[14px] font-medium leading-[1.35] text-fg [overflow-wrap:anywhere]">{r.title}</span>
            {(r.labels?.length || r.author || r.mine) && (
              <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[12px] text-fg-muted">
                {r.labels?.map((l) => <LabelChip key={l.name} name={l.name} color={l.color} />)}
                {r.author && <GitHubPerson login={r.author} url={r.author_avatar} size={15} className="min-w-0" />}
                {r.mine && <span className="font-medium text-accent">this session</span>}
              </span>
            )}
          </span>
        </span>
        <JourneyPills steps={steps} />
        <span className="num text-right text-[12.5px] text-fg-muted @max-[820px]/list:hidden" title={at ? new Date(at).toLocaleString() : undefined}>{at ? spanText(Math.max(0, now - at)) : '–'}</span>
        <span className="num text-right text-[13px] font-medium text-fg" title={r.card ? costTitle(r.card.spend) : undefined}>
          {cost || <span className="font-normal text-fg-muted">–</span>}
          {r.card && r.card.spend.live > 0 && <span className="ml-1 text-ok" title={`${r.card.spend.live} agent session${r.card.spend.live === 1 ? '' : 's'} running on it now`}>●</span>}
        </span>
      </button>
    </li>
  )
}

/** A GitHub label: its colour as a dot, its name. */
function LabelChip({ name, color }: { name: string; color?: string }) {
  const c = color && /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : 'var(--color-fg-faint)'
  return (
    <span data-prs-label={name} className="inline-flex h-[20px] max-w-[200px] items-center gap-1.5 rounded-full border border-border-strong px-2 text-[11.5px] text-fg">
      <span aria-hidden className="h-[8px] w-[8px] shrink-0 rounded-full" style={{ background: c }} />
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
        <div className="flex min-w-0 items-start gap-2">
          <Pill tone={state === 'merged' ? 'merged' : state === 'open' ? (live?.draft ? 'muted' : 'ok') : 'faint'} data="state">{live?.draft && state === 'open' ? 'Draft' : state[0]!.toUpperCase() + state.slice(1)}</Pill>
          <span className="num shrink-0 text-[13px] text-fg-muted">#{p.number}</span>
          <h3 className="min-w-0 flex-1 text-[15px] font-semibold leading-snug [overflow-wrap:anywhere]">{live?.title ?? row.title}</h3>
          <button type="button" onClick={() => openExternal(live?.url || row.url)} className="ml-auto shrink-0 text-[12px] text-accent hover:underline">GitHub ↗</button>
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
              <span className="text-fg-muted"> · {live.changed_files} files · {live.commits} commits</span>
            </span>
          )}
          <span className="text-[12px] text-fg-muted">
            {created ? `opened ${spanText(Math.max(0, now - created))} ago` : ''}{merged && created ? ` · merged in ${spanText(merged - created)}` : ''}
          </span>
        </div>
        <Actions p={p} kit={kit} connected={connected} onConnect={onConnect} />
      </div>
      {connected === false ? null : !ci ? (
        <div className="border-t border-border px-4 py-3"><DeckSkeleton label="Reading the CI" /></div>
      ) : !ci.ci ? (
        <p className="border-t border-border px-4 py-3 text-[12px] text-fg-muted">{ci.error ? `CI not read: ${ci.error.message}` : `#${p.number}: no commit to read CI for.`}</p>
      ) : jobs.length === 0 ? (
        <p className="border-t border-border px-4 py-3 text-[12px] text-fg-muted">No GitHub Actions runs on #{p.number}’s head commit.</p>
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
        {right && <span className="min-w-0 text-[12px] text-fg-muted">{right}</span>}
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
      {g.oses.map((o) => <span key={o} className="px-2 text-[10.5px] uppercase tracking-[0.12em] text-fg-muted">{GRID_OS_LABEL[o]}</span>)}
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
  if (shown.length === 0) return <p className="text-[12px] text-fg-muted">No job has started yet.</p>
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
            <span className="num w-[52px] shrink-0 text-right text-[11px] text-fg-muted">{fmtRun(to - j.started_at!)}</span>
          </div>
        )
      })}
      <span className="num mt-1 text-right text-[10.5px] text-fg-muted">{fmtRun(span)} from the first job’s start</span>
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
            {st.duration_ms !== undefined && <span className="num shrink-0 text-fg-muted">{fmtRun(st.duration_ms)}</span>}
          </li>
        ))}
      </ol>
      {tone === 'fail' && (
        <div className="mt-2 flex flex-col gap-2">
          {!log ? <p className="text-[11.5px] text-fg-muted">Reading the end of the log…</p> : 'error' in log ? <p className="text-[11.5px] text-warn">Log not read: {log.error}</p> : (
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

