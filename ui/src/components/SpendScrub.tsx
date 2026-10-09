/**
 * The cockpit's spend spark and its scrubber (.ai/04-ui.md § Inspector): the
 * small bar-per-call spark beside *Spent this session* opens, on hover, focus
 * or a press, into a card over the whole block that holds every priced call
 * of the session. Moving across it (or ←/→) reads the call under the cursor:
 * when, which model, what it cost, its tokens and the tools it asked for.
 * Model in lib/scrub.ts.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { api, type Event } from '@/lib/api'
import { barAt, bucketCost, bucketize, callsFromEvents, callsFromSeries, mergeCalls, readout, slotsFor, type CallPoint } from '@/lib/scrub'

const SPARK_TURNS = 28
const CHART_H = 64

/** The small spark (the newest calls) and, while open, the scrubber over the section it sits in. */
export function SpendSpark({ sessionId, events, now }: { sessionId: string; events: readonly Event[]; now: number }) {
  const held = useMemo(() => callsFromEvents(events), [events])
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const open = (hover || focus) && !dismissed && held.length >= 2
  const [series, setSeries] = useState<CallPoint[] | undefined>(undefined)

  // The whole series is read each time the scrubber opens; the held events add what came since.
  useEffect(() => {
    if (!open) return
    let alive = true
    api.sessionCalls(sessionId)
      .then((list) => { if (alive && Array.isArray(list)) setSeries(callsFromSeries(list)) })
      .catch(() => { /* an older daemon: the held calls are what there is */ })
    return () => { alive = false }
  }, [open, sessionId])
  useEffect(() => { setSeries(undefined) }, [sessionId])

  const calls = useMemo(() => (series ? mergeCalls(series, held) : held), [series, held])

  const chart = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(280)
  useLayoutEffect(() => {
    const el = chart.current
    if (!el || typeof ResizeObserver !== 'function') return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 280))
    ro.observe(el)
    setWidth(el.clientWidth || 280)
    return () => ro.disconnect()
  }, [])

  const buckets = useMemo(() => bucketize(calls.length, slotsFor(width)), [calls.length, width])
  const sums = useMemo(() => buckets.map((b) => bucketCost(calls, b)), [buckets, calls])
  const max = Math.max(...sums, 0.0001)
  // The cursor is a bar index; undefined follows the newest.
  const [cursor, setCursor] = useState<number | undefined>(undefined)
  const at = cursor === undefined ? buckets.length - 1 : Math.min(cursor, buckets.length - 1)
  const bar = buckets[at]
  const r = open && bar ? readout(calls, bar, now) : undefined

  const close = () => { setHover(false); setCursor(undefined) }
  const moveTo = (clientX: number) => {
    const el = chart.current
    if (!el) return
    const box = el.getBoundingClientRect()
    setCursor(barAt(clientX - box.left, box.width, buckets.length))
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { setDismissed(true); setCursor(undefined); e.stopPropagation(); return }
    if (!open) return
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
    if (step) { setCursor(Math.max(0, Math.min(buckets.length - 1, at + step))); e.preventDefault() }
    else if (e.key === 'Home') { setCursor(0); e.preventDefault() }
    else if (e.key === 'End') { setCursor(buckets.length - 1); e.preventDefault() }
  }
  // A finger presses the spark and drags across the card: the spark keeps the pointer.
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse') return
    setDismissed(false); setHover(true)
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* not capturable: the card's own moves still scrub */ }
    moveTo(e.clientX)
  }
  const onTouchMove = (e: PointerEvent<HTMLDivElement>) => { if (e.pointerType !== 'mouse' && open) moveTo(e.clientX) }
  const onUp = (e: PointerEvent<HTMLDivElement>) => { if (e.pointerType !== 'mouse') close() }

  const small = held.slice(-SPARK_TURNS)
  return (
    <>
      <div
        tabIndex={held.length >= 2 ? 0 : -1}
        role="slider"
        aria-label="Spend per model call: hover, or use the arrow keys, to read each call"
        aria-valuemin={1}
        aria-valuemax={Math.max(1, buckets.length)}
        aria-valuenow={at + 1}
        aria-valuetext={r ? `${r.title}, ${r.cost}${r.when ? `, ${r.when}` : ''}` : undefined}
        className="mb-[3px] shrink-0 cursor-ew-resize touch-none rounded-[3px] outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
        onPointerEnter={(e) => { if (e.pointerType === 'mouse') { setDismissed(false); setHover(true) } }}
        onPointerDown={onDown}
        onPointerMove={onTouchMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onFocus={() => { setDismissed(false); setFocus(true) }}
        onBlur={() => { setFocus(false); setCursor(undefined) }}
        onKeyDown={onKey}
      >
        <TurnSpark turns={small} />
      </div>
      <div
        aria-hidden
        data-open={open}
        className="cockpit-scrub absolute inset-x-0 top-0 z-20 grid gap-1.5 rounded-[11px] border border-[var(--app-hairline)] bg-[var(--app-chrome-bg)] px-3 pb-2.5 pt-2 shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)] touch-none"
        onPointerMove={(e) => { if (e.pointerType === 'mouse') moveTo(e.clientX) }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') close() }}
      >
        <div className="flex items-baseline gap-2">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-faint">{r?.title ?? 'Spend per call'}</span>
          <span className="num ml-auto text-[15px] font-semibold text-fg">{r?.cost}</span>
        </div>
        <div className="grid min-h-[62px] content-start gap-0.5 text-[11.5px] leading-[15px]">
          {(r?.when || r?.model) && (
            <p className="num truncate text-fg-muted">{[r.when, r.model].filter(Boolean).join(' · ')}</p>
          )}
          {r?.tokens && <p className="num text-fg-muted">{r.tokens}</p>}
          {r?.did && <p className="truncate text-fg" title={r.did}>{r.did}</p>}
        </div>
        <div ref={chart} className="relative cursor-ew-resize" style={{ height: CHART_H }}>
          <svg width="100%" height={CHART_H} viewBox={`0 0 ${Math.max(1, width)} ${CHART_H}`} preserveAspectRatio="none" className="block overflow-visible">
            {buckets.map((b, i) => {
              const slot = width / buckets.length
              const h = Math.max(1, ((sums[i] ?? 0) / max) * (CHART_H - 2))
              const on = open && i === at
              return (
                <rect key={b.from} x={i * slot} y={CHART_H - h} width={Math.max(1, slot - (slot > 2.5 ? 1 : 0))} height={h}
                  className="fill-accent" opacity={on ? 1 : 0.42} />
              )
            })}
            {open && at >= 0 && (
              <line x1={(at + 0.5) * (width / buckets.length)} x2={(at + 0.5) * (width / buckets.length)} y1={0} y2={CHART_H}
                className="stroke-fg-muted" strokeWidth={1} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
            )}
          </svg>
        </div>
      </div>
    </>
  )
}

/** What each of the last calls cost, newest at the right. */
function TurnSpark({ turns }: { turns: readonly CallPoint[] }) {
  if (turns.length < 2) return null
  const max = Math.max(...turns.map((t) => t.cost), 0.0001)
  const W = 112, H = 30, gap = 1.5
  const bw = Math.max(1.5, (W - gap * (SPARK_TURNS - 1)) / SPARK_TURNS)
  const x0 = W - turns.length * (bw + gap) + gap
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden className="block overflow-visible">
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
