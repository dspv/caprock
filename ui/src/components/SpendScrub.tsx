/**
 * The cockpit's *Spend over time* (.ai/04-ui.md § Inspector): a small spark of
 * the newest calls on the disclosure row, and, once that row is opened, the
 * session's spend by time in the flow of the block, as wide as the cockpit.
 * Moving across it (or ←/→) reads a stretch: when, what it cost, how many
 * calls, which tools. Model in lib/scrub.ts.
 *
 * It was a card over the block, opened from the spark with a corner ↗ and a
 * hover hint (owner, 2026-10-12: "it isn't clear what opens, some kind of
 * modal"). Now it is a row that says what it opens and pushes the rest down.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { api, type Event } from '@/lib/api'
import { barLabel, callsFromEvents, callsFromSeries, mergeCalls, stepText, timeBars, topTools, type CallPoint } from '@/lib/scrub'
import { fmtUSD } from '@/lib/format'

const SPARK_TURNS = 28
const CHART_H = 72

/** The session's spend by time, in flow. Read in full each time it is shown; the held events add what came since. */
export function SpendOverTime({ sessionId, events, now }: { sessionId: string; events: readonly Event[]; now: number }) {
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
  const { step, bars } = useMemo(() => timeBars(calls), [calls])
  const max = Math.max(...bars.map((b) => b.cost), 0.0001)
  const peak = bars.reduce((m, b, i) => (b.cost > (bars[m]?.cost ?? 0) ? i : m), 0)
  const lastSpent = bars.reduce((m, b, i) => (b.calls > 0 ? i : m), 0)
  const [cursor, setCursor] = useState<number | undefined>(undefined)
  useEffect(() => { setCursor(undefined) }, [sessionId])
  const at = Math.min(cursor ?? lastSpent, Math.max(0, bars.length - 1))
  const bar = bars[at]

  const chart = useRef<HTMLDivElement>(null)
  const pick = (clientX: number) => {
    const el = chart.current
    if (!el || bars.length === 0) return
    const r = el.getBoundingClientRect()
    setCursor(Math.max(0, Math.min(bars.length - 1, Math.floor(((clientX - r.left) / r.width) * bars.length))))
  }
  const onKey = (e: KeyboardEvent) => {
    const d = e.code === 'ArrowLeft' ? -1 : e.code === 'ArrowRight' ? 1 : 0
    if (d) { setCursor(Math.max(0, Math.min(bars.length - 1, at + d))); e.preventDefault() }
  }

  if (bars.length === 0) {
    return <p id={`spend-time-${sessionId}`} data-spend-time className="text-[12px] text-fg-muted">No priced calls yet.</p>
  }
  return (
    // In flow: no overlay, nothing positioned; min-w-0 down the chain, since a
    // grid's auto track grows to its widest line (owner, 2026-10-12).
    <div id={`spend-time-${sessionId}`} data-spend-time role="group" aria-label="Spend by time" tabIndex={0} onKeyDown={onKey}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-[9px] border border-[var(--app-hairline)] px-2.5 pb-2.5 pt-2 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 whitespace-nowrap text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-faint">By {step ? stepText(step) : 'time'}</span>
        {bars[peak] && bars[peak]!.cost > 0 && (
          <button type="button" onClick={() => setCursor(peak)} className="num ml-auto min-w-0 truncate text-[11.5px] text-fg-muted hover:text-fg" title="The stretch that cost the most">
            peak {barLabel(bars[peak]!, step, now).replace(/–.*$/, '').replace(/^Today /, '')} · {fmtUSD(bars[peak]!.cost)}
          </button>
        )}
      </div>
      {bar && (
        <div className="grid min-w-0 gap-0.5" data-spend-readout>
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate text-[12.5px] text-fg-muted">{barLabel(bar, step, now)}</span>
            <span className="num ml-auto shrink-0 text-[20px] font-semibold leading-none tracking-[-0.02em] text-fg">{fmtUSD(bar.cost)}</span>
          </div>
          <p className="num truncate text-[12px] text-fg-muted">
            {bar.calls === 0 ? 'nothing ran' : [`${bar.calls} ${bar.calls === 1 ? 'call' : 'calls'}`, topTools(bar)].filter(Boolean).join(' · ')}
          </p>
        </div>
      )}
      <div ref={chart} className="min-w-0 cursor-pointer" style={{ height: CHART_H }}
        onPointerMove={(e) => { if (e.pointerType === 'mouse' && e.buttons === 0) pick(e.clientX) }}
        onPointerDown={(e) => pick(e.clientX)}>
        <svg width="100%" height={CHART_H} viewBox={`0 0 ${Math.max(1, bars.length)} ${CHART_H}`} preserveAspectRatio="none" className="block">
          {bars.map((b, i) => {
            const h = b.cost > 0 ? Math.max(2, (b.cost / max) * (CHART_H - 2)) : 1
            return <rect key={b.start} x={i + 0.1} y={CHART_H - h} width={0.8} height={h} className={b.cost > 0 ? 'fill-accent' : 'fill-fg-faint'} opacity={i === at ? 1 : b.cost > 0 ? 0.45 : 0.3} />
          })}
        </svg>
      </div>
      {bars.length > 1 && (
        <div className="num flex min-w-0 justify-between gap-2 text-[10.5px] text-fg-faint">
          <span className="truncate">{barLabel(bars[0]!, step, now).replace(/–.*$/, '')}</span>
          <span className="truncate">{barLabel(bars[bars.length - 1]!, step, now).replace(/–.*$/, '')}</span>
        </div>
      )}
    </div>
  )
}

/** What each of the last calls cost, newest at the right: the disclosure row's preview. */
export function SpendSpark({ events }: { events: readonly Event[] }) {
  const held = useMemo(() => callsFromEvents(events), [events])
  const turns = held.slice(-SPARK_TURNS)
  if (turns.length < 2) return null
  const max = Math.max(...turns.map((t) => t.cost), 0.0001)
  const W = 84, H = 18, gap = 1
  const bw = Math.max(1, (W - gap * (SPARK_TURNS - 1)) / SPARK_TURNS)
  const x0 = W - turns.length * (bw + gap) + gap
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden data-spend-spark className="block shrink-0 overflow-visible">
      {turns.map((t, i) => {
        const h = Math.max(1.5, (t.cost / max) * H)
        const newest = i === turns.length - 1
        return (
          <rect key={t.id} x={x0 + i * (bw + gap)} y={H - h} width={bw} height={h} rx={Math.min(1, bw / 2)}
            className={newest ? 'cockpit-spark-new fill-accent' : 'fill-accent'} opacity={newest ? 1 : 0.28 + 0.5 * (i / turns.length)} />
        )
      })}
    </svg>
  )
}
