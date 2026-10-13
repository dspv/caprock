/**
 * A day per bar, today's lighter (it is not over), each bar's hover saying
 * its day and figure; an optional red part drawn over it. Shared by the PRs &
 * CI tab's figures and the Now screen's Repos section.
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
