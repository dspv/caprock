/**
 * Donuts and rings, drawn by hand in SVG with theme tokens.
 *
 * The product has no chart library and does not need one for this: a donut is
 * a circle with a dash pattern per segment. The share is the point of every
 * chart here, so the biggest one is printed in the middle large enough to read
 * across a room, and the legend under it carries every figure — the picture is
 * never the only place a number lives.
 */
import { useState, type ReactNode } from 'react'

export interface Segment {
  key: string
  label: string
  value: number
  /** The figure shown in the legend beside the share ("$1,234", "40,961"). */
  display: string
  /** A short gloss printed under the label in the legend ("re-reading context"). */
  detail?: string
}

/**
 * Segment colours: the brand amber and steps toward the ground, then neutrals,
 * with "other" always the faintest. Theme tokens, so paper and graphite each
 * get their own contrast.
 */
export const SEGMENT_COLORS = [
  'var(--color-accent)',
  'color-mix(in srgb, var(--color-accent) 58%, var(--color-panel))',
  'var(--color-fg-muted)',
  'color-mix(in srgb, var(--color-accent) 30%, var(--color-panel))',
  'color-mix(in srgb, var(--color-fg-muted) 55%, var(--color-panel))',
]
export const OTHER_COLOR = 'var(--color-border-strong)'

export function colorOf(seg: Segment, i: number): string {
  return seg.key === '__other' ? OTHER_COLOR : SEGMENT_COLORS[i % SEGMENT_COLORS.length]!
}

/** Keep the top `n` segments and fold the rest into "other". */
export function topN(segs: Segment[], n: number, fmt: (v: number) => string): Segment[] {
  const sorted = [...segs].filter((s) => s.value > 0).sort((a, b) => b.value - a.value)
  if (sorted.length <= n + 1) return sorted
  const head = sorted.slice(0, n)
  const tail = sorted.slice(n).reduce((a, s) => a + s.value, 0)
  return [...head, { key: '__other', label: 'other', value: tail, display: fmt(tail) }]
}

/** "<1%" under one percent, else floored: a share never rounds up into looking bigger. */
export function sharePct(v: number, total: number): string {
  if (total <= 0) return '—'
  const p = (100 * v) / total
  if (p > 0 && p < 1) return '<1%'
  return `${Math.floor(p)}%`
}

/** An arc of a circle from `from` to `to` (fractions of a turn, from 12 o'clock). */
function Arc({ r, from, to, color, width, dashed, opacity, on }: {
  r: number; from: number; to: number; color: string; width: number; dashed?: boolean
  opacity?: number
  /** Pointer handlers, for a donut slice that answers hover. */
  on?: { onMouseEnter: () => void; onMouseLeave: () => void; onClick: () => void }
}) {
  const span = to - from
  if (span <= 0) return null
  const stroke = { stroke: color, opacity, transition: 'opacity 120ms' }
  if (span >= 0.9999) {
    return <circle r={r} fill="none" style={stroke} strokeWidth={width} strokeDasharray={dashed ? '3 3' : undefined} {...on} />
  }
  const pt = (f: number) => {
    const a = 2 * Math.PI * f - Math.PI / 2
    return `${(r * Math.cos(a)).toFixed(3)} ${(r * Math.sin(a)).toFixed(3)}`
  }
  const d = `M ${pt(from)} A ${r} ${r} 0 ${span > 0.5 ? 1 : 0} 1 ${pt(to)}`
  return <path d={d} fill="none" style={stroke} strokeWidth={width} strokeDasharray={dashed ? '3 3' : undefined} {...on} />
}

/**
 * A donut with its legend. Hovering a slice or a legend row, or focusing a
 * row, lights that slice, dims the rest and puts the slice's own share, name
 * and figure in the centre: the full reading in place, never a floating
 * tooltip (owner, 2026-10-12, translated: "maybe something on hover, but not
 * a popup").
 *
 * The figure is a container: beside the donut the legend needs about 400px
 * of figure, so a narrower one (three donuts across a 14-inch screen with the
 * sidebar open) puts the legend under the donut at full width instead of
 * truncating every label. Nothing in a donut or its legend is ever clipped
 * with an ellipsis; the centre caption wraps onto a second line.
 */
