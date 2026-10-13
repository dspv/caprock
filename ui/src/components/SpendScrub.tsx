/**
 * The cockpit's spend chart (.ai/04-ui.md § Inspector): a period by time as
 * bars across the cockpit, the period's figure on its top line. The bars
 * measure what the viewer picked from the ▾ beside that figure — cost by
 * default, or tokens or turns (owner, 2026-10-13:
 * "switch its parameter, like cost and tokens beside the agent"). Hovering a
 * bar (or ←/→) reads that stretch: its figure takes the big figure's place,
 * a short date beside it ("Sun 11 Oct · 06–12") and "of $total" at the
 * right; leaving the chart puts the total back. At rest no bar is singled
 * out. Model in lib/scrub.ts.
 *
 * The stretch's figure used to sit at the top line's right after the total,
 * the scope and a long date, and in a 330px cockpit it was the part cut off
 * — the one number the user was scrubbing for (owner, 2026-10-13).
 *
 * *Chart* in the Spend header picks it over the three figures (owner,
 * 2026-10-12: "you can choose what you see — the chart or the numbers").
 * The session's own chart is its calls summed by time; a Caprock-wide
 * period's is the summary's sparks, summed by the caller.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { api, type Event } from '@/lib/api'
import { barLabel, barLabelShort, callsFromEvents, callsFromSeries, mergeCalls, stepText, timeBars, topTools, type CallPoint } from '@/lib/scrub'
import { CHART_METRICS, barValue, chartValueText, type ChartMetric, type SpendBar } from '@/lib/spendview'

/** The bars' height: with the top line and the axis, the chart stays under 96px. */
const BARS_H = 56

/** One stretch, and what its calls did when the source says. */
export interface ChartBar extends SpendBar {
  detail?: string
}

/** The bars' values for a metric, and the largest; `known` is false when the source carries none of it. */
export function barValues(bars: readonly SpendBar[], metric: ChartMetric): { values: (number | undefined)[]; max: number; known: boolean } {
  const values = bars.map((b) => barValue(metric, b))
  const known = values.some((v) => v !== undefined)
  const max = Math.max(...values.map((v) => v ?? 0), 0)
  return { values, max, known }
}

