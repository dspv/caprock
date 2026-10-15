/**
 * A Today cell's trend: a quiet line of the previous 14 days and today, and
 * one word saying whether today is usual (lib/trend.ts).
 *
 * Calm on purpose. The line is faint ink, the usual a dashed hairline across
 * it, today a dot at the right end. The word is muted; only "above usual"
 * takes the accent, and nothing is red or green: a busy day is not a fault,
 * and this screen keeps colour for what needs acting on.
 *
 * The block keeps its height whether the trends have arrived or not, so the
 * row never jumps when they land.
 *
 * The line itself (TrendLine) is shared with the Pipeline's figures
 * (PRBoard's FlowTrend), so the two read as one picture.
 */
import type { Trends } from '@/lib/api'
import { compare, compareTitle, compareWord, pointTitle, trendPoints, usualOf, type TrendMetric } from '@/lib/trend'

const H = 18 // the line's height, px
const PAD = 2.5 // room for the stroke and the dot at the extremes

/**
 * The 18px line: one value a day, oldest first, today last; undefined is a
 * gap. `titles` is each day's hover text, `usual` the dashed level, `dot`
 * today's dot's class. `isolated` draws a day with no neighbour as a dot,
 * where a sparse series (a median of the day's merges) would lose it.
 * `ownRange` spans the values' own range instead of starting at zero.
 */
export function TrendLine({ pts, titles, usual, dot, label, isolated, ownRange }: {
  pts: readonly (number | undefined)[]
  titles: readonly string[]
  usual?: number
  dot: string
  label?: string
  isolated?: boolean
  ownRange?: boolean
}) {
  const defined = pts.filter((v): v is number => v !== undefined)
  const ready = defined.length > 0
  let lo = 0, hi = Math.max(...defined, usual ?? 0, 1e-9)
  if (ownRange && defined.length) {
    lo = Math.min(...defined)
    hi = Math.max(...defined)
    if (hi - lo < 1) { const mid = (hi + lo) / 2; lo = mid - 0.5; hi = mid + 0.5 }
  }
  const y = (v: number) => H - PAD - ((v - lo) / (hi - lo || 1)) * (H - 2 * PAD)
  const n = pts.length
  const x = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100)
  // Gaps where a day has no value (no rate on an idle day): a line drawn
  // through them would invent the days between.
  const segs: string[] = []
  const lone: number[] = []
  let cur: string[] = []
  let curAt = -1
  const close = () => {
    if (cur.length === 1 && curAt !== n - 1) lone.push(curAt)
    if (cur.length) segs.push(cur.join(' '))
    cur = []
  }
  pts.forEach((v, i) => {
    if (v === undefined) { close(); return }
    if (!cur.length) curAt = i
    cur.push(`${x(i).toFixed(2)},${y(v).toFixed(2)}`)
  })
  close()
  const last = pts[n - 1]
  return (
    <div className="relative h-[18px] w-full max-w-[240px]" role="img" aria-label={ready ? label : undefined}>
      {ready && (
        <>
          <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
            {usual !== undefined && usual > 0 && (
              <line x1="0" x2="100" y1={y(usual)} y2={y(usual)} className="text-border-strong" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
            )}
            {segs.map((p, i) => p.includes(' ')
              ? <polyline key={i} points={p} fill="none" className="text-fg-faint" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              : null)}
            {/* A hover target per day, the full height of the line. */}
            {pts.map((_, i) => (
              <rect key={i} x={Math.max(0, x(i) - 50 / Math.max(1, n - 1))} width={100 / Math.max(1, n - 1)} y="0" height={H} fill="transparent">
                <title>{titles[i]}</title>
              </rect>
            ))}
          </svg>
          {/* Dots are HTML so the stretched viewBox does not squash them. */}
          {isolated && lone.map((i) => (
            <span key={i} aria-hidden data-trend-lone className="pointer-events-none absolute h-[3px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg-faint"
              style={{ left: `${x(i)}%`, top: `${y(pts[i]!)}px` }} />
          ))}
          {last !== undefined && (
            <span
              aria-hidden
              className={`pointer-events-none absolute h-[5px] w-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full ${dot}`}
              style={{ left: `${x(n - 1)}%`, top: `${y(last)}px` }}
            />
          )}
        </>
      )}
    </div>
  )
}

export function TodayTrend({ metric, trends, live, now, fmt, label }: {
  metric: TrendMetric
  trends: Trends | undefined
  /** Today's figure as the cell prints it: it replaces today's point (not
   *  for burn, whose point is the day's median window) and is what the word
   *  compares, unless `now` is given. */
  live?: number
  /** Burn: the rate now, set against the usual window. */
  now?: number
  fmt: (n: number) => string
  /** What the line is of, for a screen reader. */
  label: string
}) {
  const pts = trendPoints(trends, metric, live)
  const cmp = compare(trends, metric, now ?? live)
  const u = trends ? usualOf(trends, metric) : undefined
  const showUsual = cmp && cmp.kind !== 'thin' && u && u.usual > 0
  const n = pts.length
  const above = cmp?.kind === 'above'
  const titles = trends ? trends.series.map((d, i) => pointTitle(d, pts[i], metric, trends, i === n - 1, fmt)) : []

  return (
    <div className="mt-1.5 min-w-0" data-trend={metric}>
      {/* Cost, sessions, turns and burn start at zero, so a line's height is
        * its size; the cache rate sits near 98% every day and a zero
        * baseline would flatten it, so it spans its own range. */}
      <TrendLine pts={pts} titles={titles} usual={showUsual ? u!.usual : undefined} dot={above ? 'bg-accent' : 'bg-fg-muted'}
        label={trends ? `${label}, last ${trends.days} days and today` : undefined} ownRange={metric === 'cache'} />
      {metric !== 'cache' && (
        <div className="mt-0.5 h-[15px] truncate text-[11px] leading-[15px] num" data-compare={cmp?.kind ?? 'none'}
          title={cmp && trends ? compareTitle(cmp, metric, trends, fmt) : undefined}>
          {cmp && (
            <span className={above ? 'text-accent opacity-90' : cmp.kind === 'below' ? 'text-fg-muted' : 'text-fg-faint'}>
              {compareWord(cmp)}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
