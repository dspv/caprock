/**
 * The Pipeline's figures and releases (.ai/04-ui.md § Pipeline; owner,
 * 2026-10-14, translated: "essentially accounting of releases and
 * commits-PRs. That's the stat to watch."): how fast work flows — in flight,
 * needing a fix, ready, throughput, the CI median, opened → merged, merged →
 * released (an estimate), the agent cost listed — as the dashboard's own
 * figure tiles (Stat), each explained in a card under it, never over it
 * (owner, 2026-10-15, translated: "everything reads very badly … simply in
 * the Dashboard's style"); and each recent release with the pull requests it
 * shipped and what the agents spent on them. Both come in the page's one
 * answer (…/ci/stats' `board`): nothing here asks. Home's CI/CD panel draws
 * the first five figures from the same answer (PipelineCard).
 *
 * Each figure with a day-by-day series carries the Today cells' line and
 * word under it (FlowTrend, lib/flowtrend.ts; owner, 2026-10-15,
 * translated: "the figures in dynamics, like everywhere else in our app").
 */
import type { ReactNode } from 'react'
import type { BranchPR } from '@/lib/branches'
import { AGENT_COST_NOTE, EXPENSIVE_PERIODS, costText, costTitle, perDay, periodWords, type BoardRelease, type Costliest, type ExpensivePeriod, type FlowPoint, type KnownPR, type PRBoard, type SeriesKey } from '@/lib/prboard'
import { flowCompare, flowCompareTitle, flowPointTitle, flowTone, flowUsualLine, flowWord } from '@/lib/flowtrend'
import { spanText } from '@/lib/prstats'
import { fmtAgo } from '@/lib/format'
import { fmtRun } from '@/lib/ci'
import { openExternal } from '@/lib/nudges'
import type { Bucket } from '@/lib/flowbucket'
import { Panel, Stat } from './ui'
import { TrendLine } from './TodayTrend'
import { extProps } from '@/lib/externalLinks'

// ---------------------------------------------------------------- the flow

/** One figure of the flow: its caption, value, the line under it, and what it means. */
export interface FlowFigure { key: string; label: string; value: string; sub: ReactNode; hint: string; tone?: 'ok' | 'danger'; series?: SeriesKey }

/** The flow's figures in reading order; Home shows the first five. */
export function flowFigures(board: PRBoard): FlowFigure[] {
  const f = board.flow
  const open = f.counts.draft + f.counts.open + f.counts.fix + f.counts.ready
  return [
    { key: 'flight', series: 'flight', label: 'In flight', value: String(open), sub: `${f.counts.open} with CI running${f.counts.draft ? ` · ${f.counts.draft} draft` : ''}`,
      hint: 'Open pull requests among the newest listed: drafts, CI running, needing a fix and ready.' },
    { key: 'fix', label: 'Needs a fix', value: String(f.counts.fix), sub: f.counts.fix ? 'red CI, a conflict or changes asked' : 'nothing is red', tone: f.counts.fix ? 'danger' : undefined,
      hint: 'Open pull requests with a red check, a merge conflict, or a review asking for changes.' },
    { key: 'ready', label: 'Ready', value: String(f.counts.ready), sub: 'green, awaiting a merge', tone: f.counts.ready ? 'ok' : undefined,
      hint: 'Open pull requests whose checks passed (or that have none): waiting for a review or a merge.' },
    { key: 'throughput', series: 'throughput', label: `Throughput · ${f.days}d`, value: perDay(f.merged, f.days), sub: `${f.merged} merged`,
      hint: `Pull requests merged in the last ${f.days} days, a day on average, from GitHub's merge stamps.` },
    { key: 'ci', series: 'ci', label: 'CI median', value: f.ci_median_ms ? fmtRun(f.ci_median_ms) : '–', sub: f.ci_median_ms ? 'one successful run' : 'fewer than two runs',
      hint: "The busiest workflow's median successful run, start to finish, from GitHub's run times." },
    { key: 'ttm', series: 'ttm', label: 'Opened → merged', value: f.ttm_median_ms ? spanText(f.ttm_median_ms) : '–', sub: f.ttm_median_ms ? `median of ${f.ttm_count}` : 'fewer than two merges',
      hint: "The median time from opened to merged of the pull requests merged in the window, from GitHub's stamps." },
    { key: 'lag', series: 'lag', label: 'Merged → released', value: f.release_lag_median_ms ? `~${spanText(f.release_lag_median_ms)}` : '–',
      sub: f.release_lag_median_ms ? `estimate · ${f.release_lag_count} released` : f.release_lag_count === 1 ? 'one release so far' : 'no release matched',
      hint: 'An estimate: each merge into the default branch is matched to the first release published after it, and the median taken of merge to publish.' },
    { key: 'cost', series: 'cost', label: 'Agent cost', value: `$${f.cost_usd.toFixed(2)}`, sub: 'on these PRs · API list price', hint: AGENT_COST_NOTE },
  ]
}

