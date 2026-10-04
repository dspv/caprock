/**
 * Donuts and rings, drawn by hand in SVG with theme tokens.
 *
 * The product has no chart library and does not need one for this: a donut is
 * a circle with a dash pattern per segment. The share is the point of every
 * chart here, so the biggest one is printed in the middle large enough to read
 * across a room, and the legend under it carries every figure — the picture is
 * never the only place a number lives.
 */
import type { ReactNode } from 'react'

export interface Segment {
  key: string
  label: string
  value: number
  /** The figure shown in the legend beside the share ("$1,234", "40,961"). */
  display: string
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
function Arc({ r, from, to, color, width, dashed }: { r: number; from: number; to: number; color: string; width: number; dashed?: boolean }) {
  const span = to - from
  if (span <= 0) return null
  const stroke = { stroke: color }
  if (span >= 0.9999) {
    return <circle r={r} fill="none" style={stroke} strokeWidth={width} strokeDasharray={dashed ? '3 3' : undefined} />
  }
  const pt = (f: number) => {
    const a = 2 * Math.PI * f - Math.PI / 2
    return `${(r * Math.cos(a)).toFixed(3)} ${(r * Math.sin(a)).toFixed(3)}`
  }
  const d = `M ${pt(from)} A ${r} ${r} 0 ${span > 0.5 ? 1 : 0} 1 ${pt(to)}`
  return <path d={d} fill="none" style={stroke} strokeWidth={width} strokeDasharray={dashed ? '3 3' : undefined} />
}

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
  const total = segments.reduce((a, s) => a + s.value, 0)
  const r = size / 2 - 12
  let at = 0
  return (
    <figure className="m-0 min-w-0">
      {title && <figcaption className="text-[10px] uppercase tracking-[0.12em] text-fg-faint mb-2">{title}</figcaption>}
      <div className="flex items-center gap-4 flex-wrap sm:flex-nowrap">
        <svg width={size} height={size} viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} role="img" aria-label={ariaLabel} className="shrink-0">
          <circle r={r} fill="none" style={{ stroke: 'var(--color-panel-2)' }} strokeWidth={18} />
          {total > 0 && segments.map((s, i) => {
            const from = at / total
            at += s.value
            const to = at / total
            // A hairline gap between segments, so two neighbours of close
            // colour still read as two.
            return <Arc key={s.key} r={r} from={from} to={Math.max(from, to - (segments.length > 1 ? 0.004 : 0))} color={colorOf(s, i)} width={18} />
          })}
          <text textAnchor="middle" y={4} className="num" style={{ fill: 'var(--color-fg)', fontSize: size * 0.2, fontWeight: 650, fontFamily: 'var(--font-mono)' }}>{center}</text>
          <text textAnchor="middle" y={size * 0.2} style={{ fill: 'var(--color-fg-muted)', fontSize: 10.5, fontFamily: 'var(--font-sans)' }}>
            {clip(centerLabel, 16)}
          </text>
        </svg>
        {legend && <Legend segments={segments} total={total} />}
      </div>
    </figure>
  )
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

export function Legend({ segments, total }: { segments: Segment[]; total: number }) {
  return (
    <ul className="m-0 p-0 list-none grid gap-1 min-w-0 flex-1 text-[11px]">
      {segments.map((s, i) => (
        <li key={s.key} className="flex items-baseline gap-2 min-w-0">
          <span className="inline-block w-2 h-2 rounded-[2px] shrink-0 translate-y-[1px]" style={{ background: colorOf(s, i) }} aria-hidden />
          <span className="truncate text-fg-muted min-w-0 flex-1" title={s.label}>{s.label}</span>
          <span className="num text-fg shrink-0">{s.display}</span>
          <span className="num text-fg-faint w-9 text-right shrink-0">{sharePct(s.value, total)}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * A single-value ring: a share of a whole, or a gauge of a limit. `marker`
 * draws a dashed arc from the value onward — the plan-limit forecast uses it
 * to show "at this pace it reaches the end before the reset".
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
        {marker && marker.to > v && <Arc r={r} from={v} to={Math.min(1, marker.to)} color={marker.color} width={width} dashed />}
        {v > 0 && <Arc r={r} from={0} to={v} color={dim ? 'var(--color-fg-faint)' : color} width={width} />}
      </svg>
      {children && <span className="absolute inset-0 flex flex-col items-center justify-center text-center leading-none">{children}</span>}
    </span>
  )
}
