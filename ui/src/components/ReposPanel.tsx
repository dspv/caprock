/**
 * The Now screen's Repos section (.ai/04-ui.md § Repos on Now): a row per
 * listed repository with a session in it — its commits per day over 14
 * days, today's and the week's, the lines added and removed, what is not
 * committed — from the repository's own git, and, while GitHub is connected,
 * the open pull requests, red runs, median CI time and the newest release
 * from what the session deck and the PRs & CI tab already read. The daemon
 * asks GitHub nothing for this section, and git at most every 10 minutes a
 * repository.
 *
 * Folded, nothing is asked: the body (and its poll) is mounted only while the
 * panel is open, and the poll pauses while the window is hidden.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, type RepoActivity, type ReposActivity } from '@/lib/api'
import { readDeck, writeDeck } from '@/lib/deckCache'
import { fmtAgo, fmtTokens } from '@/lib/format'
import { fmtRun } from '@/lib/ci'
import { href } from '@/lib/router'
import { Panel } from './ui'
import { Bars } from './DayBars'

/** How often the open section asks the daemon (its git answers are kept 10 minutes). */
const REPOS_POLL_MS = 60_000
const CACHE_KEY = 'repos:now'

export function ReposPanel() {
  return (
    <Panel fold="now.repos" title="Repos" right={<span title="Local git, counted at most every 10 minutes; GitHub from what the deck and the PRs & CI tab already read">local git · GitHub as the deck read it</span>}>
      <ReposBody />
    </Panel>
  )
}

/** The poll: while mounted (the panel open) and the window visible. */
/**
 * The answer as the table reads it: a missing or odd answer (an older
 * daemon, a cache written by another build) is no rows, never a crash of the
 * Now screen; a row without its arrays has no figures for them.
 */
export function asRepos(v: unknown): ReposActivity {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<ReposActivity>
  const rows = Array.isArray(o.repos) ? o.repos : []
  const arr = (a: unknown) => (Array.isArray(a) ? (a as number[]) : [])
  return {
    github_connected: o.github_connected === true,
    repos: rows.filter((r) => r && typeof r === 'object').map((r) => ({
      ...r, days: arr(r.days) as unknown as string[], commits: arr(r.commits), added: arr(r.added), deleted: arr(r.deleted),
      name: typeof r.name === 'string' ? r.name : '', dirty: Number(r.dirty) || 0, sessions: Number(r.sessions) || 0,
    })),
  }
}

function useRepos(): { data?: ReposActivity; failed: boolean } {
  const [data, setData] = useState<ReposActivity | undefined>(() => {
    const c = readDeck<unknown>(CACHE_KEY)?.d
    return c === undefined ? undefined : asRepos(c)
  })
  const [failed, setFailed] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    let timer = 0
    const tick = async () => {
      if (document.hidden) return
      try {
        const d = asRepos(await api.reposActivity())
        if (!alive.current) return
        setData(d)
        setFailed(false)
        writeDeck(CACHE_KEY, d)
      } catch {
        if (alive.current) setFailed(true)
      }
      if (alive.current && !document.hidden) timer = window.setTimeout(() => void tick(), REPOS_POLL_MS)
    }
    void tick()
    const onVisible = () => { if (!document.hidden) { window.clearTimeout(timer); void tick() } }
    document.addEventListener('visibilitychange', onVisible)
    return () => { alive.current = false; window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [])
  return { data, failed }
}

const sum = (a: number[], from = 0) => a.slice(from).reduce((s, x) => s + x, 0)

// The table's columns, and the fewer it keeps in a narrow panel.
const COLS = 'grid-cols-[minmax(160px,1.3fr)_150px_52px_60px_110px_minmax(96px,0.7fr)_minmax(120px,0.8fr)_minmax(90px,0.6fr)] @max-[980px]/repos:grid-cols-[minmax(140px,1fr)_52px_60px_minmax(90px,0.7fr)_minmax(110px,0.8fr)_minmax(80px,0.6fr)] @max-[600px]/repos:grid-cols-[minmax(0,1fr)_52px_60px] @max-[340px]/repos:grid-cols-[minmax(0,1fr)_36px_40px] @max-[340px]/repos:gap-x-2'
const WIDE = '@max-[980px]/repos:hidden'
const GH = '@max-[600px]/repos:hidden'

function ReposBody() {
  const { data, failed } = useRepos()
  const now = Date.now()
  if (!data) {
    return <p className="px-3 py-3 text-[12.5px] text-fg-muted">{failed ? 'Could not read the repositories.' : 'Reading the repositories…'}</p>
  }
  if (data.repos.length === 0) {
    return <p className="px-3 py-3 text-[12.5px] text-fg-muted">No listed repository has a session running.</p>
  }
  const H = ({ children, r, cls = '' }: { children: ReactNode; r?: boolean; cls?: string }) => <span className={`${r ? 'text-right' : ''} ${cls}`}>{children}</span>
  return (
    <div className="@container/repos" data-repos-panel>
      <div className={`grid ${COLS} items-end gap-x-4 border-b border-border px-3 pb-1.5 pt-2 text-[10.5px] uppercase tracking-[0.12em] text-fg-faint`}>
        <H>Repository</H>
        <H cls={WIDE}>Commits a day · 14d</H>
        <H r>Today</H>
        <H r>7 days</H>
        <H r cls={WIDE}>Lines · 7d</H>
        <H r cls={GH}>PRs open</H>
        <H r cls={GH}>CI red · median</H>
        <H r cls={GH}>Release</H>
      </div>
      {data.repos.map((r) => <Row key={r.project_id} r={r} connected={data.github_connected} now={now} />)}
    </div>
  )
}

