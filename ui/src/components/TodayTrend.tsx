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
 */
import type { Trends } from '@/lib/api'
import { compare, compareTitle, compareWord, pointTitle, trendPoints, usualOf, type TrendMetric } from '@/lib/trend'

const H = 18 // the line's height, px
const PAD = 2.5 // room for the stroke and the dot at the extremes

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
  const defined = pts.filter((v): v is number => v !== undefined)
  const ready = trends && defined.length > 0

  // Cost, sessions, turns and burn start at zero, so a line's height is its
  // size; the cache rate sits near 98% every day and a zero baseline would
  // flatten it, so it spans its own range.
  let lo = 0, hi = Math.max(...defined, showUsual ? u!.usual : 0, 1e-9)
  if (metric === 'cache' && defined.length) {
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
  let cur: string[] = []
  pts.forEach((v, i) => {
    if (v === undefined) { if (cur.length) segs.push(cur.join(' ')); cur = []; return }
    cur.push(`${x(i).toFixed(2)},${y(v).toFixed(2)}`)
  })
  if (cur.length) segs.push(cur.join(' '))
  const last = pts[n - 1]
  const above = cmp?.kind === 'above'

  return (
    <div className="mt-1.5 min-w-0" data-trend={metric}>
      <div className="relative h-[18px] w-full max-w-[240px]" role="img" aria-label={ready ? `${label}, last ${trends!.days} days and today` : undefined}>
        {ready && (
          <>
            <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
              {showUsual && (
                <line x1="0" x2="100" y1={y(u!.usual)} y2={y(u!.usual)} className="text-border-strong" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
              )}
              {segs.map((p, i) => p.includes(' ')
                ? <polyline key={i} points={p} fill="none" className="text-fg-faint" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                : null)}
              {/* A hover target per day, the full height of the line. */}
              {trends!.series.map((d, i) => (
                <rect key={d.day} x={Math.max(0, x(i) - 50 / Math.max(1, n - 1))} width={100 / Math.max(1, n - 1)} y="0" height={H} fill="transparent">
                  <title>{pointTitle(d, pts[i], metric, trends!, i === n - 1, fmt)}</title>
                </rect>
              ))}
            </svg>
            {/* Today's dot is HTML so the stretched viewBox does not squash it. */}
            {last !== undefined && (
              <span
                aria-hidden
                className={`pointer-events-none absolute h-[5px] w-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full ${above ? 'bg-accent' : 'bg-fg-muted'}`}
                style={{ left: `${x(n - 1)}%`, top: `${y(last)}px` }}
              />
            )}
          </>
        )}
      </div>
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
