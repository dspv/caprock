/**
 * The cockpit's spend chart (.ai/04-ui.md § Inspector): a period by time as
 * bars across the cockpit, the period's figure on its top line. The bars
 * measure what the viewer picked from the ▾ beside that figure — cost by
 * default, or burn rate, tokens or turns (owner, 2026-10-13: "for some
 * total spend matters more, for some burn rate, someone measures tokens").
 * Hovering a bar (or ←/→) reads that stretch: its figure takes the big
 * figure's place, a short date beside it ("Sun 11 Oct · 06–12") and, at the
 * right, the bar against the pace line ("38% above your usual") or, with no
 * line, "of $total"; leaving the chart puts the total back. At rest no bar
 * is singled out. Model in lib/scrub.ts, pace in lib/usual.ts.
 *
 * The pace line is a faint dashed level for what a stretch usually measures
 * (owner, 2026-10-13: "it's a chart, but it's unclear — pace"), labelled at
 * its right end. Bars above it stand in the stronger tone, bars below in
 * the muted one; amber only for a bar a usual puts in the top fifth of the
 * viewer's own hours, as the headline's own delta does.
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
import { CHART_METRICS, barCarries, barValue, chartValueText, periodBurn, type ChartMetric, type SpendBar } from '@/lib/spendview'
import { barPace, paceLabel, paceOf, paceSentence, paceTitle, type Pace, type Usual } from '@/lib/usual'

/** The bars' height: with the top line and the axis, the chart stays under 96px. */
const BARS_H = 56

/**
 * The top line, at rest and under the pointer alike: a fixed 18px with an
 * 18px line box for whatever inherits, so swapping the total for a bar's
 * figure never moves the bars by a pixel.
 */
const TOP_LINE = 'relative flex h-[18px] min-w-0 items-baseline gap-1.5 text-[11px] leading-[18px]'

/** One stretch, and what its calls did when the source says. */
export interface ChartBar extends SpendBar {
  detail?: string
}

/**
 * The bars' values for a metric, and the largest; `known` is false when the
 * source carries none of it. A pace line taller than every bar raises the
 * scale to it, so the line is always in sight.
 */
export function barValues(bars: readonly SpendBar[], metric: ChartMetric, pace?: Pace): { values: (number | undefined)[]; max: number; known: boolean } {
  const values = bars.map((b) => barValue(metric, b))
  const known = bars.some((b) => barCarries(metric, b))
  const max = Math.max(...values.map((v) => v ?? 0), 0)
  return { values, max: max > 0 && pace ? Math.max(max, pace.value) : max, known }
}

/** How far up a value sits in a strip `height` tall, in pixels from the bottom. */
function levelOf(v: number, max: number, height: number): number {
  return max > 0 ? Math.max(2, (v / max) * (height - 2)) : 1
}

/** The bars alone, as a strip `height` pixels tall, with the pace line when there is one: the chart's own drawing, and the folded strip's. */
export function SpendBars({ bars, metric, height, at, pace }: { bars: readonly SpendBar[]; metric: ChartMetric; height: number; at?: number; pace?: Pace }) {
  const { values, max } = barValues(bars, metric, pace)
  return (
    <span className="relative block" style={{ height }}>
      <svg width="100%" height={height} viewBox={`0 0 ${bars.length} ${height}`} preserveAspectRatio="none" className="block" aria-hidden>
        {bars.map((b, i) => {
          const v = values[i] ?? 0
          const h = v > 0 ? levelOf(v, max, height) : 1
          const where = barPace(values[i], pace)
          const rest = where === undefined ? 0.7 : where === 'below' ? 0.4 : 0.85
          const o = i === at ? 1 : v <= 0 ? 0.25 : at === undefined ? rest : 0.45
          const fill = v <= 0 ? 'fill-fg-faint' : where === 'high' ? 'fill-warn' : 'fill-accent'
          return <rect key={b.start} x={i + 0.12} y={height - h} width={0.76} height={h} className={fill} opacity={o} data-active={i === at || undefined} data-pace={where} />
        })}
      </svg>
      {pace && max > 0 && (
        <span data-pace-line aria-hidden className="pointer-events-none absolute inset-x-0 border-t border-dashed border-fg-muted opacity-60"
          style={{ bottom: levelOf(pace.value, max, height) }} />
      )}
    </span>
  )
}