/** The flow as figure tiles: Home's five (in flight, needs a fix, ready, throughput, CI median) in its CI/CD panel. */
export function FlowFigures({ board }: { board: PRBoard }) {
  // Columns by the panel's own width, not the window's: in the app the
  // sidebar and the tab take a third of it.
  return (
    <div className="@container/flow">
      <div data-board-flow aria-label="How pull requests move"
        className="grid grid-cols-2 divide-x divide-border @min-[520px]/flow:grid-cols-3 @min-[820px]/flow:grid-cols-5">
        {flowFigures(board).slice(0, 5).map((x) => {
          const pts = x.series ? board.flow.series?.[x.series] : undefined
          return (
            <Stat key={x.key} data={x.key} label={x.label} value={x.value} sub={x.sub} tone={x.tone} size="compact" hint={x.hint}
              trend={x.series && pts && pts.length > 1 ? <FlowTrend k={x.series} pts={pts} label={x.label} /> : undefined} />
          )
        })}
      </div>
    </div>
  )
}

const HINT_CARD = 'pointer-events-none absolute left-0 top-full z-30 mt-1 hidden w-[min(340px,90vw)] rounded-lg border border-border-strong bg-panel px-3 py-2 text-left text-[12.5px] font-normal leading-snug text-fg shadow-lg group-hover/stat:block group-focus-visible/stat:block'

/** One count of the Now card: a toggle for the list's filter, its pull requests in a card on hover. */
function BucketBtn({ k, n, label, big, tone, on, onPick, preview }: {
  k: Bucket; n: number; label: string; big?: boolean; tone?: string; on: boolean; onPick: (b: Bucket) => void; preview: (b: Bucket) => ReactNode
}) {
  return (
    <span data-stat={k} role="button" tabIndex={0} aria-pressed={on} onClick={() => onPick(k)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(k) } }}
      className={`group/stat relative inline-flex cursor-pointer items-baseline gap-1 rounded-[4px] outline-none focus-visible:ring-2 focus-visible:ring-accent ${on ? 'shadow-[inset_0_-2px_0_var(--color-accent)]' : 'hover:text-fg'}`}>
      <span className={`num ${big ? 'text-[22px] font-semibold leading-tight' : ''} ${tone ?? ''}`}>{n}</span>
      <span className={big ? 'text-[13px] text-fg' : ''}>{label}</span>
      <span role="tooltip" data-stat-hint className={HINT_CARD}>{preview(k)}</span>
    </span>
  )
}

const CLEAR_LABEL: Record<Bucket, string> = { flight: 'in flight', fix: 'red', ready: 'waiting' }
const BUSY_LABEL: Record<Bucket, string> = { flight: 'in flight', fix: 'needs a fix', ready: 'ready' }

