/**
 * Memories moving (04-ui.md § Second Brain, *Memories moving*): the
 * "Pensieve" silver thread the owner picked on 2026-10-22 (variant A of the
 * demo). Two directions, each started only by a real event and played once:
 *
 * - **In.** A read ends (a `brain` frame, op `progress`, phase `done`, with
 *   `added` > 0): one silver wisp for the whole read, from that session's
 *   place on screen — its sidebar row, else its tab, else its project's row,
 *   else that agent's face on the Second Brain card — along a slight curve
 *   into the card's glyph, whose surface ripples like the basin's, and *+N*
 *   fades in beside it. A memory dropped by hand (op `added`, not `auto`)
 *   counts one. With nowhere to start from, the ripple and *+N* alone.
 * - **Out.** A new session is handed memories (op `handoff`): once its tab
 *   appears (waited for up to TAB_WAIT_MS), a wisp leaves the glyph, with a
 *   ripple, and settles into the tab, and a whisper under it fades: *3
 *   memories handed*.
 *
 * Throttled per direction (WispLane): at most one a minute, and what comes
 * in that minute is merged into the next one's count; never while the
 * viewer is typing (it waits until TYPING_QUIET_MS after the last key);
 * nothing in a hidden window, and nothing replayed after. Under
 * prefers-reduced-motion nothing moves: only *+N*, or the whisper, fades in
 * and out. Off with Settings → Second Brain, *Show memories moving* (one
 * switch for both).
 *
 * Cheap by construction (resources are the moat): one canvas, created when
 * an effect starts and removed when the last one ends, so no animation
 * frame is asked for while nothing plays; the DOM touches (*+N*, the
 * whisper) are fixed elements moved by the Web Animations API and removed
 * when they finish; no React state, no re-render.
 */
import { useEffect, useRef, type RefObject } from 'react'
import { brainArrivalsSetting, useBrainFrames } from '@/lib/brain'

/** At most one wisp a minute in each direction. */
export const WISP_GAP_MS = 60_000
/** Effects wait this long after the viewer's last keystroke. */
export const TYPING_QUIET_MS = 2_000
/** How long a handoff waits for its session's tab to appear. */
export const TAB_WAIT_MS = 3_000
const WISP_MS = 1400
const RIPPLE_MS = 1300
const MOTE_MS = 900
const PLUS_MS = 2400
const WHISPER_MS = 2800

interface Pt { x: number; y: number }

function reducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

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

const center = (r: DOMRect): Pt => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })

/** What a wisp in is about: the session read (or dropped from), its project and agent. */
export interface ArrivalMeta { session?: string; project?: string; agent?: string }

/** The selector of an agent's face on the card: the folded row's, else the orb's. */
const FACE = '[data-brain-face],[data-brain-orb-agent]'

/**
 * Where memories come from on screen: the session's sidebar row, else its
 * tab in the strip, else its project's sidebar row, else that agent's face
 * on the Second Brain card; null when none of them is drawn. Only the
 * agent's own face: another agent's would say something untrue.
 */
export function arrivalSource(f: ArrivalMeta, root: ParentNode = document): Element | null {
  const tries: string[] = []
  if (f.session) {
    const s = cssEscape(f.session)
    tries.push(`[data-tab-row][data-session-id="${s}"]`, `[role="tab"][data-session-id="${s}"]`, `[data-session-id="${s}"]:not(${FACE})`)
  }
  if (f.project) tries.push(`[data-project-row][data-project-name="${cssEscape(f.project)}"]`)
  if (f.agent) {
    const a = cssEscape(f.agent)
    tries.push(`[data-brain-face="${a}"]`, `[data-brain-orb-agent="${a}"]`)
  }
  for (const sel of tries) {
    for (const el of root.querySelectorAll(sel)) if (onScreen(el)) return el
  }
  return null
}

/** The new session's tab, when it is drawn. */
export function handoffTarget(session: string, root: ParentNode = document): Element | null {
  for (const el of root.querySelectorAll(`[role="tab"][data-session-id="${cssEscape(session)}"]`)) if (onScreen(el)) return el
  return null
}

/** What a lane needs from the world, so a test can drive it. */
export interface LaneClock {
  now(): number
  /** When the viewer last pressed a key; -Infinity when never. */
  lastKey(): number
  hidden(): boolean
  setTimer(fn: () => void, ms: number): number
  clearTimer(id: number): void
}

/**
 * One direction's throttle: `request(n)` asks for a wisp of n memories. It
 * plays at once when the last one was over WISP_GAP_MS ago and nobody has
 * typed for TYPING_QUIET_MS; otherwise it waits, and every request in the
 * meantime adds to the count it will show (the newest request's `meta`
 * says where it goes). A request in a hidden window is dropped, and so is
 * one that is still waiting when the window is hidden: nothing is replayed.
 */