/** A period by time as bars, in flow, as wide as the cockpit. */
export function SpendChart({ id, bars, step, now, total, scope, metric = 'cost', chooser, usual }: {
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
  /** The viewer's own 30-day baseline, for the burn rate's pace line. */
  usual?: Usual
}) {
  const pace = useMemo(() => paceOf(metric, bars, usual), [metric, bars, usual])
  const { values, max, known } = barValues(bars, metric, pace)
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
      <span className="ml-auto min-w-0 truncate text-right text-[11px] leading-[18px] text-fg-faint" title={scope}>{scope}</span>
    </>
  )
  if (bars.length === 0 || !known || max <= 0) {
    const why = !known && bars.length > 0
      ? `No ${name} by time from this daemon: update Caprock to draw it.`
      : metric === 'burn' ? `No active hour ${scope} (five or more calls in one hour): no rate to draw.`
        : metric !== 'cost' ? `Nothing to draw, ${scope}.` : total !== undefined && total > 0 ? 'No spend by time to draw for this period.' : `Nothing spent, ${scope}.`
    return (
      <div id={id} data-spend-time data-spend-empty data-metric={metric} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1">
        <div data-spend-top className={TOP_LINE}>{rest}</div>
        <p className="text-[12px] text-fg-muted">{why}</p>
      </div>
    )
  }
  const value = at === undefined ? undefined : values[at]
  // What the stretch's figure is against the line, or, for burn, why it has none.
  const vs = paceSentence(value, pace)
  const idle = metric === 'burn' && bar && value === undefined ? 'no active hour' : undefined
  const hours = metric === 'burn' && bar?.activeHours ? `${bar.activeHours} active ${bar.activeHours === 1 ? 'hour' : 'hours'}` : undefined
  const said = bar ? [barLabel(bar, step, now), chartValueText(metric, value), vs, idle ?? hours, bar.detail].filter(Boolean).join(' · ') : ''
  // The line has room for the short form beside the date; the full sentence is the tooltip.
  const right = paceSentence(value, pace, true) ?? idle ?? (total !== undefined && metric !== 'burn' ? `of ${totalText}` : undefined)
  const tick = (b: ChartBar) => barLabel(b, step, now).replace(/–.*$/, '').replace(/^Today (?=\d)/, '')
  const label = pace ? paceLabel(metric, pace) : undefined
  // The label sits on the line at its right end, under it when the line is near the top.
  const lineAt = pace ? levelOf(pace.value, max, BARS_H) : 0
  return (
    // In flow: no overlay, nothing positioned; min-w-0 down the chain, since a
    // grid's auto track grows to its widest line (owner, 2026-10-12).
    <div id={id} data-spend-time data-metric={metric} data-pace={pace?.kind} role="group" aria-label={`${metric === 'cost' ? 'Spend' : CHART_METRICS.find((m) => m.id === metric)!.name} by ${step ? stepText(step) : 'time'}, ${scope}`} tabIndex={0} onKeyDown={onKey}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setCursor(undefined) }}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 rounded-[6px] outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
      {/* One line, one height, either way: the figure never shares its room
        * with anything that can push it out. The line is exactly 18px and
        * everything on it has an 18px line box in an 11px font unless it sets
        * its own: the ▾'s wrapper used to inherit the panel's 16px font and
        * stand the line 23px tall at rest against 19px under the pointer, so
        * the bars and all below them jumped 4px on hover (owner, 2026-10-14). */}
      <div data-spend-top className={TOP_LINE}>
        {bar ? (
          <>
            <span data-spend-readout className={big} title={said} aria-label={said}>{chartValueText(metric, value)}</span>
            <span className="num shrink-0 whitespace-nowrap text-[11.5px] leading-[18px] text-fg-muted">{barLabelShort(bar, step, now)}</span>
            {right && (
              <span data-spend-pace={vs ? barPace(value, pace) : undefined} title={vs} className={`num ml-auto min-w-0 truncate text-right text-[11px] leading-[18px] ${vs && barPace(value, pace) === 'high' ? 'text-warn' : 'text-fg-faint'}`}>{right}</span>
            )}
          </>
        ) : rest}
      </div>
      <div ref={box} data-spend-plot className="relative min-w-0 cursor-pointer border-b border-[var(--app-hairline)]" style={{ height: BARS_H }}
        onPointerMove={(e) => { if (e.pointerType === 'mouse' && e.buttons === 0) pick(e.clientX) }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') setCursor(undefined) }}
        onPointerDown={(e) => pick(e.clientX)}>
        <SpendBars bars={bars} metric={metric} height={BARS_H} at={at} pace={pace} />
        {pace && label && (
          <span data-pace-label title={paceTitle(metric, pace, usual?.days)}
            className="num pointer-events-none absolute right-0 rounded-[3px] bg-[var(--app-chrome-bg)] px-0.5 text-[10px] leading-[12px] text-fg-muted"
            style={lineAt > BARS_H - 14 ? { top: BARS_H - lineAt + 1 } : { bottom: lineAt + 1 }}>
            {label}
          </span>
        )}
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
 * the held events add what came since. Empty until there is a call. For
 * burn rate the bars are an hour at the finest, since the rate is per
 * active hour. `enabled` false reads nothing: the Numbers view has no bars.
 */
export function useSessionBars(sessionId: string, events: readonly Event[], metric: ChartMetric = 'cost', enabled = true): { step: number; bars: ChartBar[]; burn?: number } {
  const held = useMemo(() => (enabled ? callsFromEvents(events) : []), [events, enabled])
  const [series, setSeries] = useState<CallPoint[] | undefined>(undefined)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    setSeries(undefined)
    api.sessionCalls(sessionId)
      .then((list) => { if (alive && Array.isArray(list)) setSeries(callsFromSeries(list)) })
      .catch(() => { /* an older daemon: the held calls are what there is */ })
    return () => { alive = false }
  }, [sessionId, enabled])
  const calls = useMemo(() => (series ? mergeCalls(series, held) : held), [series, held])
  const minStep = metric === 'burn' ? 60 : 0
  return useMemo(() => {
    const t = timeBars(calls, minStep)
    return {
      step: t.step,
      // The session's own dollars per active hour, for the menu and the
      // folded strip, whatever the bars' step: hours, however they are drawn.
      burn: periodBurn(minStep >= 60 ? t.bars : timeBars(calls, 60).bars),
      bars: t.bars.map((b): ChartBar => ({
        start: b.start, end: b.end, cost: b.cost, tokens: b.tokens, turns: b.calls,
        ...(b.activeHours !== undefined ? { activeHours: b.activeHours, activeCost: b.activeCost } : {}),
        detail: b.calls === 0 ? 'nothing ran' : [`${b.calls} ${b.calls === 1 ? 'call' : 'calls'}`, topTools(b)].filter(Boolean).join(' · '),
      })),
    }
  }, [calls, minStep])
}

/** The session's chart. */
export function SpendOverTime({ sessionId, events, now, total, metric = 'cost', chooser, usual }: {
  sessionId: string; events: readonly Event[]; now: number; total?: number; metric?: ChartMetric; chooser?: ReactNode; usual?: Usual
}) {
  const { step, bars } = useSessionBars(sessionId, events, metric)
  return <SessionChart sessionId={sessionId} bars={bars} step={step} now={now} total={total} metric={metric} chooser={chooser} usual={usual} />
}

/** The session's chart from bars already read: "No priced calls yet." until there are some. */
export function SessionChart({ sessionId, bars, step, now, total, metric = 'cost', chooser, usual }: {
  sessionId: string; bars: readonly ChartBar[]; step: number; now: number; total?: number; metric?: ChartMetric; chooser?: ReactNode; usual?: Usual
}) {
  if (bars.length === 0) {
    return <p id={`spend-time-${sessionId}`} data-spend-time data-spend-empty className="text-[12px] text-fg-muted">No priced calls yet.</p>
  }
  return <SpendChart id={`spend-time-${sessionId}`} bars={bars} step={step} now={now} total={total} scope="this session" metric={metric} chooser={chooser} usual={usual} />
}