/**
 * The Pipeline's Flow row: three cards, one main figure each (owner,
 * 2026-10-18, variant B). Now: All clear, or the most urgent count with the
 * other two under it, each a filter of the list. Speed: throughput, and CI,
 * opened to merged and merged to released as a line. Agents: the cost, and
 * the rest of AgentFigures' line.
 */
export function FlowCards({ board, bucket, onBucket, preview, agents }: {
  board: PRBoard
  bucket?: Bucket
  onBucket: (b: Bucket) => void
  preview: (b: Bucket) => ReactNode
  /** The Agents card: its line and hover, from AgentFigures. */
  agents: (trend: ReactNode) => ReactNode
}) {
  const f = board.flow
  const open = f.counts.draft + f.counts.open + f.counts.fix + f.counts.ready
  const n: Record<Bucket, number> = { flight: open, fix: f.counts.fix, ready: f.counts.ready }
  const clear = open === 0
  const main: Bucket = n.fix > 0 ? 'fix' : n.flight > 0 ? 'flight' : 'ready'
  const rest = (['flight', 'fix', 'ready'] as const).filter((k) => clear || k !== main)
  const btn = (k: Bucket, big?: boolean) => (
    <BucketBtn key={k} k={k} n={n[k]} label={(clear ? CLEAR_LABEL : BUSY_LABEL)[k]} big={big} on={bucket === k} onPick={onBucket} preview={preview}
      tone={big ? (k === 'fix' ? 'text-danger' : k === 'ready' ? 'text-ok' : 'text-fg') : undefined} />
  )
  const thin = (k: SeriesKey) => { const pts = f.series?.[k]; return !pts || pts.length < 2 || flowCompare(k, pts)?.kind === 'thin' }
  const spark = (k: SeriesKey, label: string) => {
    const pts = f.series?.[k]
    const c = pts ? flowCompare(k, pts) : undefined
    return pts && c && c.kind !== 'thin' ? (
      <div className="mt-1 min-w-0" data-trend={k}>
        <TrendLine pts={pts.map((p) => p.value)} titles={pts.map((p, i) => flowPointTitle(k, p, i === pts.length - 1))}
          usual={flowUsualLine(k, c.usual)} dot="bg-fg-muted" label={`${label}, last ${pts.length} days, today last`} isolated />
      </div>
    ) : undefined
  }
  const flow = flowFigures(board)
  const hintOf = (key: string) => flow.find((x) => x.key === key)!.hint
  const lag = f.release_lag_median_ms ? `~${spanText(f.release_lag_median_ms)}` : '–'
  const ci = f.ci_median_ms ? fmtRun(f.ci_median_ms) : '–'
  const ttm = f.ttm_median_ms ? spanText(f.ttm_median_ms) : '–'
  const part = (k: string, label: string, v: string) => <span data-flow-part={k} title={hintOf(k)}>{label} {v}</span>
  // Said once, under the row, instead of on every card.
  const missing = thin('throughput') || thin('cost')
  const cell = 'flex min-w-0 flex-col px-3 py-2.5'
  const cap = 'text-[10px] uppercase tracking-[0.12em] text-fg-faint'
  return (
    <div className="@container/flow">
      <div data-board-flow aria-label="How pull requests move"
        className="grid grid-cols-1 divide-y divide-border @min-[760px]/flow:grid-cols-3 @min-[760px]/flow:divide-x @min-[760px]/flow:divide-y-0">
        <div data-flow-card="now" className={cell}>
          <div className={cap}>Now</div>
          <div className="mt-1.5 flex min-h-[29px] items-center gap-2">
            {clear ? <><span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full bg-ok" /><span data-flow-clear className="text-[22px] font-semibold leading-tight text-fg">All clear</span></> : btn(main, true)}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-2 text-[11px] leading-snug text-fg-muted">
            {rest.map((k, i) => <span key={k} className="inline-flex gap-x-2">{i > 0 && <span aria-hidden>·</span>}{btn(k)}</span>)}
          </div>
        </div>
        <Stat data="speed" label={`Speed · ${f.days} days`} size="compact" value={perDay(f.merged, f.days)} trend={spark('throughput', 'Throughput')}
          hint={<><b>Throughput</b>: {hintOf('throughput')}<br /><b>CI</b>: {hintOf('ci')}<br /><b>PR→merge</b>: {hintOf('ttm')}<br /><b>merge→release</b> (an estimate): {hintOf('lag')}</>}
          sub={<span className="mono">{part('ci', 'CI', ci)} · {part('ttm', 'PR→merge', ttm)} · {part('lag', 'merge→release', lag)}</span>} />
        {agents(spark('cost', 'Agent cost'))}
      </div>
      {missing && <p data-flow-missing className="px-3 pb-2 text-[11px] text-fg-faint">Trends draw once there are a few days of history.</p>}
    </div>
  )
}

const WORD_TONE = { ok: 'text-ok', warn: 'text-warn', none: 'text-fg-muted' } as const
const DOT_TONE = { ok: 'bg-ok', warn: 'bg-warn', none: 'bg-fg-muted' } as const

/**
 * One figure's last days: the Today cells' line (TrendLine), the dashed
 * usual across it, today a dot at the right end, and the word under it —
 * green where today is the better side of usual, amber the worse, muted for
 * a figure with no better direction (lib/flowtrend.ts). Hovering a day says
 * that day; hovering the word says what today is set against.
 */
export function FlowTrend({ k, pts, label }: { k: SeriesKey; pts: readonly FlowPoint[]; label: string }) {
  const c = flowCompare(k, pts)
  const tone = flowTone(k, c)
  const n = pts.length
  const usual = c && c.kind !== 'thin' ? flowUsualLine(k, c.usual) : undefined
  return (
    <div className="mt-1 min-w-0" data-trend={k}>
      <TrendLine pts={pts.map((p) => p.value)} titles={pts.map((p, i) => flowPointTitle(k, p, i === n - 1))} usual={usual}
        dot={DOT_TONE[tone]} label={`${label}, last ${n} days, today last`} isolated />
      <div className="mt-0.5 h-[15px] truncate text-[11px] leading-[15px] num" data-compare={c?.kind ?? 'none'} data-tone={tone}
        title={c ? flowCompareTitle(k, c, n) : undefined}>
        {c && <span className={c.kind === 'thin' || c.kind === 'quiet' ? 'text-fg-faint' : WORD_TONE[tone]}>{flowWord(k, c)}</span>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- the most expensive

/** A release's day, "21 Oct" (the year too when not this one). */
function relDay(ms: number, now: number): string {
  const d = new Date(ms)
  const same = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString('en-GB', same ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
}

const sessionsText = (n: number) => `${n} session${n === 1 ? '' : 's'}`

/**
 * The five dearest pull requests and releases by recorded agent cost
 * (owner, 2026-10-23, translated: "some stats inside, like TOP-5 most
 * expensive pull requests and TOP-5 most expensive releases … it must fit in
 * organically"), over a period the viewer picks — the last 30 days by
 * default (owner: "by default a month"), or all time — from the daemon's own
 * answer (GET …/ci/costliest): every pull request this machine knows of,
 * past the board's newest 50, and the releases the checkout's version tags
 * mark. No GitHub request. Drawn once Caprock knows a pull request of the
 * repository, so a quiet month still offers All time.
 */
export function MostExpensive({ data, period, onPeriod, now, onOpenPR }: { data?: Costliest; period: ExpensivePeriod; onPeriod: (v: ExpensivePeriod) => void; now: number; onOpenPR: (p: KnownPR) => void }) {
  if (!data || data.reason || (data.prs_known === 0 && data.releases_counted === 0 && period === '30')) return null
  const span = periodWords(data.days)
  const cap = 'px-3 pb-1 pt-2.5 text-[10px] uppercase tracking-[0.12em] text-fg-faint'
  const row = 'grid w-full items-baseline gap-x-2 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-[var(--app-row-hover)] motion-reduce:transition-none'
  const rank = (i: number) => <span aria-hidden className="num text-[11px] text-fg-faint">{i + 1}</span>
  const none = (what: string) => <p className="px-3 pb-2.5 pt-1 text-[12px] text-fg-muted">{what}</p>
  const prScope = `${data.prs_counted} of the ${data.prs_known} pull requests Caprock knows of in this repository have a recorded agent cost${data.days > 0 ? ` and were merged, closed or last active in the ${span}` : ''}. Known: those an agent opened, merged or closed, and every one GitHub listed to this machine, kept locally.`
  const relScope = data.tags_read
    ? `Version tags (v1.2.3) on the default branch of this checkout, as of its last fetch${data.days > 0 ? `, tagged in the ${span}` : ''}: ${data.releases_counted}. Each costs what the pull requests its commits name cost, the same figures as on the left.`
    : 'The checkout’s tags could not be read.'
  const picker = (
    <span className="inline-flex items-center gap-0.5 rounded-md bg-panel-2 p-0.5" role="group" aria-label="Period" data-expensive-period>
      {EXPENSIVE_PERIODS.map((o) => (
        <button key={o.v} type="button" onClick={() => onPeriod(o.v)} aria-pressed={period === o.v} title={o.title} data-period={o.v}
          className={`rounded-[5px] px-2 py-0.5 text-[11px] normal-case tracking-normal ${period === o.v ? 'bg-accent font-medium text-panel' : 'text-fg-muted hover:text-fg'}`}>
          {o.label}
        </button>
      ))}
    </span>
  )
  return (
    <Panel fold="pipeline.expensive" title={<span title={AGENT_COST_NOTE}>Most expensive</span>} right={picker}>
      <div className="@container/top">
        <div data-board-expensive className="grid grid-cols-1 divide-y divide-border @min-[640px]/top:grid-cols-2 @min-[640px]/top:divide-x @min-[640px]/top:divide-y-0">
          <div data-expensive="prs" className="min-w-0 pb-1">
            <div className={cap} title={prScope}>Pull requests · {span}</div>
            {data.prs.length === 0 ? none(`No agent cost recorded on a pull request in the ${span}.`) : (
              <ol>
                {data.prs.map((p, i) => (
                  <li key={p.number}>
                    <button type="button" data-expensive-pr={p.number} onClick={() => onOpenPR(p)} title={`${p.title ? `#${p.number} ${p.title}\n` : ''}${p.state ? `${p.state.charAt(0).toUpperCase()}${p.state.slice(1)} · ` : ''}${costTitle(p.spend)}`} className={`${row} grid-cols-[14px_minmax(0,1fr)_auto]`}>
                      {rank(i)}
                      <span className="flex min-w-0 items-baseline gap-1.5"><span className="num shrink-0 text-fg-muted">#{p.number}</span><span className="truncate text-fg">{p.title}</span></span>
                      <span className="flex items-baseline gap-2 whitespace-nowrap">
                        <span className="num font-semibold text-fg">{costText(p.spend)}</span>
                        <span className="text-[12px] text-fg-muted">{sessionsText(p.spend.sessions)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div data-expensive="releases" className="min-w-0 pb-1">
            <div className={cap} title={relScope}>Releases · {span}</div>
            {data.releases.length === 0 ? none(!data.tags_read ? 'The checkout’s version tags could not be read.' : data.releases_counted === 0 ? `No version tag in the ${span}.` : 'No agent cost recorded on the pull requests they shipped.') : (
              <ol>
                {data.releases.map((r, i) => (
                  <li key={r.tag}>
                    <button type="button" data-expensive-release={r.tag} onClick={() => r.url && openExternal(r.url)} className={`${row} grid-cols-[14px_minmax(0,1fr)_auto_auto]`}
                      {...extProps(`${r.tag}\n$${r.cost_usd.toFixed(2)} from ${sessionsText(r.sessions)} on ${r.prs.length} pull request${r.prs.length === 1 ? '' : 's'}${r.first ? '\nThe oldest release here: it shipped everything before it too' : ''}\nOpen on GitHub`)}>
                      {rank(i)}
                      <span className="flex min-w-0 items-baseline gap-1.5">
                        <span className="mono truncate font-semibold text-fg">{r.tag}</span>
                        <span className="shrink-0 text-[12px] text-fg-muted">{relDay(r.at, now)}</span>
                      </span>
                      <span className="flex items-baseline gap-2 whitespace-nowrap">
                        <span className="num font-semibold text-fg">{costText({ cost_usd: r.cost_usd, sessions: r.sessions, live: 0, agents: [] })}</span>
                        <span className="text-[12px] text-fg-muted">{r.prs.length} PR{r.prs.length === 1 ? '' : 's'}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------- the releases

export function Releases({ releases, prs, now, onOpen }: { releases: BoardRelease[]; prs: BranchPR[]; now: number; onOpen: (n: number) => void }) {
  const byNum = new Map(prs.map((p) => [p.number, p]))
  return (
    <Panel fold="pipeline.releases" title="Releases" right={
      <span title={`Each merge into the default branch is matched to the first release published after it, from the newest listed pull requests. ${AGENT_COST_NOTE}`}>
        what each shipped, matched by merge time · agent cost at list price
      </span>
    }>
      <div data-board-releases>
        {releases.length === 0 ? <p className="px-3 py-3 text-[13px] text-fg-muted">No published release read.</p> : (
          <ul>
            {releases.map((r) => (
              <li key={r.tag} data-board-release={r.tag} className="grid grid-cols-[minmax(120px,0.9fr)_minmax(0,3fr)_auto] items-start gap-x-4 gap-y-1.5 border-b border-border px-3 py-2.5 last:border-b-0 @max-[760px]/pipe:grid-cols-1">
                <div className="min-w-0">
                  <button type="button" onClick={() => r.url && openExternal(r.url)} className="mono truncate text-[14px] font-semibold text-fg hover:underline" {...extProps(r.name ? `${r.name}\nOpen on GitHub` : 'Open on GitHub')}>{r.tag}</button>
                  <div className="text-[12px] text-fg-muted" title={new Date(r.published_at).toLocaleString()}>
                    {fmtAgo(r.published_at, now)}{r.prerelease ? ' · pre-release' : ''}
                  </div>
                </div>
                <div className="flex min-w-0 flex-wrap gap-1.5">
                  {r.prs.length === 0 ? <span className="text-[12px] text-fg-muted">{r.partial ? 'its merges are older than the pull requests listed' : 'no listed pull request merged for it'}</span>
                    : r.prs.map((n) => {
                      const p = byNum.get(n)
                      return (
                        <button key={n} type="button" onClick={() => onOpen(n)} title={p?.title ?? `#${n}`}
                          className="inline-flex max-w-[320px] items-center gap-1.5 rounded-full border border-border-strong px-2.5 py-[2px] text-[12px] text-fg hover:border-accent/60 hover:text-accent">
                          <span className="num shrink-0 text-fg-muted">#{n}</span><span className="truncate">{p?.title}</span>
                        </button>
                      )
                    })}
                  {r.partial && r.prs.length > 0 && <span className="self-center text-[12px] text-fg-muted" title="The listed pull requests may not reach back to the release before it">· older merges may be missing</span>}
                </div>
                <div className="text-right @max-[760px]/pipe:text-left">
                  <div className="num text-[14px] font-semibold text-fg" title={AGENT_COST_NOTE}>{r.cost_usd > 0 ? `$${r.cost_usd.toFixed(2)}` : '–'}</div>
                  <div className="text-[12px] text-fg-muted">{r.prs.length} PR{r.prs.length === 1 ? '' : 's'}{r.sessions ? ` · ${r.sessions} session${r.sessions === 1 ? '' : 's'}` : ''}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  )
}
