/**
 * Thoughts arriving (04-ui.md § Second Brain, *Thoughts arriving*; the owner,
 * 2026-10-17, translated: "an animation when thoughts from an open tab go in
 * — so you can see how they get in"). When a memory is added (a `brain`
 * frame, op `added`, which carries its session and project), a spark flies
 * from that session's place on screen — its sidebar row, else its tab in the
 * strip, else its project's row — along a slight curve into the sidebar's
 * Second Brain card, which pulses as it lands. With no place to fly from,
 * the card only pulses.
 *
 * Cheap by construction: one absolutely positioned dot (and two fainter
 * tail dots) per flight, moved by the Web Animations API on transform and
 * opacity, removed when it lands — no React state, no re-render, no layout
 * read but the two boxes at take-off. A burst is coalesced: at most one
 * flight every ARRIVAL_GAP_MS, at most MAX_FLYING in the air, and a queue of
 * MAX_QUEUED, past which a frame is dropped (the card pulses for the burst all
 * the same). Nothing flies under prefers-reduced-motion, while the window
 * is hidden, or with Settings → Second Brain, *Animate thoughts arriving* off.
 */
import { useEffect, useRef, type RefObject } from 'react'
import { brainArrivalsOn, useBrainFrames, type BrainFrame } from '@/lib/brain'

export const ARRIVAL_GAP_MS = 260
export const MAX_FLYING = 3
export const MAX_QUEUED = 4
const FLIGHT_MS = 950

/** Whether an element is drawn and at least partly in the window. */
function onScreen(el: Element): DOMRect | null {
  const r = el.getBoundingClientRect()
  if (r.width < 2 || r.height < 2) return null
  if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) return null
  return r
}

function cssEscape(v: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, '\\$&')
}

/**
 * Where a memory comes from on screen: the session's sidebar row, else its
 * tab in the strip, else its project's sidebar row; null when none of them
 * is drawn.
 */
export function arrivalSource(f: Pick<BrainFrame, 'session' | 'project'>, root: ParentNode = document): Element | null {
  const tries: string[] = []
  if (f.session) {
    const s = cssEscape(f.session)
    tries.push(`[data-tab-row][data-session-id="${s}"]`, `[role="tab"][data-session-id="${s}"]`, `[data-session-id="${s}"]`)
  }
  if (f.project) tries.push(`[data-project-row][data-project-name="${cssEscape(f.project)}"]`)
  for (const sel of tries) {
    for (const el of root.querySelectorAll(sel)) if (onScreen(el)) return el
  }
  return null
}

/** Points along a quadratic curve from a to b, bowed up by `bow`, as transform keyframes. */
export function flightFrames(a: { x: number; y: number }, b: { x: number; y: number }, steps = 12): Keyframe[] {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const bow = Math.min(120, Math.hypot(dx, dy) * 0.28)
  // The control point: the midpoint, pushed sideways off the straight line.
  const len = Math.max(1, Math.hypot(dx, dy))
  const cx = (a.x + b.x) / 2 + (dy / len) * bow
  const cy = (a.y + b.y) / 2 - (dx / len) * bow
  const out: Keyframe[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const u = 1 - t
    const x = u * u * a.x + 2 * u * t * cx + t * t * b.x
    const y = u * u * a.y + 2 * u * t * cy + t * t * b.y
    const scale = t < 0.15 ? 0.4 + t * 4 : t > 0.85 ? 1 - (t - 0.85) * 3 : 1
    out.push({ transform: `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${scale.toFixed(2)})`, opacity: t < 0.1 ? t * 10 : t > 0.92 ? (1 - t) * 12 : 1, offset: t })
  }
  return out
}

/** Where on the card a spark lands: the folded row's glyph, else the orb, else the card's middle. */
function landing(card: HTMLElement): { el: HTMLElement; at: { x: number; y: number } } | null {
  const el = card.querySelector<HTMLElement>('[data-brain-glyph]') ?? card.querySelector<HTMLElement>('[data-brain-card] canvas') ?? card
  const r = onScreen(el)
  if (!r) return null
  return { el, at: { x: r.left + r.width / 2, y: r.top + r.height / 2 } }
}