export class WispLane<M> {
  private last = -Infinity
  private pending = 0
  private meta: M | undefined
  private timer = 0
  constructor(private play: (n: number, meta: M) => void, private clock: LaneClock) {}

  request(n: number, meta: M) {
    if (n <= 0 || this.clock.hidden()) return
    this.pending += n
    this.meta = meta
    this.schedule()
  }

  /** The count waiting for the next wisp. */
  get waiting() { return this.pending }

  private schedule() {
    if (this.timer || this.pending <= 0) return
    const now = this.clock.now()
    const wait = Math.max(0, this.last + WISP_GAP_MS - now, this.clock.lastKey() + TYPING_QUIET_MS - now)
    if (wait > 0) {
      this.timer = this.clock.setTimer(() => { this.timer = 0; this.schedule() }, wait + 30)
      return
    }
    const n = this.pending
    const meta = this.meta as M
    this.pending = 0
    this.meta = undefined
    if (this.clock.hidden()) return
    this.last = now
    this.play(n, meta)
  }

  dispose() {
    if (this.timer) this.clock.clearTimer(this.timer)
    this.timer = 0
    this.pending = 0
    this.meta = undefined
  }
}

// ---- The canvas: one, fixed over the window, alive only while something plays.

interface Curve { at(t: number): Pt }
interface Mote { x: number; y: number; vx: number; vy: number; t: number }
type Fx =
  | { kind: 'wisp'; c: Curve; t0: number; dur: number; motes: Mote[]; landed: boolean; onLand?: () => void }
  | { kind: 'ripple'; p: Pt; t0: number; dur: number }

const fx: Fx[] = []
let cv: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null
let raf = 0
let dpr = 1
let colors = { core: '#e4e9ef', glow: 'rgba(196, 210, 226, .55)', hi: '#ffffff' }

/** Whether the effects' canvas is alive (an animation frame asked for, or one playing). For tests and the preview check. */
export function wispsRunning(): boolean { return !!cv || !!raf }

function size() {
  if (!cv) return
  dpr = Math.min(2, window.devicePixelRatio || 1)
  cv.width = Math.round(window.innerWidth * dpr)
  cv.height = Math.round(window.innerHeight * dpr)
}

/** The canvas, made when the first effect starts; false where there is none to draw on (jsdom). */
function ensureCanvas(): boolean {
  if (cv && ctx) return true
  const c = document.createElement('canvas')
  let g: CanvasRenderingContext2D | null = null
  try { g = c.getContext('2d') } catch { g = null }
  if (!g) return false
  c.className = 'brain-wisp-canvas'
  c.setAttribute('aria-hidden', 'true')
  c.dataset.brainWisps = ''
  cv = c
  ctx = g
  size()
  document.body.appendChild(c)
  window.addEventListener('resize', size)
  const css = getComputedStyle(document.documentElement)
  const read = (n: string, d: string) => css.getPropertyValue(n).trim() || d
  colors = { core: read('--wisp-core', colors.core), glow: read('--wisp-glow', colors.glow), hi: read('--wisp-hi', colors.hi) }
  return true
}

function teardown() {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  fx.length = 0
  window.removeEventListener('resize', size)
  cv?.remove()
  cv = null
  ctx = null
}

const kick = () => { if (!raf) raf = requestAnimationFrame(frame) }
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

/** A quadratic curve from a to b, bowed sideways off the straight line. */
export function curve(a: Pt, b: Pt): Curve {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.max(1, Math.hypot(dx, dy))
  const bow = Math.min(110, len * 0.3)
  const c = { x: (a.x + b.x) / 2 + (dy / len) * bow, y: (a.y + b.y) / 2 - (dx / len) * bow }
  return {
    at(t: number) {
      const u = 1 - t
      return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y }
    },
  }
}

function wisp(a: Pt, b: Pt, onLand?: () => void) {
  fx.push({ kind: 'wisp', c: curve(a, b), t0: performance.now(), dur: WISP_MS, motes: [], landed: false, onLand })
  kick()
}

function ripple(p: Pt) {
  fx.push({ kind: 'ripple', p, t0: performance.now(), dur: RIPPLE_MS })
  kick()
}