/** The bars alone, as a strip `height` pixels tall: the chart's own drawing, and the folded strip's. */
export function SpendBars({ bars, metric, height, at }: { bars: readonly SpendBar[]; metric: ChartMetric; height: number; at?: number }) {
  const { values, max } = barValues(bars, metric)
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${bars.length} ${height}`} preserveAspectRatio="none" className="block" aria-hidden>
      {bars.map((b, i) => {
        const v = values[i] ?? 0
        const h = v > 0 && max > 0 ? Math.max(2, (v / max) * (height - 2)) : 1
        const o = i === at ? 1 : v <= 0 ? 0.25 : at === undefined ? 0.7 : 0.45
        return <rect key={b.start} x={i + 0.12} y={height - h} width={0.76} height={h} className={v > 0 ? 'fill-accent' : 'fill-fg-faint'} opacity={o} data-active={i === at || undefined} />
      })}
    </svg>
  )
}

/** A period by time as bars, in flow, as wide as the cockpit. */
export function SpendChart({ id, bars, step, now, total, scope, metric = 'cost', chooser }: {
  id: string
  bars: readonly ChartBar[]
  step: number
  now: number
  /** The period's own figure for the metric, on the top line; undefined leaves it out. */
  total?: number
  /** Whose money and when: "this session", "7 days · all sessions". */
  scope: string
  metric?: ChartMetric
  /** The ▾ that picks the metric, drawn after the total at rest. */
  chooser?: ReactNode
}) {
  const { values, max, known } = barValues(bars, metric)
  const name = CHART_METRICS.find((m) => m.id === metric)!.name.toLowerCase()
  const lastSpent = values.reduce<number>((m, v, i) => ((v ?? 0) > 0 ? i : m), Math.max(0, bars.length - 1))
  // The stretch being read: under the pointer or stepped to; undefined at rest.
  const [cursor, setCursor] = useState<number | undefined>(undefined)
  useEffect(() => { setCursor(undefined) }, [id])
  const at = cursor === undefined ? undefined : Math.min(cursor, Math.max(0, bars.length - 1))
  const bar = at === undefined ? undefined : bars[at]

  const box = useRef<HTMLDivElement>(null)
  const pick = (clientX: number) => {
    const el = box.current
    if (!el || bars.length === 0) return
    const r = el.getBoundingClientRect()
    if (!(r.width > 0)) return
    setCursor(Math.max(0, Math.min(bars.length - 1, Math.floor(((clientX - r.left) / r.width) * bars.length))))
  }
  const onKey = (e: KeyboardEvent) => {
    const d = e.code === 'ArrowLeft' ? -1 : e.code === 'ArrowRight' ? 1 : 0
    if (!d) return
    // The first step from rest lands on the newest stretch with any.
    setCursor(at === undefined ? lastSpent : Math.max(0, Math.min(bars.length - 1, at + d)))
    e.preventDefault()
  }

  const totalText = chartValueText(metric, total)
  const big = 'num shrink-0 text-[15px] font-semibold leading-[18px] tracking-[-0.02em] text-fg'
  // The top line at rest: the figure, the ▾ that picks it, whose it is.
  const rest = (
    <>
      {total !== undefined && <span data-spend-total className={big}>{totalText}</span>}
      {chooser}
      <span className="ml-auto min-w-0 truncate text-right text-[11px] text-fg-faint" title={scope}>{scope}</span>
    </>
  )
  if (bars.length === 0 || !known || max <= 0) {
    const why = !known && bars.length > 0
      ? `No ${name} by time from this daemon: update Caprock to draw it.`
      : metric !== 'cost' ? `Nothing to draw, ${scope}.` : total !== undefined && total > 0 ? 'No spend by time to draw for this period.' : `Nothing spent, ${scope}.`
    return (
      <div id={id} data-spend-time data-spend-empty data-metric={metric} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1">
        <div className="relative flex min-w-0 items-baseline gap-1.5">{rest}</div>
        <p className="text-[12px] text-fg-muted">{why}</p>
      </div>
    )
  }
  const value = at === undefined ? undefined : values[at]
  const said = bar ? [barLabel(bar, step, now), chartValueText(metric, value), bar.detail].filter(Boolean).join(' · ') : ''
  const tick = (b: ChartBar) => barLabel(b, step, now).replace(/–.*$/, '').replace(/^Today (?=\d)/, '')
  return (
    // In flow: no overlay, nothing positioned; min-w-0 down the chain, since a
    // grid's auto track grows to its widest line (owner, 2026-10-12).
    <div id={id} data-spend-time data-metric={metric} role="group" aria-label={`${metric === 'cost' ? 'Spend' : CHART_METRICS.find((m) => m.id === metric)!.name} by ${step ? stepText(step) : 'time'}, ${scope}`} tabIndex={0} onKeyDown={onKey}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setCursor(undefined) }}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 rounded-[6px] outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
      {/* One line, one height, either way: the figure never shares its room
        * with anything that can push it out. */}
      <div className="relative flex min-h-[18px] min-w-0 items-baseline gap-1.5">
        {bar ? (
          <>
            <span data-spend-readout className={big} title={said} aria-label={said}>{chartValueText(metric, value)}</span>
            <span className="num shrink-0 whitespace-nowrap text-[11.5px] text-fg-muted">{barLabelShort(bar, step, now)}</span>
            {total !== undefined && (
              <span className="num ml-auto min-w-0 truncate text-right text-[11px] text-fg-faint">of {totalText}</span>
            )}
          </>
        ) : rest}
      </div>
      <div ref={box} className="relative min-w-0 cursor-pointer border-b border-[var(--app-hairline)]" style={{ height: BARS_H }}
        onPointerMove={(e) => { if (e.pointerType === 'mouse' && e.buttons === 0) pick(e.clientX) }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') setCursor(undefined) }}
        onPointerDown={(e) => pick(e.clientX)}>
        <SpendBars bars={bars} metric={metric} height={BARS_H} at={at} />
      </div>
      {bars.length > 1 && (
        <div className="num flex min-w-0 justify-between gap-2 text-[10.5px] leading-[12px] text-fg-faint">
          <span className="truncate">{tick(bars[0]!)}</span>
          <span className="truncate">{tick(bars[bars.length - 1]!)}</span>
        </div>
      )}
    </div>
  )
}

/**
 * The session's bars by time. Its calls are read in full once per session;
 * the held events add what came since. Undefined until there is a call.
 */
export function useSessionBars(sessionId: string, events: readonly Event[]): { step: number; bars: ChartBar[] } {
  const held = useMemo(() => callsFromEvents(events), [events])
  const [series, setSeries] = useState<CallPoint[] | undefined>(undefined)
  useEffect(() => {
    let alive = true
    setSeries(undefined)
    api.sessionCalls(sessionId)
      .then((list) => { if (alive && Array.isArray(list)) setSeries(callsFromSeries(list)) })
      .catch(() => { /* an older daemon: the held calls are what there is */ })
    return () => { alive = false }
  }, [sessionId])
  const calls = useMemo(() => (series ? mergeCalls(series, held) : held), [series, held])
  return useMemo(() => {
    const t = timeBars(calls)
    return {
      step: t.step,
      bars: t.bars.map((b): ChartBar => ({
        start: b.start, end: b.end, cost: b.cost, tokens: b.tokens, turns: b.calls,
        detail: b.calls === 0 ? 'nothing ran' : [`${b.calls} ${b.calls === 1 ? 'call' : 'calls'}`, topTools(b)].filter(Boolean).join(' · '),
      })),
    }
  }, [calls])
}

/** The session's chart. */
export function SpendOverTime({ sessionId, events, now, total, metric = 'cost', chooser }: {
  sessionId: string; events: readonly Event[]; now: number; total?: number; metric?: ChartMetric; chooser?: ReactNode
}) {
  const { step, bars } = useSessionBars(sessionId, events)
  if (bars.length === 0) {
    return <p id={`spend-time-${sessionId}`} data-spend-time data-spend-empty className="text-[12px] text-fg-muted">No priced calls yet.</p>
  }
  return <SpendChart id={`spend-time-${sessionId}`} bars={bars} step={step} now={now} total={total} scope="this session" metric={metric} chooser={chooser} />
}
