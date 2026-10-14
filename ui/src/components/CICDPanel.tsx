/**
 * The Now screen's CI/CD section (.ai/04-ui.md § CI/CD on Now; owner,
 * 2026-10-14, translated: "find a place on the dashboard for CI/CD
 * indicators and metrics — important because it's often costs, time,
 * possible GitHub outages, or something stuck … the core is the release: a
 * team lead wants to understand where the money for tokens goes, how much
 * each PR costs, who pushes there — literally face and name").
 *
 * Per repository (the listed ones on GitHub with a session in the last 14
 * days, those with one running first, then the most recent; at most six):
 * the Actions minutes GitHub billed this month, the CI
 * median and its trend, red runs, runs stuck past their median, the open
 * pull requests, the newest release, the pull requests the agents spent most
 * on this week, and who opened them. GitHub's own status page in the header.
 * Older repositories, and those hidden here by hand, fold into one quiet
 * line and are not read from GitHub until it is opened (owner, 2026-10-14,
 * translated: "why do I see projects from a hundred years ago?").
 *
 * Folded, nothing is asked: the body (and its poll) is mounted only while the
 * panel is open, and the poll pauses while the window is hidden.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { api, errText } from '@/lib/api'
import { readDeck, writeDeck } from '@/lib/deckCache'
import { fmtAgo } from '@/lib/format'
import { fmtRun } from '@/lib/ci'
import { spanText } from '@/lib/prstats'
import { href } from '@/lib/router'
import { openExternal } from '@/lib/nudges'
import { usageLine, type ActionsUsage } from '@/lib/runnercost'
import { AGENT_COST_NOTE } from '@/lib/prboard'
import { asReposCI, keepWhileReading, loadHiddenRepos, owners, prTokens, quietText, redPct, rowErrorText, saveHiddenRepos, sectionErrorText, sharedTitle, statusLine, stuckText, type ReposCI, type RepoCIQuiet, type RepoCIRow } from '@/lib/reposci'
import { Panel } from './ui'
import { Freshness } from './Freshness'
import { MenuBox, MenuItem, type MenuAt } from './RowMenu'
import { EyeOffIcon } from './AppIcons'
import { Bars, Trend } from './DayBars'
import { GitHubAvatar, GitHubPerson } from './GitHubAvatar'

/** How often the open section asks the daemon (its GitHub reads are kept 2 to 30 minutes). */
const CICD_POLL_MS = 120_000
/** How soon it asks again while the daemon is still reading GitHub (an answer marked refreshing or pending). */
const CICD_REFRESH_MS = 3_000
/** How often each owner's Actions bill is asked again (the daemon keeps it 30 minutes). */
const USAGE_EVERY_MS = 30 * 60_000
const CACHE_KEY = 'cicd:now'
const STATUS_PAGE = 'https://www.githubstatus.com'

/** How fresh the section is, said in its header (Freshness): the body reads, the header says it. */
interface CICDFresh {
  at?: number
  loading: boolean
  failed: boolean
  reason?: string
  confirmed: boolean
  retry: () => void
}

export function CICDPanel() {
  const [fresh, setFresh] = useState<CICDFresh>()
  return (
    <Panel fold="now.cicd" title="CI/CD" right={
      <span className="flex min-w-0 items-center gap-2">
        {fresh && <Freshness at={fresh.at} loading={fresh.loading} failed={fresh.failed} reason={fresh.reason} confirmed={fresh.confirmed} onRetry={fresh.retry} compact />}
        <span className="truncate" title="GitHub's runs, pull requests and releases as the Pipeline page reads them, and githubstatus.com; agent cost at API list price">GitHub · agent cost at list price</span>
      </span>
    }>
      <CICDBody onFresh={setFresh} />
    </Panel>
  )
}

