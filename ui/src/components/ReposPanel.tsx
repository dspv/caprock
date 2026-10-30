/**
 * The Now screen's Repos section (.ai/04-ui.md § Repos on Now): a row per
 * listed repository with a session in it — its commits per day over 14
 * days, today's and the week's, the lines added and removed, what is not
 * committed — from the repository's own git, and, while GitHub is connected,
 * the open pull requests, red runs, median CI time and the newest release
 * from what the session deck and the Pipeline page already read. The daemon
 * asks GitHub nothing for this section, and git at most every 10 minutes a
 * repository.
 *
 * Folded, nothing is asked: the body (and its poll) is mounted only while the
 * panel is open, and the poll pauses while the window is hidden.
 *
 * A row opens under itself (owner, 2026-10-16, translated: show a bit more
 * per repository): the branch checked out, the newest CI run, the pull
 * requests, the release, the lines and the folder — only what the answer
 * already carries, and on a phone the figures its columns leave out.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, type RepoActivity, type ReposActivity } from '@/lib/api'
import { readDeck, writeDeck } from '@/lib/deckCache'
import { fmtAgo, fmtTokens } from '@/lib/format'
import { fmtRun } from '@/lib/ci'
import { href } from '@/lib/router'
import { openExternal } from '@/lib/nudges'
import { extProps } from '@/lib/externalLinks'
import { Panel } from './ui'
import { ShareWith } from './PanelShare'
import { mdTable, type Alias, type ShareName } from '@/lib/panelShare'
import { Bars } from './DayBars'
import { ChevronIcon } from './AppIcons'

/** The rows opened, by root, kept per viewer. */
export const REPOS_OPEN_KEY = 'caprock.repos.open'

function loadOpen(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(REPOS_OPEN_KEY) ?? 'null') as unknown
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveOpen(s: ReadonlySet<string>): void {
  try { localStorage.setItem(REPOS_OPEN_KEY, JSON.stringify([...s].sort())) } catch { /* not kept */ }
}

/** How often the open section asks the daemon (its git answers are kept 10 minutes). */
const REPOS_POLL_MS = 60_000
const CACHE_KEY = 'repos:now'