export function Donut({
  title,
  segments,
  center,
  centerLabel,
  ariaLabel,
  size = 148,
  legend = true,
}: {
  title: string
  segments: Segment[]
  /** The big figure in the middle, usually the leading share. */
  center: string
  centerLabel: string
  ariaLabel: string
  size?: number
  /** Off when an exact table sits beside the chart and would repeat it. */
  legend?: boolean
}) {
  const [active, setActive] = useState<string | null>(null)
  const total = segments.reduce((a, s) => a + s.value, 0)
  const r = size / 2 - 12
  const lit = segments.find((s) => s.key === active)
  // The centre's usable width: the hole, less a margin so text never meets the ring.
  const hole = Math.round(2 * (r - 9) * 0.82)
  let at = 0
  return (
    // Only a donut with a legend is a size container: a container has no
    // width of its own, so a bare donut in an `auto` grid column (Lifetime's
    // Top projects) collapsed to nothing and drew over the table beside it.
    <figure className={`${legend ? '@container min-w-0' : 'shrink-0'} m-0`} style={legend ? undefined : { width: size }} data-donut>
      {title && <figcaption className="text-[10px] uppercase tracking-[0.12em] text-fg-faint mb-2">{title}</figcaption>}
      <div className="flex flex-col items-start gap-3 @[400px]:flex-row @[400px]:items-center @[400px]:gap-4">
        <div className="relative shrink-0" style={{ width: size, height: size }}>
          <svg width={size} height={size} viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} role="img" aria-label={ariaLabel} className="block">
            <circle r={r} fill="none" style={{ stroke: 'var(--color-panel-2)' }} strokeWidth={18} />
            {total > 0 && segments.map((s, i) => {
              const from = at / total
              at += s.value
              const to = at / total
              // A hairline gap between segments, so two neighbours of close
              // colour still read as two.
              return <Arc key={s.key} r={r} from={from} to={Math.max(from, to - (segments.length > 1 ? 0.004 : 0))} color={colorOf(s, i)} width={18}
                opacity={active && active !== s.key ? 0.28 : 1}
                on={{ onMouseEnter: () => setActive(s.key), onMouseLeave: () => setActive(null), onClick: () => setActive(active === s.key ? null : s.key) }} />
            })}
          </svg>
          <div aria-hidden className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center" data-donut-center>
            <span className="num font-[650] leading-none text-fg" style={{ fontSize: size * 0.2 }}>{lit ? sharePct(lit.value, total) : center}</span>
            <span className="mt-1 leading-[1.15] text-fg-muted [overflow-wrap:anywhere] [text-wrap:balance]" style={{ width: hole, fontSize: 10.5 }}>
              {lit ? lit.label : centerLabel}
            </span>
            {lit && <span className="num mt-0.5 leading-none text-fg" style={{ fontSize: 10.5 }}>{lit.display}</span>}
          </div>
        </div>
        {legend && <Legend segments={segments} total={total} active={active} onActive={setActive} />}
      </div>
    </figure>
  )
}

