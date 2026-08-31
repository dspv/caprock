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
import { buildPulse, costTier, medianCost, trackState, windowCost, windowEvents, PULSE_MINUTES, type Pulse as PulseModel } from '@/lib/pulse'
import { fmtAgo, fmtUSD, shortId } from '@/lib/format'
import { Panel } from '@/components/ui'
import { href, navigate } from '@/lib/router'

/** How many tracks to show. More than this and no single one is readable. */
const MAX_TRACKS = 6

/** Events pulled per session to seed a track. At ~33 events/minute in a busy
 * session, an hour needs about two thousand. */
const SEED_LIMIT = 2000

export function PulsePanel({ sessions, now }: { sessions: SessionSummary[]; now: number }) {
  // Newest first — the tracks people care about are the ones running. Ended
  // sessions are dropped here rather than relying on the caller's filter: the
  // Now screen offers a "show ended" tick, and a finished session has no
  // pulse to show whether or not the list it came from includes it.
  const tracked = useMemo(
    () =>
      [...sessions]
        .filter((s) => s.status !== 'ended')
        .sort((a, b) => b.last_event_at - a.last_event_at)
        .slice(0, MAX_TRACKS),
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

  // `now` is rounded to the minute so a per-second clock does not rebuild
  // every model each tick.
  const minute = Math.floor(now / 60_000)
  // A track earns its row by having happened. Without this the panel drew a
  // row per known session — six identical project names over six flat
  // hairlines — which reads as a fault in the chart rather than as silence.
  const rows = useMemo(
    () =>
      tracked
        .map((s) => ({ s, pulse: buildPulse(events.get(s.session_id) ?? [], minute * 60_000) }))
        .filter((r) => windowEvents(r.pulse) > 0),
    [tracked, events, minute],
  )

  if (tracked.length === 0) return null

  return (
    <Panel
      title="Live pulse"
      right={<span className="text-[11px] text-fg-faint">last {PULSE_MINUTES} minutes · one bar per minute</span>}
    >
      <div>
        {rows.length === 0 ? (
          // Saying the hour was quiet is information; six empty tracks are not.
          <div className="px-3 py-6 text-[12px] text-fg-faint text-center">
            Nothing ran in the last {PULSE_MINUTES} minutes.
          </div>
        ) : (
          rows.map(({ s, pulse }) => (
            <Track key={s.session_id} s={s} pulse={pulse} minute={minute} showId={rows.length > 1} />
          ))
        )}
      </div>
      {/* Height and colour answer different questions, and saying so first is
        * the difference between a legend and a decoration. The tier words are
        * relative to this session's own median minute — "expensive" next to a
        * short bar is not a contradiction, it is a quiet minute that spent a
        * lot of context — so they name the comparison rather than implying an
        * absolute scale. */}
      <div className="px-3 py-2 flex items-center gap-4 flex-wrap text-[11px] text-fg-faint border-t border-border">
        <span className="text-fg-muted" title="They are independent: one call carrying a large context is a short bright bar, twenty greps are a tall dark one.">bar height = turns and tools · colour = what the minute cost</span>
        <span className="flex items-center gap-1.5">
          <Swatch tier={IDLE_TOKEN} className="h-[2px]" />idle
        </span>
        <span className="flex items-center gap-1.5">
          <Swatch tier={TIER_TOKEN.low} />below this session&apos;s median
        </span>
        <span className="flex items-center gap-1.5">
          <Swatch tier={TIER_TOKEN.mid} />around it
        </span>
        <span className="flex items-center gap-1.5">
          <Swatch tier={TIER_TOKEN.high} />well above it
        </span>
        <span className="ml-auto">
          <span className="text-warn">×N same call</span> = most-repeated identical tool call in six minutes
        </span>
      </div>
    </Panel>
  )
}

/**
 * A colour chip, so the legend shows the colour rather than naming it.
 *
 * It is driven by the same token+alpha the canvas paints with, so the legend
 * cannot drift from the bars: the idle swatch used to be hardcoded at alpha
 * 0.35 while the canvas drew the hairline at 0.16, and the tier swatches were
 * three more copies of the dark-theme rgba that the light theme flattened.
 */
function Swatch({
  tier,
  className = '',
}: {
  tier: { token: string; fallback: string; alpha: number }
  className?: string
}) {
  return (
    <span
      data-token={tier.token}
      className={`inline-block w-3 h-3 rounded-[2px] ${className}`}
      style={{ background: `var(${tier.token}, ${tier.fallback})`, opacity: tier.alpha }}
    />
  )
}

function Track({
  s,
  pulse,
  minute,
  showId,
}: {
  s: SessionSummary
  pulse: PulseModel
  minute: number
  /** Whether to name which session this is. See the header below. */
  showId: boolean
}) {
  // Health comes from the daemon's narrator, which knows "your turn" from the
  // agent.stop event. The bars cannot: they describe the hour, not this moment.
  const state = trackState(pulse, s.activity?.health)
  const stateCls =
    state.kind === 'repeat' || state.kind === 'waiting'
      ? 'text-warn'
      : state.kind === 'error'
        ? 'text-danger'
        : state.kind === 'quiet'
          ? 'text-fg-faint'
          : 'text-ok'

  return (
    <a
      href={href({ name: 'session', id: s.session_id })}
      className="grid grid-cols-[132px_1fr_92px_104px] items-center gap-3 px-3 py-2 border-t border-border first:border-t-0 hover:bg-panel-2 no-underline text-fg"
    >
      {/* Working all day in one repository used to draw six rows all labelled
        * "caprock", told apart only by a phrase like "was responding" that
        * three of them shared. The branch and the session id are what actually
        * differ, so they go where the eye already is. Only when there is more
        * than one track: a lone row needs no disambiguation.
        *
        * The project never shrinks and the branch is what gives way, because
        * the first attempt had it backwards: `shrink-0` on the branch let a
        * long one (`fix/session-end-and-pulse-tracks`) squeeze the project to
        * nothing, so the row lost the name it is actually about and read as a
        * branch floating with no repository. A label that can erase the
        * primary identity is worse than no label. */}
      <div className="min-w-0">
        <div className="text-[13px] font-medium flex items-baseline gap-1.5 min-w-0">
          <span className="shrink-0">{s.project || 'unknown project'}</span>
          {s.git_branch && (
            <span className="min-w-0 truncate text-[10px] text-fg-faint mono" title={s.git_branch}>
              {s.git_branch}
            </span>
          )}
          {s.agent === 'opencode' && (
            <span className="shrink-0 text-[9px] uppercase tracking-[0.08em] text-fg-faint border border-border px-1 rounded-sm">
              oc
            </span>
          )}
        </div>
        <div className="text-[10px] text-fg-faint mono truncate">
          {showId && <span title={`session ${s.session_id} · started ${fmtAgo(s.started_at)} ago`}>{shortId(s.session_id)} · </span>}
          {s.activity?.phrase ?? ''}
        </div>
      </div>
      <PulseCanvas pulse={pulse} now={minute * 60_000} sessionID={s.session_id} />
      {/* The window's cost, not the session's. The bars describe an hour; a
        * lifetime figure beside them invited the reader to add a number to a
        * picture it does not belong to. */}
      <div
        className="num text-[13px] font-semibold text-right"
        title={`${fmtUSD(s.stats?.cost_usd)} for the whole session`}
      >
        {fmtUSD(windowCost(pulse))}
      </div>
      <div className={`text-[11px] text-right ${stateCls}`} title={pulse.repeatSample}>
        {state.label}
      </div>
    </a>
  )
}

/**
 * Bar colours by cost tier, as a design token plus the alpha it is drawn at.
 *
 * These used to be hardcoded rgba lifted from the *dark* palette, which made
 * the light theme unreadable: `mid` (#feb157 at 0.72) and `high` (#ffcb85 at
 * 0.95) composite against a white panel to a contrast ratio of 1.05 — the same
 * orange to any eye — so the legend named a distinction a light-theme viewer
 * could not see. Every bar was also near-invisible on white (1.46–1.68 against
 * the panel). Reading the tokens instead lets each theme supply its own hue:
 * on dark the tiers climb in brightness, on light they climb in depth, because
 * light's --color-accent-strong is *darker* than --color-accent, not lighter.
 *
 * The alphas are per tier rather than shared: they are what separates two tiers
 * drawn from neighbouring hues, and they were tuned against the composited
 * contrast in both themes (worst-case adjacent-tier ratio 1.59, against 1.05
 * before). Alpha is applied via globalAlpha rather than baked into the colour
 * string, because the tokens are opaque hex — the same approach SparkCanvas in
 * Projects.tsx uses.
 */
export const TIER_TOKEN = {
  low: { token: '--color-ok', fallback: '#4fbf6b', alpha: 0.55 },     // a cheap minute
  mid: { token: '--color-accent', fallback: '#feb157', alpha: 0.85 }, // typical
  high: { token: '--color-accent-strong', fallback: '#ffcb85', alpha: 1 }, // expensive
} as const

/** A minute with no events still draws a hairline, so the track reads as a
 * continuous hour with quiet stretches rather than as a broken chart. Gaps in
 * a bar chart look like a rendering fault; a flat floor looks like silence.
 *
 * It is deliberately the faintest thing on the track — present, never competing
 * with a real bar — which is a ratio to the panel, not a fixed grey: the old
 * fixed value sat at 1.13 against a white panel and disappeared. */
export const IDLE_TOKEN = { token: '--color-fg-faint', fallback: '#837f78', alpha: 0.3 } as const

/** Resolve a design token against an element, with the dark-theme value as the
 * fallback for the brief moment before the stylesheet has applied. */
function token(css: CSSStyleDeclaration, name: string, fallback: string): string {
  return css.getPropertyValue(name).trim() || fallback
}

function PulseCanvas({ pulse, now, sessionID }: { pulse: PulseModel; now: number; sessionID: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [hover, setHover] = useState<number | null>(null)

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

      // Tokens from the stylesheet, so the track follows the theme. A canvas
      // cannot use a CSS variable directly, so they are resolved once per paint
      // against the element itself.
      const css = getComputedStyle(cv)
      const idle = token(css, IDLE_TOKEN.token, IDLE_TOKEN.fallback)

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
          ctx.globalAlpha = IDLE_TOKEN.alpha
          ctx.fillStyle = idle
          ctx.fillRect(x, h - 2, width, 2)
          continue
        }
        // Gamma: a quiet minute beside a busy one would otherwise be invisible,
        // and "almost nothing happened" is exactly what you want to see.
        const bh = Math.max(3, Math.pow(b.n / max, 0.62) * (h - 4))
        const tier = TIER_TOKEN[costTier(b.cost, median)]
        ctx.globalAlpha = tier.alpha
        ctx.fillStyle = token(css, tier.token, tier.fallback)
        ctx.fillRect(x, h - bh, width, bh)
      }
      ctx.globalAlpha = 1
    }
    paint()
    // Repaint on resize, and on a theme change — the colours are read from the
    // stylesheet at paint time, so without this a track keeps the old theme's
    // palette until its data next changes.
    const ro = new ResizeObserver(paint)
    ro.observe(cv)
    const mo = new MutationObserver(paint)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [pulse])

  // A minute is a small target, so the readout follows the pointer rather than
  // requiring a hit on the bar itself: hovering a silent minute is a legitimate
  // question ("was anything happening here?") and must answer it too.
  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    if (r.width === 0) return
    const i = Math.floor(((e.clientX - r.left) / r.width) * pulse.bars.length)
    setHover(i >= 0 && i < pulse.bars.length ? i : null)
  }

  const bar = hover === null ? null : pulse.bars[hover]
  // The colour is a comparison, so the readout states what it compares to.
  // Without it "expensive" on a short bar looks like a bug rather than a
  // quiet minute that carried a lot of context.
  const barMedian = medianCost(pulse.bars)
  const at = hover === null ? 0 : now - (pulse.bars.length - 1 - hover) * 60_000

  // Clicking a minute opens the session *at that minute* rather than at the
  // top. Landing in a session of thousands of events with no indication of
  // which ones you clicked is the same as not having clicked anything.
  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (hover === null || !bar || bar.n === 0) return
    e.preventDefault()
    e.stopPropagation()
    navigate({ name: 'session', id: sessionID, at })
  }

  return (
    <div className="relative">
      <canvas
        ref={ref}
        className="w-full h-[44px] block cursor-pointer"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onClick={onClick}
        aria-hidden
      />
      {bar && (
        <div className="absolute -top-1 left-0 right-0 pointer-events-none flex justify-center">
          <span className="num text-[10px] bg-panel-2 border border-border-strong rounded-sm px-1.5 py-0.5 text-fg-muted whitespace-nowrap">
            {new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {bar.n === 0 ? (
              ' · nothing happened'
            ) : (
              <>
                {` · ${bar.n} event${bar.n === 1 ? '' : 's'}`}
                {bar.turns > 0 && ` · ${bar.turns} turn${bar.turns === 1 ? '' : 's'}`}
                {bar.cost > 0 && ` · ${fmtUSD(bar.cost)}`}
                {bar.cost > 0 && barMedian > 0 && (
                  <span className="text-fg-faint">{` (median ${fmtUSD(barMedian)})`}</span>
                )}
                <span className="text-fg-faint"> · click to open</span>
              </>
            )}
          </span>
        </div>
      )}
    </div>
  )
}
