import { fmtRun } from '@/lib/ci'

/**
 * A day per bar, today's lighter (it is not over), each bar's hover saying
 * its day and figure; an optional red part drawn over it; and a day's median
 * as a line (Trend). Shared by the Pipeline page's figures and the Now
 * screen's Repos and CI/CD sections.
 */
export function Bars({ values, labels, red, unit, w = 72, h = 30 }: { values: number[]; labels: string[]; red?: number[]; unit: string; w?: number; h?: number }) {
  const max = Math.max(...values, 1)
  const bw = (w - (values.length - 1) * 2) / values.length
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${unit} per day, ${values.length} days`} className="block shrink-0 overflow-visible">
      {values.map((v, i) => {
        const bh = v > 0 ? Math.max(2, (v / max) * h) : 1
        const rh = red?.[i] ? Math.max(2, (red[i]! / max) * h) : 0
        const today = i === values.length - 1
        return (
          <g key={i}>
            <title>{`${labels[i] ?? ''}: ${v} ${unit}${red ? `, ${red[i] ?? 0} red` : ''}${today ? ' (today, so far)' : ''}`}</title>
            <rect x={i * (bw + 2)} y={h - bh} width={bw} height={bh} rx={1.5} fill="var(--color-fg-muted)" opacity={today ? 0.45 : 0.8} />
            {rh > 0 && <rect x={i * (bw + 2)} y={h - rh} width={bw} height={rh} rx={1.5} fill="var(--color-danger)" />}
          </g>
        )
      })}
    </svg>
  )
}

/** The days with a value as a 2px line, the last one dotted; nothing with fewer than two. */
export function Trend({ values, labels }: { values: number[]; labels: string[] }) {
  const w = 72
  const h = 30
  const pts = values.map((v, i) => ({ v, i })).filter((x) => x.v > 0)
  if (pts.length < 2) return null
  const lo = Math.min(...pts.map((x) => x.v))
  const hi = Math.max(...pts.map((x) => x.v))
  const x = (i: number) => 3 + (i / Math.max(values.length - 1, 1)) * (w - 6)
  const y = (v: number) => h - 3 - ((v - lo) / Math.max(hi - lo, 1)) * (h - 6)
  const last = pts[pts.length - 1]!
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="median per day" className="block shrink-0 overflow-visible">
      <path d={pts.map((q, k) => `${k ? 'L' : 'M'}${x(q.i).toFixed(1)},${y(q.v).toFixed(1)}`).join(' ')} fill="none" stroke="var(--color-fg-muted)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last.i)} cy={y(last.v)} r={3} fill="var(--color-fg)" stroke="var(--color-panel)" strokeWidth={1.5} />
      {pts.map((q) => <circle key={q.i} cx={x(q.i)} cy={y(q.v)} r={6} fill="transparent"><title>{`${labels[q.i] ?? ''}: ${fmtRun(q.v)}`}</title></circle>)}
    </svg>
  )
}
