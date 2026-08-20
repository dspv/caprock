/**
 * Live pulse — one track per session, one bar per minute.
 *
 * The point is that the picture *is* the data: a bar's height is how much
 * happened in that minute and its colour is what kind of work it was, so the
 * shape of a track is the shape of the work. A task that ramped up and finished
 * draws a bell; steady grinding draws a plateau; working in bursts draws a
 * comb. Nothing is decorative — there is no animation that does not correspond
 * to something the daemon recorded.
 *
 * On drawing: the canvas is repainted only when the data changes, never on a
 * timer. The first version of this ran a requestAnimationFrame loop that
 * repainted every frame and visibly flickered; a dashboard that shimmers while
 * you read it is worse than a still one. The only motion is a CSS pulse on the
 * newest bar, which costs nothing and means "this minute is still filling".
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type Event, type SessionSummary } from '@/lib/api'
import { live } from '@/lib/live'
import { buildPulse, costTier, medianCost, trackState, PULSE_MINUTES, type Pulse as PulseModel } from '@/lib/pulse'
import { fmtUSD } from '@/lib/format'
import { Panel } from '@/components/ui'
import { href } from '@/lib/router'

/** How many tracks to show. More than this and no single one is readable. */
const MAX_TRACKS = 6

/** Events pulled per session to seed a track. At ~33 events/minute in a busy
 * session, an hour needs about two thousand. */
const SEED_LIMIT = 2000

export function PulsePanel({ sessions, now }: { sessions: SessionSummary[]; now: number }) {
  // Newest first — the tracks people care about are the ones running.
  const tracked = useMemo(
    () => [...sessions].sort((a, b) => b.last_event_at - a.last_event_at).slice(0, MAX_TRACKS),
    [sessions],
  )
  const ids = tracked.map((s) => s.session_id).join(',')

  const [events, setEvents] = useState<Map<string, Event[]>>(new Map())

  // Seed from history so a track is never blank on open, then follow the live
  // stream. Only the window's worth is kept: an unbounded array would grow for
  // as long as the tab stays open.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const list = ids ? ids.split(',') : []
      const batches = await Promise.all(list.map((id) => api.recentEvents(id, SEED_LIMIT).catch(() => [] as Event[])))
      if (cancelled) return
      setEvents(new Map(list.map((id, i) => [id, batches[i] ?? []])))
    })()
    return () => {
      cancelled = true
    }
  }, [ids])

  useEffect(() => {
    return live.onFrame((f) => {
      if (f.type !== 'event') return
      const ev = f.data
      setEvents((cur) => {
        if (!cur.has(ev.session_id)) return cur
        const next = new Map(cur)
        const prior = next.get(ev.session_id) ?? []
        // Cap per track: the window only ever renders PULSE_MINUTES of bars.
        next.set(ev.session_id, [...prior, ev].slice(-SEED_LIMIT * 2))
        return next
      })
    })
  }, [])

  if (tracked.length === 0) return null

  return (
    <Panel
      title="Live pulse"
      right={<span className="text-[11px] text-fg-faint">last {PULSE_MINUTES} minutes · one bar per minute</span>}
    >
      <div>
        {tracked.map((s) => (
          <Track key={s.session_id} s={s} events={events.get(s.session_id) ?? []} now={now} />
        ))}
      </div>
      <div className="px-3 py-2 flex items-center gap-4 flex-wrap text-[11px] text-fg-faint border-t border-border">
        <span className="flex items-center gap-1.5">
          <Swatch className="bg-[rgba(169,165,158,0.35)] h-[2px]" />nothing happened
        </span>
        <span className="flex items-center gap-1.5">
          <Swatch className="bg-[rgba(79,191,107,0.62)]" />cheap minute
        </span>
        <span className="flex items-center gap-1.5">
          <Swatch className="bg-[rgba(254,177,87,0.72)]" />typical
        </span>
        <span className="flex items-center gap-1.5">
          <Swatch className="bg-[rgba(255,203,133,0.95)]" />expensive
        </span>
        <span className="text-fg-faint">· bar height = events that minute</span>
        <span className="ml-auto">
          <span className="text-warn">×N same call</span> = most-repeated identical tool call in six minutes
        </span>
      </div>
    </Panel>
  )
}

