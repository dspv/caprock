/**
 * The cockpit's spend chart (.ai/04-ui.md § Inspector): a period's spend as
 * bars across the cockpit, the period's total on its top line. Hovering a
 * bar (or ←/→) reads that stretch: its cost takes the big figure's place,
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
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { api, type Event } from '@/lib/api'
import { barLabel, barLabelShort, callsFromEvents, callsFromSeries, mergeCalls, stepText, timeBars, topTools, type CallPoint } from '@/lib/scrub'
import type { SpendBar } from '@/lib/spendview'
import { fmtUSD } from '@/lib/format'

/** The bars' height: with the top line and the axis, the chart stays under 96px. */
const BARS_H = 56

/** One stretch, and what its calls did when the source says. */
export interface ChartBar extends SpendBar {
  detail?: string
}

/** A period's spend as bars, in flow, as wide as the cockpit. */
export function SpendChart({ id, bars, step, now, total, scope }: {
  id: string
  bars: readonly ChartBar[]
  step: number
  now: number
  /** The period's total, on the top line; undefined leaves it out. */
  total?: number
  /** Whose money and when: "this session", "7 days · all sessions". */
  scope: string
}) {
  const max = Math.max(...bars.map((b) => b.cost), 0)
  const lastSpent = bars.reduce((m, b, i) => (b.cost > 0 ? i : m), Math.max(0, bars.length - 1))
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
    // The first step from rest lands on the newest stretch with spend.
    setCursor(at === undefined ? lastSpent : Math.max(0, Math.min(bars.length - 1, at + d)))
    e.preventDefault()
  }

  if (bars.length === 0 || max <= 0) {
    return (
      <p id={id} data-spend-time data-spend-empty className="text-[12px] text-fg-muted">
        {total !== undefined && total > 0 ? 'No spend by time to draw for this period.' : `Nothing spent, ${scope}.`}
      </p>
    )
  }
  const said = bar ? [barLabel(bar, step, now), fmtUSD(bar.cost), bar.detail].filter(Boolean).join(' · ') : ''
  const tick = (b: ChartBar) => barLabel(b, step, now).replace(/–.*$/, '').replace(/^Today (?=\d)/, '')
  const big = 'num shrink-0 text-[15px] font-semibold leading-[18px] tracking-[-0.02em] text-fg'
  return (
    // In flow: no overlay, nothing positioned; min-w-0 down the chain, since a
    // grid's auto track grows to its widest line (owner, 2026-10-12).
    <div id={id} data-spend-time role="group" aria-label={`Spend by ${step ? stepText(step) : 'time'}, ${scope}`} tabIndex={0} onKeyDown={onKey}
      onBlur={() => setCursor(undefined)}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 rounded-[6px] outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
      {/* One line, one height, either way: the figure never shares its room
        * with anything that can push it out. */}
      <div className="flex min-w-0 items-baseline gap-1.5">
        {bar ? (
          <>
            <span data-spend-readout className={big} title={said} aria-label={said}>{fmtUSD(bar.cost)}</span>
            <span className="num shrink-0 whitespace-nowrap text-[11.5px] text-fg-muted">{barLabelShort(bar, step, now)}</span>
            {total !== undefined && <span className="num ml-auto min-w-0 truncate text-right text-[11px] text-fg-faint">of {fmtUSD(total)}</span>}
          </>
        ) : (
          <>
            {total !== undefined && <span data-spend-total className={big}>{fmtUSD(total)}</span>}
            <span className="min-w-0 truncate text-[11px] text-fg-faint" title={scope}>{scope}</span>
          </>
        )}
      </div>
      <div ref={box} className="relative min-w-0 cursor-pointer border-b border-[var(--app-hairline)]" style={{ height: BARS_H }}
        onPointerMove={(e) => { if (e.pointerType === 'mouse' && e.buttons === 0) pick(e.clientX) }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') setCursor(undefined) }}
        onPointerDown={(e) => pick(e.clientX)}>
        <svg width="100%" height={BARS_H} viewBox={`0 0 ${bars.length} ${BARS_H}`} preserveAspectRatio="none" className="block" aria-hidden>
          {bars.map((b, i) => {
            const h = b.cost > 0 ? Math.max(2, (b.cost / max) * (BARS_H - 2)) : 1
            const o = i === at ? 1 : b.cost <= 0 ? 0.25 : at === undefined ? 0.7 : 0.45
            return <rect key={b.start} x={i + 0.12} y={BARS_H - h} width={0.76} height={h} className={b.cost > 0 ? 'fill-accent' : 'fill-fg-faint'} opacity={o} data-active={i === at || undefined} />
          })}
        </svg>
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

/** The session's spend by time. Read in full each time it is shown; the held events add what came since. */
export function SpendOverTime({ sessionId, events, now, total }: { sessionId: string; events: readonly Event[]; now: number; total?: number }) {
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
  const { step, bars } = useMemo(() => {
    const t = timeBars(calls)
    return {
      step: t.step,
      bars: t.bars.map((b): ChartBar => ({
        start: b.start, end: b.end, cost: b.cost,
        detail: b.calls === 0 ? 'nothing ran' : [`${b.calls} ${b.calls === 1 ? 'call' : 'calls'}`, topTools(b)].filter(Boolean).join(' · '),
      })),
    }
  }, [calls])
  if (bars.length === 0) {
    return <p id={`spend-time-${sessionId}`} data-spend-time data-spend-empty className="text-[12px] text-fg-muted">No priced calls yet.</p>
  }
  return <SpendChart id={`spend-time-${sessionId}`} bars={bars} step={step} now={now} total={total} scope="this session" />
}