export function Legend({ segments, total, active, onActive }: {
  segments: Segment[]
  total: number
  active?: string | null
  onActive?: (key: string | null) => void
}) {
  return (
    <ul className="m-0 p-0 list-none grid grid-cols-1 gap-0.5 min-w-0 w-full max-w-[320px] @[400px]:w-auto @[400px]:flex-1 text-[11px]">
      {segments.map((s, i) => (
        <li key={s.key} tabIndex={onActive ? 0 : undefined} data-active={active === s.key || undefined}
          onMouseEnter={onActive && (() => onActive(s.key))} onMouseLeave={onActive && (() => onActive(null))}
          onFocus={onActive && (() => onActive(s.key))} onBlur={onActive && (() => onActive(null))}
          className={`flex items-baseline gap-2 min-w-0 rounded-[4px] px-1 -mx-1 py-[1px] outline-none focus-visible:ring-1 focus-visible:ring-accent transition-opacity ${active === s.key ? 'bg-panel-2' : ''} ${active && active !== s.key ? 'opacity-60' : ''}`}>
          <span className="inline-block w-2 h-2 rounded-[2px] shrink-0 translate-y-[1px]" style={{ background: colorOf(s, i) }} aria-hidden />
          <span className="min-w-0 flex-1 text-fg-muted [overflow-wrap:anywhere]">
            {s.label}
            {s.detail && <span className="block text-[10px] leading-tight text-fg-faint">{s.detail}</span>}
          </span>
          <span className="num text-fg shrink-0">{s.display}</span>
          <span className="num text-fg-faint w-9 text-right shrink-0">{sharePct(s.value, total)}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * A single-value ring: a share of a whole, or a gauge of a limit. `marker`
 * draws a thin arc on the outer edge from the value onward — the plan-limit
 * forecast uses it to show "at this pace it reaches the end before the reset"
 * without painting the empty track.
 */
export function Ring({
  value,
  size = 28,
  width = 4,
  color = 'var(--color-accent)',
  dim,
  marker,
  children,
  ariaLabel,
}: {
  /** 0..1 */
  value: number
  size?: number
  width?: number
  color?: string
  dim?: boolean
  marker?: { to: number; color: string }
  children?: ReactNode
  ariaLabel?: string
}) {
  const r = size / 2 - width / 2 - 1
  const v = Math.max(0, Math.min(1, value))
  return (
    <span className="relative inline-flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} role={ariaLabel ? 'img' : undefined} aria-label={ariaLabel} aria-hidden={ariaLabel ? undefined : true}>
        <circle r={r} fill="none" style={{ stroke: 'var(--color-panel-2)' }} strokeWidth={width} />
        {v > 0 && <Arc r={r} from={0} to={v} color={dim ? 'var(--color-fg-faint)' : color} width={width} />}
        {/* A projection, not a reading: a hairline on the outer edge, so the
          * track stays an empty neutral and only the filled arc is "used". */}
        {marker && marker.to > v && <Arc r={size / 2 - 1.5} from={v} to={Math.min(1, marker.to)} color={marker.color} width={2} />}
      </svg>
      {children && <span className="absolute inset-0 flex flex-col items-center justify-center text-center leading-none">{children}</span>}
    </span>
  )
}

/**
 * A donut over one of the Cost screen's three tables (by model, by kind of
 * work, by project), so the shape of the split reads before the rows do
 * (owner, 2026-10-11, translated: "pie charts are clearly missing here"). The
 * table under it is the legend: each of the top rows carries its slice's
 * colour (`SliceDot`), so the picture never holds a figure the rows do not.
 */
export interface Cut {
  key: string
  label: string
  value: number
}

/** The donut's segments for a cut: the top four by value and "other". */
export function cutSegments(rows: Cut[], fmt: (v: number) => string): Segment[] {
  return topN(rows.map((r) => ({ ...r, display: fmt(r.value) })), 4, fmt)
}

/** Each top row's slice colour, by key; a row folded into "other" has none. */
export function sliceColors(segs: Segment[]): Map<string, string> {
  const m = new Map<string, string>()
  segs.forEach((s, i) => { if (s.key !== '__other') m.set(s.key, colorOf(s, i)) })
  return m
}

export function CutDonut({ segments, what }: { segments: Segment[]; what: string }) {
  const total = segments.reduce((a, s) => a + s.value, 0)
  if (segments.length === 0 || total <= 0) return null
  const lead = segments[0]!
  return (
    <div className="flex justify-center px-3 pb-2 pt-1">
      <Donut title="" segments={segments} size={156} legend={false}
        center={sharePct(lead.value, total)} centerLabel={lead.label}
        ariaLabel={`Cost by ${what}: ${segments.map((s) => `${s.label} ${s.display}, ${sharePct(s.value, total)}`).join('; ')}`} />
    </div>
  )
}

/** The swatch beside a table row whose slice is in the donut above it. */
export function SliceDot({ color }: { color?: string }) {
  return <span aria-hidden className="mr-2 inline-block h-[8px] w-[8px] shrink-0 rounded-[2px] align-middle" style={{ background: color ?? 'transparent' }} />
}

/**
 * A share as a bar and its figure, for the share column of a table: the
 * numbers view draws the split too, so it reads at a glance without the
 * donut (owner, 2026-10-11, translated: "the numbers should also show the
 * percentages graphically").
 */
export function ShareBar({ value, total, color }: { value: number; total: number; color?: string }) {
  const pct = total > 0 ? Math.max(0, Math.min(100, (100 * value) / total)) : 0
  return (
    <span className="inline-flex w-full items-center justify-end gap-2">
      <span aria-hidden className="h-[6px] w-10 shrink-0 overflow-hidden rounded-sm bg-panel-2">
        <span className="block h-full rounded-sm" style={{ width: `${pct}%`, background: color ?? 'var(--color-accent)' }} />
      </span>
      <span className="num w-8 shrink-0 text-right">{sharePct(value, total)}</span>
    </span>
  )
}
