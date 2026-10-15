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
import { AGENT_COST_NOTE, perDay, type BoardRelease, type FlowPoint, type PRBoard, type SeriesKey } from '@/lib/prboard'
import { flowCompare, flowCompareTitle, flowPointTitle, flowTone, flowUsualLine, flowWord } from '@/lib/flowtrend'
import { spanText } from '@/lib/prstats'
import { fmtAgo } from '@/lib/format'
import { fmtRun } from '@/lib/ci'
import { openExternal } from '@/lib/nudges'
import { Panel, Stat } from './ui'
import { TrendLine } from './TodayTrend'

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

/**
 * The flow as figure tiles. `compact`: Home's five (in flight, needs a fix,
 * ready, throughput, CI median) in its CI/CD panel.
 */
export function FlowFigures({ board, compact }: { board: PRBoard; compact?: boolean }) {
  const all = flowFigures(board)
  const shown = compact ? all.slice(0, 5) : all
  // Columns by the panel's own width, not the window's: in the app the
  // sidebar and the tab take a third of it.
  return (
    <div className="@container/flow">
      <div data-board-flow aria-label="How pull requests move"
        className={`grid grid-cols-2 divide-x divide-border ${compact ? '@min-[520px]/flow:grid-cols-3 @min-[820px]/flow:grid-cols-5' : '@min-[560px]/flow:grid-cols-4 @min-[1180px]/flow:grid-cols-8'}`}>
        {shown.map((x) => {
          const pts = x.series ? board.flow.series?.[x.series] : undefined
          return (
            <Stat key={x.key} data={x.key} label={x.label} value={x.value} sub={x.sub} tone={x.tone} hint={x.hint} size="compact"
              trend={x.series && pts && pts.length > 1 ? <FlowTrend k={x.series} pts={pts} label={x.label} /> : undefined} />
          )
        })}
      </div>
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
                  <button type="button" onClick={() => r.url && openExternal(r.url)} className="mono truncate text-[14px] font-semibold text-fg hover:underline" title={r.name ? `${r.name}\nOpen on GitHub` : 'Open on GitHub'}>{r.tag}</button>
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