/** A colour chip, so the legend shows the colour rather than naming it. */
function Swatch({ className }: { className: string }) {
  return <span className={`inline-block w-3 h-3 rounded-[2px] ${className}`} />
}

function Track({ s, events, now }: { s: SessionSummary; events: Event[]; now: number }) {
  // The model is recomputed when events change, not on every render; `now` is
  // rounded to the minute so a per-second clock does not invalidate it.
  const minute = Math.floor(now / 60_000)
  const pulse = useMemo(() => buildPulse(events, minute * 60_000), [events, minute])
  const state = trackState(pulse)
  const stateCls =
    state.kind === 'repeat' ? 'text-warn' : state.kind === 'quiet' ? 'text-fg-faint' : 'text-ok'

  return (
    <a
      href={href({ name: 'session', id: s.session_id })}
      className="grid grid-cols-[132px_1fr_92px_104px] items-center gap-3 px-3 py-2 border-t border-border first:border-t-0 hover:bg-panel-2 no-underline text-fg"
    >
      <div className="min-w-0">
        <div className="text-[13px] font-medium truncate">{s.project || 'unknown project'}</div>
        <div className="text-[10px] text-fg-faint mono truncate">{s.activity?.phrase ?? ''}</div>
      </div>
      <PulseCanvas pulse={pulse} />
      <div className="num text-[13px] font-semibold text-right">{fmtUSD(s.stats?.cost_usd)}</div>
      <div className={`text-[11px] text-right ${stateCls}`} title={pulse.repeatSample}>
        {state.label}
      </div>
    </a>
  )
}

/** Bar colours by cost tier, kept beside the legend that names them. */
const TIER_COLOR = {
  low: 'rgba(79,191,107,0.62)',    // ok green — a cheap minute
  mid: 'rgba(254,177,87,0.72)',    // accent amber — typical
  high: 'rgba(255,203,133,0.95)',  // bright — an expensive minute
} as const

/** A minute with no events still draws a hairline, so the track reads as a
 * continuous hour with quiet stretches rather than as a broken chart. Gaps in
 * a bar chart look like a rendering fault; a flat floor looks like silence. */
const IDLE_COLOR = 'rgba(169,165,158,0.16)'

function PulseCanvas({ pulse }: { pulse: PulseModel }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const paint = () => {
      const w = cv.clientWidth
      const h = cv.clientHeight
      if (w === 0 || h === 0) return
      const dpr = window.devicePixelRatio || 1
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(h * dpr)
      const ctx = cv.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      const bars = pulse.bars
      const max = Math.max(...bars.map((b) => b.n), 1)
      const median = medianCost(bars)
      const bw = w / bars.length
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i]
        if (!b) continue
        const x = i * bw
        const width = Math.max(1, bw - 1)
        if (b.n === 0) {
          // Silence, drawn rather than left blank.
          ctx.fillStyle = IDLE_COLOR
          ctx.fillRect(x, h - 2, width, 2)
          continue
        }
        // Gamma: a quiet minute beside a busy one would otherwise be invisible,
        // and "almost nothing happened" is exactly what you want to see.
        const bh = Math.max(3, Math.pow(b.n / max, 0.62) * (h - 4))
        ctx.fillStyle = TIER_COLOR[costTier(b.cost, median)]
        ctx.fillRect(x, h - bh, width, bh)
      }
    }
    paint()
    // Repaint on resize only — the data itself arrives through the effect deps.
    const ro = new ResizeObserver(paint)
    ro.observe(cv)
    return () => ro.disconnect()
  }, [pulse])

  return <canvas ref={ref} className="w-full h-[44px] block" aria-hidden />
}