function useReposCI(older: boolean, hide: readonly string[]): { data?: ReposCI; failed: boolean; usage: Record<string, ActionsUsage>; loading: boolean; reason?: string; confirmed: boolean; retry: () => void } {
  const [data, setData] = useState<ReposCI | undefined>(() => {
    const c = readDeck<unknown>(CACHE_KEY)?.d
    return c === undefined ? undefined : asReposCI(c)
  })
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [reason, setReason] = useState<string>()
  const [confirmed, setConfirmed] = useState(false)
  const retryRef = useRef<() => void>(() => {})
  const [usage, setUsage] = useState<Record<string, ActionsUsage>>({})
  const asked = useRef<Record<string, number>>({})
  const alive = useRef(true)
  const last = useRef(data)
  const hideKey = hide.join(',')
  useEffect(() => {
    alive.current = true
    let timer = 0
    let again = CICD_POLL_MS
    let inFlight = false
    const tick = async () => {
      if (document.hidden || inFlight) return
      inFlight = true
      setLoading(true)
      try {
        const d = keepWhileReading(last.current, asReposCI(await api.reposCI({ older, hide: hideKey ? hideKey.split(',') : [] })))
        if (!alive.current) return
        last.current = d
        setData(d)
        setConfirmed(true)
        setLoading(d.refreshing || d.repos.some((r) => !!r.pending))
        setFailed(!!d.refresh_error && !d.refreshing)
        setReason(d.refresh_error || undefined)
        if (!older) writeDeck(CACHE_KEY, d)
        again = d.refreshing || d.repos.some((r) => r.pending) ? CICD_REFRESH_MS : CICD_POLL_MS
        if (d.github_connected) {
          for (const o of owners(d.repos)) {
            if (Date.now() - (asked.current[o] ?? 0) < USAGE_EVERY_MS) continue
            asked.current[o] = Date.now()
            api.actionsUsage(o).then((u) => { if (alive.current) setUsage((m) => ({ ...m, [o]: u })) }, () => { /* said as not read */ })
          }
        }
      } catch (e) {
        if (alive.current) { setFailed(true); setLoading(false); setReason(errText(e)) }
      }
      inFlight = false
      if (alive.current && !document.hidden) timer = window.setTimeout(() => void tick(), again)
    }
    retryRef.current = () => { if (!inFlight) { window.clearTimeout(timer); void tick() } }
    void tick()
    const onVisible = () => { if (!document.hidden) { window.clearTimeout(timer); void tick() } }
    document.addEventListener('visibilitychange', onVisible)
    return () => { alive.current = false; retryRef.current = () => {}; window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [older, hideKey])
  const retry = useCallback(() => retryRef.current(), [])
  return { data, failed, usage, loading, reason, confirmed, retry }
}

function CICDBody({ onFresh }: { onFresh: (f: CICDFresh | undefined) => void }) {
  const [older, setOlder] = useState(false)
  const [hidden, setHidden] = useState<Set<string>>(() => loadHiddenRepos())
  const hide = useMemo(() => [...hidden].sort(), [hidden])
  const { data: answer, failed, usage, loading, reason, confirmed, retry } = useReposCI(older, hide)
  // The header's freshness: the time GitHub was last read for the rows (the
  // oldest row's read, else when the daemon composed it).
  const readAt = answer?.repos.reduce((m, r) => (r.read_at && (!m || r.read_at < m) ? r.read_at : m), 0) || answer?.fetched_at
  const rowRefused = answer?.repos.find((r) => r.error && r.read_at)
  useEffect(() => {
    onFresh(answer?.github_connected ? {
      at: readAt, loading, failed: failed || (!!rowRefused && !loading), reason: reason ?? rowRefused?.error?.message, confirmed: confirmed && !failed, retry,
    } : undefined)
  }, [onFresh, answer?.github_connected, readAt, loading, failed, reason, rowRefused, confirmed, retry])
  useEffect(() => () => onFresh(undefined), [onFresh])
  const setHide = useCallback((repo: string, on: boolean) => {
    setHidden((cur) => {
      const next = new Set(cur)
      if (on) next.add(repo.toLowerCase())
      else next.delete(repo.toLowerCase())
      saveHiddenRepos(next)
      return next
    })
  }, [])
  // Hidden or shown again is drawn at once; the next answer agrees.
  const data = useMemo(() => answer && {
    ...answer,
    repos: answer.repos.filter((r) => !hidden.has(r.repo.toLowerCase()) && (older || !r.older)),
    quiet: [
      ...answer.quiet.filter((q) => q.why !== 'hidden' || hidden.has(q.repo.toLowerCase())),
      ...answer.repos.filter((r) => hidden.has(r.repo.toLowerCase())).map((r): RepoCIQuiet => ({ project_id: r.project_id, name: r.name, repo: r.repo, last_active: r.last_active, why: 'hidden' })),
    ],
  }, [answer, hidden, older])
  const now = Date.now()
  if (!data) return <p className="px-3 py-3 text-[12.5px] text-fg-muted">{failed ? 'Could not read CI/CD.' : 'Reading CI/CD…'}</p>
  if (!data.github_connected) {
    return (
      <p data-cicd="off" className="px-3 py-3 text-[12.5px] text-fg-muted">
        CI, releases and what each pull request cost are read from GitHub. <a href={href({ name: 'settings' })} className="text-accent hover:underline">Connect GitHub in Settings</a>
      </p>
    )
  }
  const st = statusLine(data.status)
  const days = data.recent_days ?? 14
  const calm = sectionErrorText(data.repos)
  const quiet = quietText(data.quiet, days)
  const hiddenRows = data.quiet.filter((q) => q.why === 'hidden')
  return (
    <div data-cicd-panel className="@container/cicd flex flex-col">
      {st && (
        <div data-cicd-status={st.tone} title={st.title} className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border px-3 py-1.5 text-[12px] ${st.tone === 'fail' ? 'bg-danger/10 text-danger' : st.tone === 'warn' ? 'bg-warn/10 text-warn' : 'text-fg-muted'}`}>
          <span aria-hidden className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${st.tone === 'fail' ? 'bg-danger' : st.tone === 'warn' ? 'bg-warn' : st.tone === 'ok' ? 'bg-ok' : 'bg-fg-faint'}`} />
          <span className="min-w-0">{st.text}</span>
          {data.status?.incidents[0] && <span className="min-w-0 text-fg-muted">· {data.status.incidents[0].name}</span>}
          <button type="button" onClick={() => openExternal(data.status?.incidents[0]?.url || STATUS_PAGE)} className="ml-auto shrink-0 text-[11.5px] text-fg-faint hover:text-fg-muted hover:underline">githubstatus.com ↗</button>
        </div>
      )}
      {calm && (
        <p data-cicd-calm className="border-b border-border px-3 py-1.5 text-[12px] text-fg-muted" title={data.repos[0]?.error?.message}>
          {calm}
        </p>
      )}
      {data.repos.length === 0 && data.quiet.length === 0 ? <p className="px-3 py-3 text-[12.5px] text-fg-muted">No listed repository is on GitHub.</p>
        : data.repos.length === 0 && !older ? <p className="px-3 py-3 text-[12.5px] text-fg-muted">No repository on GitHub had a session in the last {days} days.</p>
          : data.repos.map((r) => <RepoBlock key={r.project_id} r={r} now={now} usage={usage[r.repo.split('/')[0] ?? '']} calm={!!calm} onHide={() => setHide(r.repo, true)} />)}
      {quiet && (
        <div data-cicd-quiet className="border-t border-border px-3 py-1.5 text-[12px] text-fg-muted">
          <button type="button" aria-expanded={older} onClick={() => setOlder((o) => !o)} title={quiet.title} className="text-left hover:text-fg">
            {older ? 'Fold older repositories' : <>{quiet.text} — <span className="text-accent hover:underline">show</span></>}
          </button>
          {older && hiddenRows.length > 0 && (
            <ul className="mt-1 flex flex-col">
              {hiddenRows.map((q) => (
                <li key={q.repo} data-cicd-hidden={q.repo} className="flex min-w-0 items-center gap-2 py-0.5">
                  <EyeOffIcon size={13} className="shrink-0 text-fg-faint" />
                  <span className="truncate text-fg">{q.name || q.repo}</span>
                  <span className="mono truncate text-[11px] text-fg-faint">{q.repo}</span>
                  {q.last_active ? <span className="shrink-0 text-[11px] text-fg-faint">active {fmtAgo(q.last_active, now)}</span> : null}
                  <button type="button" onClick={() => setHide(q.repo, false)} className="ml-auto shrink-0 text-[11.5px] text-accent hover:underline">Show again</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function Cell({ label, children, note, title, data }: { label: string; children: ReactNode; note?: ReactNode; title?: string; data?: string }) {
  return (
    <div data-cicd-cell={data ?? label} title={title} className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate text-[10.5px] uppercase tracking-[0.12em] text-fg-faint">{label}</span>
      <div className="flex min-h-[30px] items-end justify-between gap-2">{children}</div>
      {note !== undefined && <span className="line-clamp-2 text-[11px] leading-snug text-fg-muted">{note}</span>}
    </div>
  )
}

const BIG = 'num truncate text-[18px] font-semibold leading-none text-fg'

function RepoBlock({ r, now, usage, calm, onHide }: { r: RepoCIRow; now: number; usage?: ActionsUsage; calm: boolean; onHide: () => void }) {
  const [menu, setMenu] = useState<MenuAt | undefined>()
  const openMenu = (e: ReactMouseEvent<HTMLButtonElement>) => {
    const b = e.currentTarget.getBoundingClientRect()
    setMenu({ x: b.right - 200, y: b.bottom + 4 })
  }
  const err = rowErrorText(r)
  // Nothing read from GitHub yet, or refused before anything was: one line, no empty cells.
  const bare = !!r.pending || (!!r.error && !r.ci && r.open === 0 && r.merged_7d === 0 && !r.release)
  const errCls = r.slow || r.error?.kind === 'network' || r.error?.kind === 'rate_limit' ? 'text-fg-muted' : 'text-warn'
  const ci = r.ci
  const wf = ci?.workflows[0]
  const labels = (r.days ?? []).map((d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
  const u = usageLine(usage)
  const red = redPct(ci)
  return (
    <section data-cicd-repo={r.repo} className="border-b border-border px-3 py-3 last:border-b-0">
      <div className={`${bare ? '' : 'mb-2 '}flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5`}>
        <span className="flex min-w-0 items-center gap-2 text-[13px]">
          {r.live > 0 && <span aria-hidden className="inline-block h-[7px] w-[7px] shrink-0 rounded-full bg-ok" />}
          <span className="truncate font-medium">{r.name || r.repo}</span>
          <span className="mono truncate text-[11.5px] text-fg-faint">{r.repo}</span>
        </span>
        {r.live > 0 && <span className="text-[11.5px] text-fg-muted">{r.live} session{r.live === 1 ? '' : 's'} running</span>}
        {r.live === 0 && r.last_active ? <span className="text-[11.5px] text-fg-faint" title={new Date(r.last_active).toLocaleString()}>active {fmtAgo(r.last_active, now)}</span> : null}
        {r.pending && <span className="text-[11.5px] text-fg-faint">reading GitHub…</span>}
        {bare && err && !calm && <span data-cicd-error={r.slow ? 'slow' : r.error?.kind} className={`min-w-0 truncate text-[11.5px] ${errCls}`} title={r.error?.message}>· {err}</span>}
        {r.release && (
          <button type="button" onClick={() => r.release?.url && openExternal(r.release.url)} title={`The newest published release${r.release.name ? `: ${r.release.name}` : ''}\n${new Date(r.release.published_at).toLocaleString()}`}
            className="ml-auto shrink-0 text-[11.5px] text-fg-muted hover:text-fg">
            released <span className="mono text-fg">{r.release.tag}</span> {fmtAgo(r.release.published_at, now)}
          </button>
        )}
        <button type="button" aria-label={`${r.name || r.repo}: actions`} aria-haspopup="menu" aria-expanded={!!menu} onClick={openMenu}
          className={`${r.release ? '' : 'ml-auto '}shrink-0 rounded px-1 text-[13px] leading-none text-fg-faint hover:bg-fg/5 hover:text-fg`}>⋯</button>
        {menu && (
          <MenuBox at={menu} label={`${r.name || r.repo}: actions`} width={200} onClose={() => setMenu(undefined)}>
            <MenuItem icon={<EyeOffIcon size={14} />} label="Hide from CI/CD" onClick={() => { setMenu(undefined); onHide() }} />
          </MenuBox>
        )}
      </div>
      {!bare && err && !calm && (
        <p data-cicd-error={r.slow ? 'slow' : r.error?.kind} className={`mb-2 truncate text-[11.5px] ${errCls}`} title={r.error?.message}>{err}</p>
      )}
      {!bare && <>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-x-5 gap-y-3">
        <Cell label="Actions this month" data="usage" title={u?.title}
          note={!u ? (usage ? '' : 'reading…') : u.kind === 'available' ? 'billed, GitHub’s report' : u.kind === 'permission'
            ? <button type="button" onClick={() => openExternal(u.url)} className="text-left text-accent hover:underline">grant {usage?.org ? 'Administration' : 'Plan'} (read) to see it ↗</button> : u.text}>
          <span className={BIG}>{u?.kind === 'available' ? u.text.replace(/^Actions this month: /, '').split(' · ')[0] : '–'}</span>
          {u?.kind === 'available' && <span className="num shrink-0 text-[12px] text-fg-muted">{u.text.split(' · ')[1]}</span>}
        </Cell>
        <Cell label={`CI time${wf ? ` · ${wf.name}` : ''}`} data="ci" title={wf ? `The median wall-clock time of ${wf.name}'s successful runs over 14 days, GitHub's run times; the line is the same median per day` : undefined}
          note={wf?.median_ms ? `median of ${wf.median_runs} runs` : 'fewer than two successful runs'}>
          <span className={BIG}>{wf?.median_ms ? fmtRun(wf.median_ms) : '–'}</span>
          {wf && <Trend values={wf.daily_median_ms} labels={labels} />}
        </Cell>
        <Cell label="Red runs · 14d" data="red" title={ci ? `${ci.red} of ${ci.runs} finished runs failed (failure, timed out, could not start); ${ci.reruns} re-runs` : undefined}
          note={ci ? `${ci.red} of ${ci.runs}${ci.reruns ? ` · ${ci.reruns} re-run` : ''}` : 'runs not read'}>
          <span className={`${BIG} ${ci && ci.red > 0 ? 'text-danger' : ''}`}>{red ?? '–'}</span>
          {ci && ci.per_day.length > 0 && <Bars values={ci.per_day.map((d) => d.runs)} red={ci.per_day.map((d) => d.red)} labels={labels} unit="runs" />}
        </Cell>
        <Cell label="Stuck" data="stuck" title="A run going on more than twice its workflow's median (and 10 minutes over it), or waiting for a runner over 15 minutes"
          note={r.stuck.length === 0 ? 'nothing past its median' : stuckText(r.stuck[0]!, now, spanText)}>
          <span className={`${BIG} ${r.stuck.length > 0 ? 'text-danger' : ''}`}>{r.stuck.length}</span>
          {r.stuck[0]?.url && <button type="button" onClick={() => openExternal(r.stuck[0]!.url!)} className="shrink-0 text-[11.5px] text-accent hover:underline">open ↗</button>}
        </Cell>
        <Cell label="Pull requests" data="prs" note={`${r.merged_7d} merged in 7 days`} title="Open now, and merged in the last 7 days, among the newest 50 listed">
          <span className={BIG}>{r.open}<span className="ml-1 text-[12px] font-normal text-fg-muted">open</span></span>
        </Cell>
      </div>
      {(r.top_prs.length > 0 || r.authors.length > 0) && (
        <div className="mt-3 grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-x-5 gap-y-3 @max-[640px]/cicd:grid-cols-1">
          <div data-cicd-top>
            <h4 className="mb-1 text-[10.5px] uppercase tracking-[0.12em] text-fg-faint" title={AGENT_COST_NOTE}>Cost per pull request · open or merged in 7 days</h4>
            {r.top_prs.length === 0 ? <p className="text-[11.5px] text-fg-faint">No agent session was recorded on one.</p> : (
              <ul className="flex flex-col">
                {r.top_prs.map((p) => (
                  <li key={p.number} className="flex min-w-0 items-center gap-2 border-b border-border/60 py-1 text-[12px] last:border-b-0">
                    <span aria-hidden className="pr-dot" data-state={p.draft && p.state === 'open' ? 'draft' : p.state} />
                    <button type="button" onClick={() => openExternal(p.url)} className="num shrink-0 text-fg-muted hover:underline">#{p.number}</button>
                    <span className="min-w-0 flex-1 truncate text-fg" title={p.title}>{p.title}</span>
                    {p.author && <GitHubAvatar login={p.author} url={p.author_avatar} size={16} />}
                    {p.live > 0 && <span className="shrink-0 text-[11px] text-ok" title={`${p.live} agent session${p.live === 1 ? '' : 's'} running on it`}>● {p.live}</span>}
                    {sharedTitle(p) && <span data-cicd-shared className="shrink-0 rounded border border-border px-1 text-[10px] text-fg-faint" title={sharedTitle(p)}>shared</span>}
                    {prTokens(p) && <span data-cicd-tokens className="num shrink-0 text-[11px] text-fg-faint" title={prTokens(p)!.title}>{prTokens(p)!.text} ·</span>}
                    <span className="num w-[64px] shrink-0 text-right font-medium text-fg" title={`${p.sessions} session${p.sessions === 1 ? '' : 's'}${sharedTitle(p) ? `\n${sharedTitle(p)}` : ''}\n${AGENT_COST_NOTE}`}>${p.cost_usd.toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div data-cicd-who>
            <h4 className="mb-1 text-[10.5px] uppercase tracking-[0.12em] text-fg-faint" title={`Who opened the pull requests open now or merged in 7 days, and what the agents spent on theirs. ${AGENT_COST_NOTE}`}>Who · 7 days</h4>
            <ul className="flex flex-col">
              {r.authors.slice(0, 6).map((a) => (
                <li key={a.login} className="flex min-w-0 items-center gap-2 border-b border-border/60 py-1 text-[12px] last:border-b-0">
                  <GitHubPerson login={a.login} url={a.avatar} size={18} className="min-w-0 flex-1 text-fg" />
                  <span className="shrink-0 text-[11px] text-fg-muted">{a.prs} PR{a.prs === 1 ? '' : 's'}{a.merged ? ` · ${a.merged} merged` : ''}</span>
                  <span className="num w-[64px] shrink-0 text-right font-medium text-fg">{a.cost_usd > 0 ? `$${a.cost_usd.toFixed(2)}` : '–'}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      </>}
    </section>
  )
}