function frame(now: number) {
  raf = 0
  const g = ctx
  if (!g || !cv) { teardown(); return }
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, window.innerWidth, window.innerHeight)
  for (let i = fx.length - 1; i >= 0; i--) {
    const e = fx[i]!
    const p = Math.min(1, Math.max(0, (now - e.t0) / e.dur))
    if (e.kind === 'wisp') {
      drawWisp(g, e, p, now)
      if (!e.landed && p >= 0.9) { e.landed = true; e.onLand?.() }
      if (p >= 1 && !e.motes.some((m) => now - m.t < MOTE_MS)) fx.splice(i, 1)
    } else {
      drawRipple(g, e, p)
      if (p >= 1) fx.splice(i, 1)
    }
  }
  // A landing may have started a ripple: it is in fx by now.
  if (fx.length) kick()
  else teardown()
}

function dot(g: CanvasRenderingContext2D, q: Pt, r: number, fill: string, blur: number) {
  g.save()
  g.shadowColor = colors.glow
  g.shadowBlur = blur
  g.fillStyle = fill
  g.beginPath()
  g.arc(q.x, q.y, Math.max(0.1, r), 0, Math.PI * 2)
  g.fill()
  g.restore()
}

/** A thin filament drawn out of the source; its tail thins and sheds motes that drift up and fade. */
function drawWisp(g: CanvasRenderingContext2D, e: Extract<Fx, { kind: 'wisp' }>, p: number, now: number) {
  const head = ease(Math.min(1, p / 0.92))
  const fade = p > 0.9 ? 1 - (p - 0.9) / 0.1 : 1
  g.save()
  g.lineCap = 'round'
  const tail = Math.max(0, head - 0.42)
  const N = 28
  g.shadowColor = colors.glow
  g.shadowBlur = 8
  g.strokeStyle = colors.core
  for (let k = 0; k < N; k++) {
    const q1 = e.c.at(tail + (head - tail) * (k / N))
    const q2 = e.c.at(tail + (head - tail) * ((k + 1) / N))
    const w = (k + 1) / N
    g.globalAlpha = w * w * 0.95 * fade
    g.lineWidth = 0.6 + 1.4 * w
    g.beginPath()
    g.moveTo(q1.x, q1.y)
    g.lineTo(q2.x, q2.y)
    g.stroke()
  }
  if (p < 0.9 && Math.random() < 0.5) {
    const q = e.c.at(Math.max(0, head - 0.05 - Math.random() * 0.25))
    e.motes.push({ x: q.x, y: q.y, vx: (Math.random() - 0.5) * 0.25, vy: -0.15 - Math.random() * 0.25, t: now })
  }
  g.globalAlpha = fade
  dot(g, e.c.at(head), 2.4 * fade, colors.hi, 12)
  g.shadowBlur = 0
  g.fillStyle = colors.core
  for (const m of e.motes) {
    const age = (now - m.t) / MOTE_MS
    if (age >= 1) continue
    m.x += m.vx
    m.y += m.vy
    g.globalAlpha = (1 - age) * 0.7
    g.beginPath()
    g.arc(m.x, m.y, 0.9, 0, Math.PI * 2)
    g.fill()
  }
  g.restore()
}

/** The basin's surface: three flattened rings spreading and fading, staggered. */
function drawRipple(g: CanvasRenderingContext2D, e: Extract<Fx, { kind: 'ripple' }>, p: number) {
  g.save()
  g.shadowColor = colors.glow
  g.shadowBlur = 6
  g.strokeStyle = colors.core
  for (let k = 0; k < 3; k++) {
    const q = (p - k * 0.16) / (1 - 0.32)
    if (q <= 0 || q >= 1) continue
    const rx = 6 + 24 * Math.sqrt(q)
    g.globalAlpha = (1 - q) * (0.75 - k * 0.18)
    g.lineWidth = 1.2 - k * 0.3
    g.beginPath()
    g.ellipse(e.p.x, e.p.y + 2, rx, rx * 0.36, 0, 0, Math.PI * 2)
    g.stroke()
  }
  g.restore()
}

// ---- The DOM touches: +N by the glyph, the whisper under a tab.

/** A fixed, short-lived label, faded by the Web Animations API and removed when done. */
function label(cls: string, text: string, x: number, y: number, frames: Keyframe[], ms: number) {
  const el = document.createElement('span')
  el.className = cls
  el.setAttribute('aria-hidden', 'true')
  el.textContent = text
  el.style.left = `${Math.round(x)}px`
  el.style.top = `${Math.round(y)}px`
  document.body.appendChild(el)
  if (typeof el.animate !== 'function') { window.setTimeout(() => el.remove(), ms); return el }
  const a = el.animate(frames, { duration: ms, easing: 'ease-out' })
  a.onfinish = () => el.remove()
  a.oncancel = () => el.remove()
  return el
}

function showPlus(glyph: DOMRect, n: number) {
  const still = reducedMotion()
  label('brain-wisp-plus', `+${n}`, glyph.right + 3, glyph.top - 6, [
    { opacity: 0, transform: still ? 'none' : 'translateY(3px)' },
    { opacity: 1, transform: 'none', offset: 0.15 },
    { opacity: 1, offset: 0.7 },
    { opacity: 0, transform: still ? 'none' : 'translateY(-4px)' },
  ], PLUS_MS)
}