/** The card's pulse as a spark lands: a ring that spreads and fades, and the glyph swelling once. */
function pulse(card: HTMLElement, glyph: HTMLElement | null) {
  if (typeof card.animate !== 'function') return
  card.animate([
    { boxShadow: '0 0 0 0 color-mix(in srgb, var(--color-accent) 45%, transparent)' },
    { boxShadow: '0 0 0 6px color-mix(in srgb, var(--color-accent) 0%, transparent)' },
  ], { duration: 620, easing: 'ease-out' })
  if (glyph && glyph !== card) {
    glyph.animate([
      { transform: 'scale(1)', color: 'var(--color-accent)', opacity: 1 },
      { transform: 'scale(1.35)', color: 'var(--color-accent)', opacity: 1, offset: 0.35 },
      { transform: 'scale(1)' },
    ], { duration: 560, easing: 'ease-out' })
  }
}

/**
 * Throttles a burst of arrivals: `push` queues one, `next` takes the one
 * due now (or none); the queue never holds more than MAX_QUEUED, and what
 * would overflow it is dropped.
 */
export class ArrivalQueue {
  private q: BrainFrame[] = []
  push(f: BrainFrame) {
    if (this.q.length < MAX_QUEUED) this.q.push(f)
  }
  next(): BrainFrame | undefined { return this.q.shift() }
  get size() { return this.q.length }
}

export function BrainArrivals({ card }: { card: RefObject<HTMLElement | null> }) {
  const queue = useRef(new ArrivalQueue())
  const timer = useRef(0)
  const flying = useRef(0)
  const drain = useRef<() => void>(() => {})
  drain.current = () => {
    timer.current = 0
    const f = queue.current.next()
    if (!f) return
    fly(f)
    if (queue.current.size > 0) timer.current = window.setTimeout(() => drain.current(), ARRIVAL_GAP_MS)
  }
  const fly = (f: BrainFrame) => {
    const c = card.current
    if (!c || document.visibilityState === 'hidden' || !brainArrivalsOn()) return
    const land = landing(c)
    if (!land) return
    const from = arrivalSource(f)
    const r = from ? onScreen(from) : null
    if (!r || flying.current >= MAX_FLYING || typeof document.body.animate !== 'function') { pulse(c, land.el); return }
    // From the row's left part, where its dot and title start.
    const a = { x: r.left + Math.min(24, r.width / 2), y: r.top + r.height / 2 }
    const frames = flightFrames(a, land.at)
    flying.current++
    const dots: HTMLElement[] = []
    for (const [i, alpha] of [[0, 1], [1, 0.6], [2, 0.38], [3, 0.2]] as const) {
      const d = document.createElement('span')
      d.className = 'brain-arrival'
      d.setAttribute('aria-hidden', 'true')
      d.dataset.brainArrival = ''
      if (i > 0) d.dataset.tail = ''
      d.style.opacity = '0'
      document.body.appendChild(d)
      dots.push(d)
      const anim = d.animate(frames.map((k) => ({ ...k, opacity: Number(k.opacity) * alpha })), { duration: FLIGHT_MS, delay: i * 40, easing: 'cubic-bezier(0.45, 0, 0.25, 1)', fill: 'forwards' })
      if (i === 0) {
        anim.onfinish = () => {
          flying.current--
          for (const x of dots) x.remove()
          pulse(c, land.el)
        }
        anim.oncancel = () => { flying.current--; for (const x of dots) x.remove() }
      }
    }
  }
  useBrainFrames((f) => {
    if (f?.op !== 'added') return
    if (!brainArrivalsOn()) return
    queue.current.push(f)
    if (!timer.current) timer.current = window.setTimeout(() => drain.current(), 0)
  })
  useEffect(() => () => {
    window.clearTimeout(timer.current)
    for (const d of document.querySelectorAll('[data-brain-arrival]')) d.remove()
  }, [])
  return null
}
