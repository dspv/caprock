/**
 * The living brain (ADR-063): Second Brain's memories as a slowly turning
 * cloud of points, with the agents this user runs at its rim and small
 * sparks travelling from each agent into it — thoughts pulled out of the
 * sessions — and a point lighting up where a memory lands. The owner,
 * 2026-10-15 (translated): "as if thoughts are being pulled out of each
 * session, neat little things, and it rotates slowly, and you can see
 * something is going on". The sidebar card and the screen's "being built"
 * panel draw this one component.
 *
 * What it shows is the daemon's state, not decoration: the points take the
 * kinds of the newest memories (their colours), one point per memory up to
 * a ceiling; sparks fly while the extraction is working (`activity`), as
 * many as it is busy; each memory added (`landed` going up) sends a spark
 * and lights a point. The sessions at work feed it too (`working`, a count
 * the sidebar already has — nothing more is asked of the daemon): a few slow
 * sparks per working session, which drift in and light nothing, because no
 * memory landed. Idle — nothing extracting, no session working — only the
 * slow turn.
 *
 * A 3D projection is a few lines of arithmetic: points on a Fibonacci
 * sphere, turned about the Y axis (and tilted), scaled by perspective, their
 * alpha by depth. One canvas, no library.
 *
 * Cheap (resources are the moat): about 30 frames a second while the
 * extraction's sparks fly, 10 while only the sessions' slow ones do, 6 while
 * it only turns, each frame a handful of batched paths (one
 * per depth band and colour); no frame at all while the card is out of
 * view (IntersectionObserver) or the window hidden; under
 * prefers-reduced-motion one still frame.
 */
import { useEffect, useRef } from 'react'
import { useSessionFace } from '@/lib/faces'
import './BrainMark.css'
import { agentName, Body, characterFor } from './Characters'
import { readColors } from './BrainGraphCanvas'
import type { DrawnAgent } from './BrainAgents'

const KINDS = ['idea', 'decision', 'finding', 'question'] as const
/** Points drawn: one per memory, never fewer than MIN (an empty brain still looks like one), never more than MAX. */
const MIN = 56
const MAX = 150
const TURN = 0.12 // radians a second
const TILT = 0.38
const PERSPECTIVE = 2.8
const FLIGHT_MS = 1500
/** A working session's spark: slower, and one every SESSION_GAP_MS per session. */
const SLOW_FLIGHT_MS = 2600
const SESSION_GAP_MS = 4000
/** Sessions beyond this add no more sparks: a busy day stays calm. */
const SESSIONS_MAX = 6
const PULSE_MS = 900
/** Depth bands: points and links are drawn a band at a time, back to front. */
const BANDS = 3

interface Pt { x: number; y: number; z: number; kind: number; pulse: number }
/** `slow`: a working session's — slower, and it lights no point (no memory landed). */
interface Spark { from: number; to: number; at: number; kind: number; slow: boolean }

function reducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/** A seeded random, so the same brain is drawn the same way every time. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** Where the agents sit on the rim, as fractions of the box: left and right edges in turn, spread down each. */
function seats(n: number): [number, number][] {
  const rows = Math.ceil(n / 2)
  return Array.from({ length: n }, (_, i) => {
    const k = Math.floor(i / 2)
    const y = n === 1 || rows === 1 ? 0.5 : 0.24 + (k / (rows - 1)) * 0.52
    return [i % 2 === 0 ? 0.09 : 0.91, y] as [number, number]
  })
}

export interface BrainOrbProps {
  /** The newest memories' kinds, newest first; their colours colour the points. */
  kinds: string[]
  /** How many memories there are; points grow with it up to a ceiling. */
  count: number
  agents: DrawnAgent[]
  /** 0 idle (it only turns), 1 working, up to 3 very busy: how many sparks fly. */
  activity: number
  /** Goes up by one per memory added; each step sends a spark and lights a point. */
  landed: number
  /** Sessions working right now, from data the page already has; a few slow sparks each. */
  working?: number
  className?: string
  /** Draw the agents' faces at the rim (the sidebar's card and the screen). */
  showAgents?: boolean
  ariaLabel?: string
}