function whisper(tab: Element, n: number) {
  const r = tab.getBoundingClientRect()
  const x = Math.max(4, Math.min(r.left + 10, window.innerWidth - 160))
  label('brain-wisp-whisper', `${n} ${n === 1 ? 'memory' : 'memories'} handed`, x, r.bottom + 3, [
    { opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.75 }, { opacity: 0 },
  ], WHISPER_MS)
  if (!reducedMotion() && typeof (tab as HTMLElement).animate === 'function') {
    (tab as HTMLElement).animate([
      { boxShadow: 'inset 0 -2px 0 var(--wisp-core)' },
      { boxShadow: 'inset 0 -2px 0 transparent' },
    ], { duration: 1600, easing: 'ease-out' })
  }
}

/** Where on the card memories land: the glyph (folded row or unfolded heading), else the card. */
function landing(card: HTMLElement): DOMRect | null {
  const el = card.querySelector<HTMLElement>('[data-brain-glyph]') ?? card
  return onScreen(el)
}

// ---- The two effects.

function playArrive(n: number, meta: ArrivalMeta, card: HTMLElement | null, retried = false) {
  const land = card ? landing(card) : null
  if (!land) return
  if (reducedMotion()) { showPlus(land, n); return }
  const from = arrivalSource(meta)
  if (!from && !retried && meta.agent) {
    // The agent's face may be about to be drawn: the status that lists it
    // is read again on the same frame. One more look, a moment later.
    window.setTimeout(() => playArrive(n, meta, card, true), 400)
    return
  }
  const r = from ? onScreen(from) : null
  const to = center(land)
  if (!r || !ensureCanvas()) {
    if (ensureCanvas()) ripple(to)
    showPlus(land, n)
    return
  }
  // A face from its middle; a row or a tab from its left part, where its dot and title start.
  const a = from!.matches(FACE) ? center(r) : { x: r.left + Math.min(16, r.width / 2), y: r.top + r.height / 2 }
  wisp(a, to, () => { ripple(to); showPlus(land, n) })
}

function playHandoff(n: number, session: string, card: HTMLElement | null) {
  const started = performance.now()
  const look = () => {
    if (document.visibilityState === 'hidden') return
    const tab = handoffTarget(session)
    if (!tab) {
      if (performance.now() - started < TAB_WAIT_MS) window.setTimeout(look, 150)
      return
    }
    const land = card ? landing(card) : null
    if (reducedMotion() || !land || !ensureCanvas()) { whisper(tab, n); return }
    const g = center(land)
    ripple(g)
    const r = tab.getBoundingClientRect()
    wisp(g, { x: r.left + Math.min(28, r.width / 2), y: r.bottom - 4 }, () => whisper(tab, n))
  }
  look()
}

/** The keys that are not typing: a modifier pressed alone. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'])

export function BrainArrivals({ card }: { card: RefObject<HTMLElement | null> }) {
  const lanes = useRef<{ arrive: WispLane<ArrivalMeta>; handoff: WispLane<string> } | null>(null)
  useEffect(() => {
    let lastKey = -Infinity
    const onKey = (e: KeyboardEvent) => { if (!MODIFIERS.has(e.key)) lastKey = performance.now() }
    document.addEventListener('keydown', onKey, true)
    const clock: LaneClock = {
      now: () => performance.now(),
      lastKey: () => lastKey,
      hidden: () => document.visibilityState === 'hidden',
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id),
    }
    const arrive = new WispLane<ArrivalMeta>((n, m) => playArrive(n, m, card.current), clock)
    const handoff = new WispLane<string>((n, s) => playHandoff(n, s, card.current), clock)
    lanes.current = { arrive, handoff }
    return () => {
      document.removeEventListener('keydown', onKey, true)
      arrive.dispose()
      handoff.dispose()
      lanes.current = null
      teardown()
    }
  }, [card])
  useBrainFrames((f) => {
    const l = lanes.current
    if (!f || !l || !brainArrivalsSetting()) return
    const meta = { session: f.session, project: f.project, agent: f.agent }
    if (f.op === 'progress' && f.phase === 'done') l.arrive.request(f.added ?? 0, meta)
    // A memory dropped by hand: one. A read's own are counted by its end.
    else if (f.op === 'added' && !f.auto) l.arrive.request(1, meta)
    else if (f.op === 'handoff' && f.session) l.handoff.request(f.memories ?? 0, f.session)
  }, { progress: true, handoff: true })
  return null
}