function Row({ r, connected, now }: { r: RepoActivity; connected: boolean; now: number }) {
  const today = r.commits.at(-1) ?? 0
  const week = sum(r.commits, -7)
  return (
    <div data-repo-row={r.name} className={`grid ${COLS} min-h-[52px] items-center gap-x-4 border-b border-border px-3 py-1.5 last:border-b-0`}>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2 text-[13px]">
          <span className="inline-block h-[7px] w-[7px] shrink-0 rounded-full bg-ok" title={`${r.sessions} session${r.sessions === 1 ? '' : 's'} running here`} />
          <span className="truncate font-medium" title={r.root}>{r.name}</span>
        </div>
        <div className="pl-[15px] text-[11px] leading-snug text-fg-faint">
          {r.error ? <span title={r.error}>git could not be read</span> : r.last_commit_at ? `last commit ${fmtAgo(r.last_commit_at, now)}` : 'no commits in 14 days'}
          {r.sessions > 1 ? ` · ${r.sessions} sessions` : ''}
          {r.dirty > 0 && <span className="whitespace-nowrap text-warn" title="Files changed or new, not committed"> · {r.dirty} uncommitted</span>}
        </div>
      </div>
      <div className={WIDE}><Bars values={r.commits} labels={r.days} unit="commits" w={150} h={26} /></div>
      <div className="mono text-right text-[15px] font-semibold tabular-nums">{today}</div>
      <div className="mono text-right text-[15px] font-semibold tabular-nums">{week}</div>
      <div className={`mono text-right text-[12px] tabular-nums ${WIDE}`} title="Lines added and removed in the last 7 days, every branch, merges left out">
        <span className="text-ok">+{fmtTokens(sum(r.added, -7))}</span> <span className="text-danger">−{fmtTokens(sum(r.deleted, -7))}</span>
      </div>
      <GitHubCells r={r} connected={connected} now={now} />
    </div>
  )
}

const NOT_READ = 'Not read yet: open the session deck’s PRs & CI tab for this repository'

function GitHubCells({ r, connected, now }: { r: RepoActivity; connected: boolean; now: number }) {
  if (!connected) {
    return (
      <div data-repo-github="off" className={`col-span-3 text-right text-[11.5px] text-fg-faint ${GH}`}>
        GitHub not connected · <a href={href({ name: 'settings' })} className="text-accent hover:underline">Settings</a>
      </div>
    )
  }
  const g = r.github
  if (!g) return <div data-repo-github="none" className={`col-span-3 text-right text-[11.5px] text-fg-faint ${GH}`}>not on GitHub</div>
  const red = g.ci && g.ci.runs > 0 ? (g.ci.red / g.ci.runs) * 100 : undefined
  return (
    <>
      <div className={`text-right text-[12px] ${GH}`} title={g.pulls ? `From the newest ${g.pulls.listed} pull requests read` : NOT_READ}>
        {g.pulls ? <><span className="mono text-[15px] font-semibold">{g.pulls.open}</span> <span className="text-fg-faint">· {g.pulls.merged_7d} merged</span></> : <span className="text-fg-faint">–</span>}
      </div>
      <div className={`text-right text-[12px] ${GH}`} title={g.ci ? `${g.ci.red} of ${g.ci.runs} runs failed, 14 days${g.ci.workflow ? `; median successful ${g.ci.workflow} run` : ''}` : NOT_READ}>
        {g.ci && red !== undefined ? (
          <>
            <span className={`mono font-semibold ${g.ci.red > 0 ? 'text-danger' : 'text-fg'}`}>{red < 10 && red > 0 ? red.toFixed(1) : Math.round(red)}%</span>
            {g.ci.median_ms ? <span className="mono text-fg-muted"> · {fmtRun(g.ci.median_ms)}</span> : null}
          </>
        ) : <span className="text-fg-faint">–</span>}
      </div>
      <div className={`truncate text-right text-[12px] ${GH}`} title={g.release ? `The newest release run: ${g.release.state}` : 'Not read yet: the session deck’s Release view reads it'}>
        {g.release?.tag ? <><span className={`mono ${g.release.state === 'fail' ? 'text-danger' : ''}`}>{g.release.tag}</span>{g.release.at ? <span className="text-fg-faint"> {fmtAgo(g.release.at, now).replace(' ago', '')}</span> : null}</> : <span className="text-fg-faint">–</span>}
      </div>
    </>
  )
}