export function BrainOrb({ kinds, count, agents, activity, landed, working = 0, className = '', showAgents = true, ariaLabel }: BrainOrbProps) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const claudeFace = useSessionFace(undefined)
  const shown = showAgents ? agents.slice(0, 4) : []
  const rim = seats(shown.length)
  // Live inputs for the running loop, without restarting it.
  const live = useRef({ activity, landed, rim, kinds, working })
  live.current = { activity, landed, rim, kinds, working }
  const n = Math.max(MIN, Math.min(MAX, count))

  useEffect(() => {
    const cv = canvas.current
    const box = wrap.current
    if (!cv || !box) return
    const ctx = cv.getContext('2d')
    if (!ctx) return // jsdom
    let colors = readColors(box)
    const rand = rng(n * 7919)
    // A Fibonacci sphere, jittered a little so it reads as grown, not machined.
    const pts: Pt[] = []
    const golden = Math.PI * (3 - Math.sqrt(5))
    for (let i = 0; i < n; i++) {
      const y = 1 - (i / (n - 1)) * 2
      const r = Math.sqrt(1 - y * y)
      const t = golden * i
      const j = 0.86 + rand() * 0.14
      pts.push({ x: Math.cos(t) * r * j, y: y * j, z: Math.sin(t) * r * j, kind: i, pulse: -1e9 })
    }
    // Each point linked to its two nearest: the graph the brain is made of.
    const links: [number, number][] = []
    for (let i = 0; i < n; i++) {
      const near = pts
        .map((p, k) => ({ k, d: (p.x - pts[i]!.x) ** 2 + (p.y - pts[i]!.y) ** 2 + (p.z - pts[i]!.z) ** 2 }))
        .filter((o) => o.k !== i)
        .sort((a, b) => a.d - b.d)
        .slice(0, 2)
      for (const o of near) if (o.k > i) links.push([i, o.k])
    }
    const sparks: Spark[] = []
    let w = 0
    let h = 0
    const dpr = () => Math.min(2, window.devicePixelRatio || 1)
    const resize = () => {
      w = Math.max(1, box.clientWidth)
      h = Math.max(1, box.clientHeight)
      cv.width = Math.round(w * dpr())
      cv.height = Math.round(h * dpr())
      cv.style.width = `${w}px`
      cv.style.height = `${h}px`
    }
    // A point's colour: the kinds of the newest memories, in turn, so the
    // cloud has the brain's own mix; the four kinds before there are any.
    const palette = () => Math.max(1, Math.min(live.current.kinds.length || KINDS.length, 12))
    const kindColor = (i: number) => {
      const ks = live.current.kinds
      const k = ks.length ? ks[i % palette()]! : KINDS[i % KINDS.length]!
      return colors[k] ?? colors.ring
    }

    let angle = 0
    let last = 0
    let lastSpark = 0
    let seenLanded = live.current.landed
    // Projected positions of this frame, for the sparks' targets.
    const px = new Float32Array(n)
    const py = new Float32Array(n)
    const pz = new Float32Array(n)

    const draw = (now: number) => {
      const d = dpr()
      ctx.setTransform(d, 0, 0, d, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const cx = w / 2
      const cy = h / 2
      const R = Math.min(w * (shown.length ? 0.3 : 0.4), h * 0.4)
      const cosA = Math.cos(angle)
      const sinA = Math.sin(angle)
      const cosT = Math.cos(TILT)
      const sinT = Math.sin(TILT)
      for (let i = 0; i < n; i++) {
        const p = pts[i]!
        // About Y, then a tilt about X.
        const x1 = p.x * cosA + p.z * sinA
        const z1 = -p.x * sinA + p.z * cosA
        const y2 = p.y * cosT - z1 * sinT
        const z2 = p.y * sinT + z1 * cosT
        const f = PERSPECTIVE / (PERSPECTIVE - z2)
        px[i] = cx + x1 * R * f
        py[i] = cy + y2 * R * f
        pz[i] = z2
      }
      // Links, faint, fading with depth: three depth bands, one stroke each
      // (a stroke per link was most of a frame's cost).
      ctx.lineWidth = 1
      ctx.strokeStyle = colors.edge
      for (let band = 0; band < BANDS; band++) {
        ctx.globalAlpha = 0.07 + (0.22 * (band + 0.5)) / BANDS
        ctx.beginPath()
        for (const [a, b] of links) {
          const depth = (pz[a]! + pz[b]! + 2) / 4
          if (Math.min(BANDS - 1, Math.floor(depth * BANDS)) !== band) continue
          ctx.moveTo(px[a]!, py[a]!)
          ctx.lineTo(px[b]!, py[b]!)
        }
        ctx.stroke()
      }
      // Points, back to front by depth band, one fill per band and colour.
      for (let band = 0; band < BANDS; band++) {
        ctx.globalAlpha = 0.25 + (0.75 * (band + 0.5)) / BANDS
        for (let c = 0; c < palette(); c++) {
          ctx.fillStyle = kindColor(c)
          ctx.beginPath()
          for (let i = c; i < n; i += palette()) {
            const depth = (pz[i]! + 1) / 2
            if (Math.min(BANDS - 1, Math.floor(depth * BANDS)) !== band || now - pts[i]!.pulse < PULSE_MS) continue
            const r = (1.3 + depth * 1.5) * (PERSPECTIVE / (PERSPECTIVE - pz[i]!))
            ctx.moveTo(px[i]! + r, py[i]!)
            ctx.arc(px[i]!, py[i]!, r, 0, Math.PI * 2)
          }
          ctx.fill()
        }
      }
      // The points a memory just landed on, on top, glowing.
      for (let i = 0; i < n; i++) {
        const age = now - pts[i]!.pulse
        if (age >= PULSE_MS) continue
        const depth = (pz[i]! + 1) / 2
        const glow = 1 - age / PULSE_MS
        const r = (1.3 + depth * 1.5) * (PERSPECTIVE / (PERSPECTIVE - pz[i]!)) * (1 + glow * 1.6)
        ctx.globalAlpha = 0.25 + 0.75 * depth
        ctx.fillStyle = kindColor(i)
        ctx.beginPath()
        ctx.arc(px[i]!, py[i]!, r, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 0.55 * glow
        ctx.strokeStyle = colors.ring
        ctx.lineWidth = 1.2
        ctx.beginPath()
        ctx.arc(px[i]!, py[i]!, r + 3 + (1 - glow) * 9, 0, Math.PI * 2)
        ctx.stroke()
      }
      // Sparks: from an agent at the rim into a point, on a gentle curve.
      const seatsNow = live.current.rim
      for (let s = sparks.length - 1; s >= 0; s--) {
        const sp = sparks[s]!
        const t = (now - sp.at) / (sp.slow ? SLOW_FLIGHT_MS : FLIGHT_MS)
        if (t >= 1) {
          if (!sp.slow) pts[sp.to]!.pulse = now
          sparks.splice(s, 1)
          continue
        }
        const seat = seatsNow[sp.from]
        const sx = seat ? seat[0] * w : cx
        const sy = seat ? seat[1] * h : cy
        const tx = px[sp.to]!
        const ty = py[sp.to]!
        const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
        const mx = (sx + tx) / 2
        const my = (sy + ty) / 2 - 18
        const x = (1 - e) ** 2 * sx + 2 * (1 - e) * e * mx + e * e * tx
        const y = (1 - e) ** 2 * sy + 2 * (1 - e) * e * my + e * e * ty
        ctx.globalAlpha = Math.min(1, t * 4) * (1 - Math.max(0, t - 0.85) / 0.15) * (sp.slow ? 0.7 : 1)
        ctx.fillStyle = kindColor(sp.kind)
        ctx.beginPath()
        ctx.arc(x, y, sp.slow ? 1.8 : 2.2, 0, Math.PI * 2)
        ctx.fill()
        // A short tail.
        const e2 = Math.max(0, e - 0.06)
        ctx.globalAlpha *= 0.35
        ctx.beginPath()
        ctx.arc((1 - e2) ** 2 * sx + 2 * (1 - e2) * e2 * mx + e2 * e2 * tx, (1 - e2) ** 2 * sy + 2 * (1 - e2) * e2 * my + e2 * e2 * ty, 1.5, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }

    const spark = (now: number, slow = false) => {
      const seatsN = Math.max(1, live.current.rim.length)
      const to = Math.floor(Math.random() * n)
      sparks.push({ from: Math.floor(Math.random() * seatsN), to, at: now, kind: to, slow })
    }

    if (reducedMotion()) {
      const still = () => { resize(); draw(performance.now()) }
      still()
      const ro = new ResizeObserver(still)
      ro.observe(box)
      const mo = new MutationObserver(() => { colors = readColors(box); still() })
      mo.observe(document.documentElement, { attributes: true })
      return () => { ro.disconnect(); mo.disconnect() }
    }

    // A frame is asked for only when one is due: a timer waits out the gap,
    // then one animation frame draws. Asking for every animation frame and
    // skipping most still costs the browser a frame each time (measured: the
    // card cost 4% of the main thread that way).
    let frame = 0
    let timer = 0
    let visible = true
    let onScreen = true
    let lastSlow = 0
    const sessionsNow = () => Math.min(SESSIONS_MAX, Math.max(0, Math.floor(live.current.working)))
    // 30 frames a second while the extraction's sparks fly; 10 while only
    // sessions' slow ones do (small, faint and slow, they read as smooth at
    // 10 — measured: 15 cost about a point of main thread more with three
    // sessions working); 6 while it only turns (slow enough that 6 reads as
    // smooth).
    const gapNow = () => {
      if (live.current.activity > 0 || sparks.some((sp) => !sp.slow)) return 1000 / 30
      if (sessionsNow() > 0 || sparks.length > 0) return 1000 / 10
      return 1000 / 6
    }
    const loop = (now: number) => {
      frame = 0
      const dt = last ? Math.min(150, now - last) : 0
      last = now
      angle += (TURN * dt) / 1000
      const a = live.current.activity
      if (a > 0 && now - lastSpark > 900 / a) { spark(now); lastSpark = now }
      const ws = sessionsNow()
      if (ws > 0 && now - lastSlow > SESSION_GAP_MS / ws) { spark(now, true); lastSlow = now }
      while (seenLanded < live.current.landed) { seenLanded++; spark(now) }
      draw(now)
      start()
    }
    function start() {
      if (frame || timer || !visible || !onScreen) return
      timer = window.setTimeout(() => { timer = 0; if (visible && onScreen) frame = requestAnimationFrame(loop) }, gapNow())
    }
    const stop = () => {
      if (frame) cancelAnimationFrame(frame)
      if (timer) window.clearTimeout(timer)
      frame = 0
      timer = 0
      last = 0
    }
    const onVis = () => { visible = !document.hidden; if (visible) start(); else stop() }
    document.addEventListener('visibilitychange', onVis)
    const io = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((es) => { onScreen = es.some((e) => e.isIntersecting); if (onScreen) start(); else stop() })
      : null
    io?.observe(box)
    const ro = new ResizeObserver(() => { resize(); if (!frame) draw(performance.now()) })
    ro.observe(box)
    const mo = new MutationObserver(() => { colors = readColors(box) })
    mo.observe(document.documentElement, { attributes: true })
    resize()
    draw(performance.now())
    visible = !document.hidden
    start()
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVis)
      io?.disconnect()
      ro.disconnect()
      mo.disconnect()
    }
  }, [n])

  return (
    <div ref={wrap} className={`${/\babsolute\b/.test(className) ? '' : 'relative '}${className}`} data-brain-orb>
      <canvas ref={canvas} role="img" aria-label={ariaLabel ?? 'Second Brain, turning'} className="absolute inset-0 block" />
      {shown.map((a, i) => {
        const [x, y] = rim[i]!
        return (
          <svg key={a} viewBox="0 0 80 80" aria-hidden className="brain-orb-agent pointer-events-none absolute h-[26px] w-[26px] -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${x * 100}%`, top: `${y * 100}%` }} data-brain-orb-agent={a}>
            <title>{agentName(a)}</title>
            <circle cx="40" cy="40" r="38" className="brain-hero-seat" />
            <g transform="translate(9 6) scale(0.78)">
              <Body who={characterFor(a)} face={a === 'claude' ? claudeFace : undefined} />
            </g>
          </svg>
        )
      })}
    </div>
  )
}
