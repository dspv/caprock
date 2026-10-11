/**
 * The cockpit's spend spark and what it opens (.ai/04-ui.md § Inspector): the
 * small bar-per-call spark beside *Spent this session* opens, on a click, a
 * card over the whole block with the session's spend by time. Moving across
 * it (or ←/→) reads a stretch: when, what it cost, how many calls, which
 * tools. Model in lib/scrub.ts.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { api, type Event } from '@/lib/api'
import { barLabel, callsFromEvents, callsFromSeries, mergeCalls, stepText, timeBars, topTools, type CallPoint } from '@/lib/scrub'
import { fmtUSD } from '@/lib/format'

const SPARK_TURNS = 28
const CHART_H = 64

/**
 * The small spark (the newest calls) and, once clicked, the session's spend by
 * time over the section it sits in. It was a bar per model call read on
 * hover, with token counts (owner, 2026-10-11: "not informative and not
 * convenient"); now the bars follow the clock, a click keeps it open, and the
 * readout says what a stretch cost, how many calls and which tools.
 */
export function SpendSpark({ sessionId, events, now }: { sessionId: string; events: readonly Event[]; now: number }) {
  const held = useMemo(() => callsFromEvents(events), [events])
  const [open, setOpen] = useState(false)
  const [series, setSeries] = useState<CallPoint[] | undefined>(undefined)
  const box = useRef<HTMLDivElement>(null)

  // The whole series is read each time it opens; the held events add what came since.
  useEffect(() => {
    if (!open) return
    let alive = true
    api.sessionCalls(sessionId)
      .then((list) => { if (alive && Array.isArray(list)) setSeries(callsFromSeries(list)) })
      .catch(() => { /* an older daemon: the held calls are what there is */ })
    return () => { alive = false }
  }, [open, sessionId])
  useEffect(() => { setSeries(undefined); setOpen(false) }, [sessionId])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown, true); window.removeEventListener('keydown', onKey) }
  }, [open])

  const calls = useMemo(() => (series ? mergeCalls(series, held) : held), [series, held])
  const { step, bars } = useMemo(() => timeBars(calls), [calls])
  const max = Math.max(...bars.map((b) => b.cost), 0.0001)
  const peak = bars.reduce((m, b, i) => (b.cost > (bars[m]?.cost ?? 0) ? i : m), 0)
  const lastSpent = bars.reduce((m, b, i) => (b.calls > 0 ? i : m), 0)
  const [cursor, setCursor] = useState<number | undefined>(undefined)
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
    const d = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
    if (d) { setCursor(Math.max(0, Math.min(bars.length - 1, at + d))); e.preventDefault() }
  }

  const small = held.slice(-SPARK_TURNS)
  return (
    <div ref={box} className="contents">
      <button
        type="button"
        disabled={held.length < 2}
        aria-expanded={open}
        aria-label="Spend over time"
        title="Click for this session's spend over time"
        onClick={() => { setCursor(undefined); setOpen((o) => !o) }}
        className="mb-[3px] shrink-0 cursor-pointer rounded-[3px] outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] disabled:cursor-default"
      >
        <TurnSpark turns={small} />
      </button>
      <div
        role="dialog"
        aria-label="Spend over time"
        aria-hidden={!open}
        data-open={open}
        tabIndex={-1}
        onKeyDown={onKey}
        className="cockpit-scrub absolute inset-x-0 top-0 z-20 grid gap-2 rounded-[11px] border border-[var(--app-hairline)] bg-[var(--app-chrome-bg)] px-3 pb-3 pt-2.5 shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)]"
      >
        <div className="flex items-center gap-2">
          <span className="shrink-0 whitespace-nowrap text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-faint">Spend by {step ? stepText(step) : 'time'}</span>
          {bars[peak] && bars[peak]!.cost > 0 && (
            <button type="button" onClick={() => setCursor(peak)} className="num ml-auto truncate text-[11px] text-fg-muted hover:text-fg" title="The stretch that cost the most">
              peak {barLabel(bars[peak]!, step, now).replace(/–.*$/, '').replace(/^Today /, '')} · {fmtUSD(bars[peak]!.cost)}
            </button>
          )}
          <button type="button" aria-label="Close" onClick={() => setOpen(false)} className={`${bars[peak]?.cost ? '' : 'ml-auto'} grid h-5 w-5 place-items-center rounded text-fg-faint hover:text-fg`}>×</button>
        </div>
        {bar && (
          <div className="grid gap-0.5" data-spend-readout>
            <div className="flex items-baseline gap-2">
              <span className="truncate text-[12.5px] text-fg-muted">{barLabel(bar, step, now)}</span>
              <span className="num ml-auto text-[22px] font-semibold leading-none tracking-[-0.02em] text-fg">{fmtUSD(bar.cost)}</span>
            </div>
            <p className="num truncate text-[12px] text-fg-muted">
              {bar.calls === 0 ? 'nothing ran' : [`${bar.calls} ${bar.calls === 1 ? 'call' : 'calls'}`, topTools(bar)].filter(Boolean).join(' · ')}
            </p>
          </div>
        )}
        <div ref={chart} className="relative cursor-pointer" style={{ height: CHART_H }}
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
          <div className="num flex justify-between text-[10.5px] text-fg-faint">
            <span>{barLabel(bars[0]!, step, now).replace(/–.*$/, '')}</span>
            <span>{barLabel(bars[bars.length - 1]!, step, now).replace(/–.*$/, '')}</span>
          </div>
        )}
      </div>
    </div>
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