export function ReposPanel() {
  return (
    <Panel fold="now.repos" title="Repos" share="Repos" right={<span title="Local git, counted at most every 10 minutes; GitHub from what the deck and the Pipeline page already read">local git · GitHub as the deck read it</span>}>
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
const COLS = 'grid-cols-[minmax(160px,1.3fr)_150px_52px_60px_110px_minmax(96px,0.7fr)_minmax(120px,0.8fr)_minmax(90px,0.6fr)] @max-[1060px]/repos:grid-cols-[minmax(140px,1fr)_52px_60px_minmax(90px,0.7fr)_minmax(110px,0.8fr)_minmax(80px,0.6fr)] @max-[600px]/repos:grid-cols-[minmax(0,1fr)_52px_60px] @max-[340px]/repos:grid-cols-[minmax(0,1fr)_36px_40px] @max-[340px]/repos:gap-x-2'
const WIDE = '@max-[1060px]/repos:hidden'
const GH = '@max-[600px]/repos:hidden'

function ReposBody() {
  const { data, failed } = useRepos()
  const [open, setOpen] = useState<Set<string>>(() => loadOpen())
  const toggle = useCallback((root: string) => {
    setOpen((cur) => {
      const next = new Set(cur)
      if (next.has(root)) next.delete(root)
      else next.add(root)
      saveOpen(next)
      return next
    })
  }, [])
  const now = Date.now()
  if (!data) {
    return <p className="px-3 py-3 text-[12.5px] text-fg-muted">{failed ? 'Could not read the repositories.' : 'Reading the repositories…'}</p>
  }
  if (data.repos.length === 0) {
    return <p className="px-3 py-3 text-[12.5px] text-fg-muted">No listed repository has a session running.</p>
  }
  // min-w-0 + truncate: a letter-spaced heading wider than its track must
  // not widen the track, or the last column runs out of the panel.
  const H = ({ children, r, cls = '' }: { children: ReactNode; r?: boolean; cls?: string }) => <span className={`min-w-0 truncate ${r ? 'text-right' : ''} ${cls}`}>{children}</span>
  const allOpen = data.repos.every((r) => open.has(r.root))
  const setAll = () => {
    const next = new Set(open)
    for (const r of data.repos) {
      if (allOpen) next.delete(r.root)
      else next.add(r.root)
    }
    saveOpen(next)
    setOpen(next)
  }
  return (
    <div className="@container/repos" data-repos-panel>
      <ShareWith names={() => repoNames(data.repos)} toText={(alias) => reposText(data, alias)} />
      <div className={`grid ${COLS} items-end gap-x-4 border-b border-border px-3 pb-1.5 pt-2 text-[10.5px] uppercase tracking-[0.12em] text-fg-faint`}>
        <span className="flex min-w-0 items-center gap-2">
          <span>Repository</span>
          <button type="button" data-repos-all data-share-skip aria-pressed={allOpen} onClick={setAll}
            title={allOpen ? 'Fold every row back to one line' : 'Open every row: branch, newest CI run, pull requests, release, lines, folder'}
            className="rounded px-1 normal-case tracking-normal text-[11px] text-fg-muted hover:bg-fg/5 hover:text-fg">
            {allOpen ? 'Less' : 'More'}
          </button>
        </span>
        <H cls={WIDE}>Commits a day · 14d</H>
        <H r>Today</H>
        <H r>7 days</H>
        <H r cls={WIDE}>Lines · 7d</H>
        <H r cls={GH}>PRs open</H>
        <H r cls={GH}>CI red · median</H>
        <H r cls={GH}>Release</H>
      </div>
      {data.repos.map((r) => <Row key={r.project_id} r={r} connected={data.github_connected} now={now} open={open.has(r.root)} onToggle={() => toggle(r.root)} />)}
    </div>
  )
}

/** The names a Repos row shows: the repository, its branch, its folder, the newest run's branch. */
export function repoNames(repos: RepoActivity[]): ShareName[] {
  return repos.flatMap((r): ShareName[] => [
    { kind: 'project', value: r.name }, { kind: 'branch', value: r.branch }, { kind: 'folder', value: r.root },
    { kind: 'branch', value: r.github?.ci?.last?.branch },
  ])
}

/** The table as Markdown, the names through `alias`. */
export function reposText(data: ReposActivity, alias: Alias): string {
  const gh = data.github_connected
  const head = ['Repository', 'Today', '7 days', 'Lines · 7d', 'Uncommitted', ...(gh ? ['PRs open', 'CI red · 14d', 'Release'] : [])]
  const rows = data.repos.map((r) => {
    const g = gh ? r.github : undefined
    const red = g?.ci && g.ci.runs > 0 ? `${Math.round((g.ci.red / g.ci.runs) * 100)}%` : '–'
    return [
      alias('project', r.name), r.commits.at(-1) ?? 0, sum(r.commits, -7),
      `+${sum(r.added, -7)} −${sum(r.deleted, -7)}`, r.dirty,
      ...(gh ? [g?.pulls ? g.pulls.open : '–', red, g?.release?.tag || '–'] : []),
    ]
  })
  return `Commits from local git${gh ? '; GitHub as Caprock last read it' : ''}.\n\n${mdTable(head, rows)}`
}

function Row({ r, connected, now, open, onToggle }: { r: RepoActivity; connected: boolean; now: number; open: boolean; onToggle: () => void }) {
  const today = r.commits.at(-1) ?? 0
  const week = sum(r.commits, -7)
  return (
    <div data-repo-row={r.name} data-open={open || undefined} className={`grid ${COLS} min-h-[52px] items-center gap-x-4 border-b border-border px-3 py-1.5 last:border-b-0`}>
      <div className="min-w-0">
        <button type="button" onClick={onToggle} aria-expanded={open} aria-label={`${r.name}: details`}
          title={`${r.root}\n${open ? 'Fold this row' : 'More: branch, newest CI run, pull requests, release, lines'}`}
          className="flex min-w-0 max-w-full items-center gap-1.5 rounded text-left text-[13px] hover:text-fg">
          <span data-share-skip className="contents"><ChevronIcon size={12} className={`shrink-0 text-fg-faint transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} /></span>
          <span className="inline-block h-[7px] w-[7px] shrink-0 rounded-full bg-ok" title={`${r.sessions} session${r.sessions === 1 ? '' : 's'} running here`} />
          <span className="truncate font-medium">{r.name}</span>
        </button>
        <div className="pl-[31px] text-[11px] leading-snug text-fg-faint">
          {r.error ? <span title={r.error}>git could not be read</span> : r.last_commit_at ? `last commit ${fmtAgo(r.last_commit_at, now)}` : 'no commits in 14 days'}
          {r.sessions > 1 ? ` · ${r.sessions} sessions` : ''}
          {r.dirty > 0 && <span className="whitespace-nowrap text-warn" title="Files changed or new, not committed"> · {r.dirty} uncommitted</span>}
        </div>
      </div>
      <div className={WIDE}><Bars values={r.commits} labels={r.days} unit="commits" w={150} h={26} /></div>
      <div className="mono text-right text-[15px] font-semibold tabular-nums">{today}</div>
      <div className="mono text-right text-[15px] font-semibold tabular-nums">{week}</div>
      <div className={`mono text-right text-[12px] tabular-nums ${WIDE}`} title={`Lines added and removed in the last 7 days, every branch, merges left out${r.lines_partial ? `\n${PARTIAL}` : ''}`}>
        <Lines r={r} />
      </div>
      <GitHubCells r={r} connected={connected} now={now} />
      {open && <Details r={r} connected={connected} now={now} />}
    </div>
  )
}

const PARTIAL = 'Some commits’ lines are still being counted; the next read goes on'

function Lines({ r }: { r: RepoActivity }) {
  return (
    <>
      <span className="text-ok">+{fmtTokens(sum(r.added, -7))}</span> <span className="text-danger">−{fmtTokens(sum(r.deleted, -7))}</span>
      {r.lines_partial && <span data-repo-lines-partial className="text-fg-faint"> …</span>}
    </>
  )
}

/** A finished run's word and colour; a run not finished says so. */
function runWord(l: { status: string; conclusion?: string }): { text: string; cls: string } {
  if (l.status !== 'completed') return { text: l.status === 'in_progress' ? 'running' : l.status.replace(/_/g, ' '), cls: 'text-warn' }
  const c = l.conclusion ?? 'done'
  if (c === 'success') return { text: 'passed', cls: 'text-ok' }
  if (c === 'failure' || c === 'timed_out' || c === 'startup_failure') return { text: c === 'failure' ? 'failed' : c.replace(/_/g, ' '), cls: 'text-danger' }
  return { text: c.replace(/_/g, ' '), cls: 'text-fg-muted' }
}

/** The opened row: one wrapping line of labelled facts under the whole row. */
function Details({ r, connected, now }: { r: RepoActivity; connected: boolean; now: number }) {
  const g = connected ? r.github : undefined
  const last = g?.ci?.last
  const word = last && runWord(last)
  const red = g?.ci && g.ci.runs > 0 ? (g.ci.red / g.ci.runs) * 100 : undefined
  const Item = ({ k, children, d, wrap }: { k: string; children: ReactNode; d: string; wrap?: boolean }) => (
    <span data-repo-detail={d} className="inline-flex min-w-0 max-w-full items-baseline gap-1.5">
      <span className="shrink-0 text-[10.5px] uppercase tracking-[0.12em] text-fg-faint">{k}</span>
      <span className={`min-w-0 text-fg ${wrap ? 'break-words' : 'truncate'}`}>{children}</span>
    </span>
  )
  return (
    <div data-repo-details className="col-span-full flex flex-wrap gap-x-5 gap-y-1 pb-1 pl-[31px] pt-1 text-[12px]">
      <Item k="Branch" d="branch">{r.branch ? <span data-share-name="branch" className="mono">{r.branch}</span> : <span className="text-fg-faint">{r.error ? 'not read' : 'detached'}</span>}</Item>
      {connected && (
        <Item k="Last CI" d="ci">
          {last && word ? (
            <button type="button" onClick={() => last.url && openExternal(last.url)} disabled={!last.url} {...extProps(`${last.name}${last.branch ? ` on ${last.branch}` : ''}: ${word.text}`)} className="text-left hover:underline disabled:no-underline">
              <span className={word.cls}>{word.text}</span>
              <span className="text-fg-muted"> · {last.name}{last.branch ? <> on <span data-share-name="branch" className="mono">{last.branch}</span></> : null}{last.at ? ` · ${fmtAgo(last.at, now)}` : ''}</span>
            </button>
          ) : <span className="text-fg-faint" title={NOT_READ}>{g ? 'not read yet' : 'not on GitHub'}</span>}
        </Item>
      )}
      {g && (
        <Item k="Pull requests" d="prs">
          {g.pulls ? <>{g.pulls.open} open <span className="text-fg-muted">· {g.pulls.merged_7d} merged in 7 days</span></> : <span className="text-fg-faint" title={NOT_READ}>not read yet</span>}
        </Item>
      )}
      {g?.ci && red !== undefined && (
        <Item k="CI red · 14d" d="red">
          <span className={g.ci.red > 0 ? 'text-danger' : ''}>{red < 10 && red > 0 ? red.toFixed(1) : Math.round(red)}%</span>
          <span className="text-fg-muted"> of {g.ci.runs} runs{g.ci.median_ms ? ` · median ${fmtRun(g.ci.median_ms)}` : ''}</span>
        </Item>
      )}
      {g?.release?.tag && <Item k="Release" d="release"><span className="mono">{g.release.tag}</span>{g.release.at ? <span className="text-fg-muted"> {fmtAgo(g.release.at, now)}</span> : null}</Item>}
      <Item k="Lines · 7d" d="lines"><span className="mono"><Lines r={r} /></span></Item>
      <Item k="Folder" d="root"><span data-share-name="folder" className="mono text-fg-muted" title={r.root}>{r.root}</span></Item>
      {r.error && <Item k="Git" d="error" wrap><span className="text-warn" title={r.error}>{r.error}</span></Item>}
    </div>
  )
}

const NOT_READ = 'Not read yet: open the session deck’s Pipeline page for this repository'

function GitHubCells({ r, connected, now }: { r: RepoActivity; connected: boolean; now: number }) {
  if (!connected) {
    return (
      <div data-repo-github="off" className={`col-span-3 text-right text-[11.5px] text-fg-faint ${GH}`}>
        GitHub not connected<span data-share-skip> · <a href={href({ name: 'settings' })} className="text-accent hover:underline">Settings</a></span>
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
