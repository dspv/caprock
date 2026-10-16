/**
 * Second Brain drawn (ADR-063): the graph on a canvas, laid out by
 * lib/forcegraph. The `#/brain` screen's Graph view is this component;
 * `mini` (a small fitted one) drops the labels, the pan and the zoom.
 *
 * It looks like a knowledge graph (the owner, 2026-10-15, pointing at
 * Obsidian's graph view: "exactly this"):
 *
 * - **A disc of small dots.** No anchors, no ring of projects: the
 *   many-body push against a linear pull to the middle settles into one
 *   round, evenly filled disc, whose radius grows with the node count; the
 *   view fits it to the panel. A memory's tie to its project is loose (a
 *   project is a region of the disc, not a knot), its ties to its topics
 *   are short, so a topic or a project and its memories read as a little
 *   burst.
 * - **Restrained.** A memory is a tiny dot in the text colour at about
 *   three quarters; a topic is a little bigger with a faint cool tint; a
 *   project bigger and full strength. One accent: the node hovered or
 *   opened. In a light theme the text colour is dark, so the dots are too.
 *   Edges are hairlines at about an eighth.
 * - **Labels come with zoom.** None at rest. Past HUB_LABELS_AT times the
 *   fitted zoom the hubs fade in (the busiest first, more as one zooms),
 *   past ALL_LABELS_AT every memory on screen; the hovered node and its
 *   neighbours are named whatever the zoom.
 * - **Focus.** Hovering or opening a node brightens it and its neighbours
 *   with a soft glow and fades the rest to DIM, over FADE_MS.
 * - **Still once settled.** A first look settles off screen, in slices of a
 *   frame's budget, and fades in already in shape; then nothing runs until
 *   something changes (zero frames at rest). A dragged node pulls its
 *   neighbours gently and the graph settles again. Under
 *   prefers-reduced-motion nothing fades or drops.
 *
 * Built for thousands of nodes: one canvas, edges in one path, nodes in one
 * path per kind, and the picture kept in a base layer redrawn only when it
 * changes (a pan or zoom scales the cached layer until it comes to rest).
 *
 * **Click to interact.** At rest the graph is part of the page: the wheel
 * and a trackpad scroll the page past it (the owner, 2026-10-16,
 * translated: "when I scroll the page, the graph zooms instead"). A click
 * on it (Enter or Space from the keyboard) takes it in hand: then the wheel
 * zooms, a drag pans or moves a dot, and a ring says so. Escape, a click
 * outside, the mouse leaving it or the focus moving away lets it go. A click
 * on a dot opens it whether or not the graph was in hand; Fit works in both.
 *
 * The Pensieve (the owner's picture, translated: "memories drawn out with a
 * wand and laid in the Pensieve"): a memory that arrives while the graph is
 * on screen drops in from above, and a faint ring spreads where it lands.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { BrainGraph, BrainNode } from '@/lib/api'
import { isEntity, KIND_COLOR } from '@/lib/brain'
import { bounds, seed, Simulation, type SimLink } from '@/lib/forcegraph'

const DROP_MS = 900
const RIPPLE_MS = 900
/** How much of the rest stays visible while a node has the focus. */
const DIM = 0.2
/** The same while only an opened node has it: the card beside says the rest, so less is dimmed. */
const DIM_OPENED = 0.42
/** The focus fades in and out over this long. */
const FADE_MS = 180
/** Off a dot, the focus stays this long before it fades, in case the pointer lands on the next. */
const LINGER_MS = 140
/** A first look fades in over this long, once laid out. */
const INTRO_MS = 420
/** A fit glides over this long. */
const GLIDE_MS = 260
/** Zoom, relative to the fitted one, where the hubs' labels start to fade in; fully in by +LABEL_RAMP. */
export const HUB_LABELS_AT = 1.5
/** Zoom, relative to the fitted one, where every memory on screen is named. */
export const ALL_LABELS_AT = 3.2
const LABEL_RAMP = 0.6
/** A focus names its neighbouring memories only when it has at most this many. */
const NEAR_NAMED = 12
/** Edge and memory-dot strength at rest. */
const EDGE_ALPHA = 0.1
const DOT_ALPHA = 0.85
/** Off-screen settling takes at most this many milliseconds of a frame, and this long in all. */
const SLICE_MS = 12
const SETTLE_MAX_MS = 1200
const LABEL_FONT = '11px ui-sans-serif, system-ui, -apple-system, sans-serif'
const LABEL_FONT_HUB = '500 11.5px ui-sans-serif, system-ui, -apple-system, sans-serif'

interface View { k: number; tx: number; ty: number }

function reducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/**
 * A dot's radius in screen pixels at the fitted zoom: memories all the same
 * tiny size, hubs a little bigger with their links.
 */
export function dotRadius(n: Pick<BrainNode, 'kind' | 'degree' | 'pinned'>): number {
  const deg = Math.sqrt(n.degree ?? 0)
  if (n.kind === 'project') return Math.min(3 + deg * 0.3, 6.5)
  if (isEntity(n.kind)) return Math.min(1.8 + deg * 0.36, 4.6)
  return n.pinned ? 2.4 : 2
}

/**
 * How a link pulls: a memory's tie to its project is loose and long (a
 * project is a region, not a knot), its tie to a topic short (a burst), a
 * memory to a memory in between.
 */
export function linkShape(a: BrainNode['kind'], b: BrainNode['kind']): { w: number; d: number } {
  if (a === 'project' || b === 'project') return { w: 0.06, d: 40 }
  if (isEntity(a) || isEntity(b)) return { w: 0.7, d: 12 }
  return { w: 0.3, d: 18 }
}

/** Resolves the theme's colours (CSS variables built with color-mix) to strings a canvas takes. */
export function readColors(el: HTMLElement): Record<string, string> & {
  edge: string; label: string; fg: string; ring: string; halo: string; dot: string; topic: string; person: string; web: string
} {
  const probe = document.createElement('span')
  probe.style.display = 'none'
  el.appendChild(probe)
  const read = (v: string, fallback: string) => {
    probe.style.color = ''
    probe.style.color = v
    const c = getComputedStyle(probe).color
    return c || fallback
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(KIND_COLOR)) out[k] = read(v, '#888')
  const res = {
    ...out,
    edge: read('var(--color-border-strong, var(--color-border))', '#999'),
    label: read('var(--color-fg-muted)', '#666'),
    fg: read('var(--color-fg)', '#222'),
    ring: read('var(--color-accent)', '#e90'),
    halo: read('var(--color-panel)', '#fff'),
    // The knowledge-graph look: dots in the text colour, a faint tint for an
    // entity's kind, hairlines in the text colour with the alpha drawn on.
    dot: read('var(--color-fg)', '#ddd'),
    topic: read('color-mix(in srgb, #7fa8e0 32%, var(--color-fg))', '#bcd'),
    person: read('color-mix(in srgb, #d97757 30%, var(--color-fg))', '#dcb'),
    web: read('color-mix(in srgb, var(--color-fg) 45%, transparent)', 'rgba(128,128,128,.45)'),
  }
  probe.remove()
  return res
}

export interface BrainGraphCanvasProps {
  graph: BrainGraph
  selected?: number
  onSelect?: (id: number) => void
  /** A small one: no labels, no pan or zoom, fitted. */
  mini?: boolean
  className?: string
  ariaLabel?: string
}

type Gesture =
  | { kind: 'pan'; x: number; y: number; tx: number; ty: number; moved: boolean }
  | { kind: 'node'; i: number; x: number; y: number; moved: boolean }
  | { kind: 'pinch'; d: number; k: number; mx: number; my: number; tx: number; ty: number }

export function BrainGraphCanvas({ graph, selected, onSelect, mini = false, className = '', ariaLabel }: BrainGraphCanvasProps) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  // Positions outlive a graph read, so a reload or a new memory does not
  // reshuffle the picture.
  const places = useRef(new Map<number, { x: number; y: number }>())
  // When each node first appeared while on screen, for the drop-in.
  const born = useRef(new Map<number, number>())
  const seen = useRef<Set<number> | null>(null)
  const view = useRef<View>({ k: 1, tx: 0, ty: 0 })
  const touched = useRef(false)
  const hover = useRef<number>(-1)
  const unhover = useRef(0)
  const frame = useRef(0)
  const kick = useRef<() => void>(() => {})
  const fitNow = useRef<() => void>(() => {})
  /** Screen radius of each node at the current zoom, for hit-testing. */
  const radiusAt = useRef<(i: number) => number>(() => 2)
  // When the view last moved by hand: while it moves the base layer is scaled, not redrawn.
  const lastMove = useRef(0)
  // In hand (see "Click to interact" above): the wheel zooms and a drag moves
  // the picture only while this is on. The ref is what the handlers read.
  const [active, setActive] = useState(false)
  const activeRef = useRef(false)
  const activate = (on: boolean) => {
    if (activeRef.current === on) return
    activeRef.current = on
    setActive(on)
  }

  const sim = useMemo(() => {
    const ids = graph.nodes.map((n) => n.id)
    const index = new Map(ids.map((id, i) => [id, i] as const))
    const links: SimLink[] = []
    for (const e of graph.edges) {
      const s = index.get(e.from)
      const t = index.get(e.to)
      if (s === undefined || t === undefined || s === t) continue
      links.push({ s, t, ...linkShape(graph.nodes[s]!.kind, graph.nodes[t]!.kind) })
    }
    // Another selection (a search, a project, a span) is a picture of its
    // own: laid out afresh as its own disc and fitted, rather than left as a
    // fragment of the last one. A re-read that only grew keeps its places.
    const kept = ids.filter((id) => places.current.has(id)).length
    const before = seen.current?.size ?? 0
    const another = before > 0 && (kept < ids.length * 0.8 || kept < before * 0.8)
    if (another) {
      places.current.clear()
      born.current.clear()
      touched.current = false
    }
    const nodes = seed(ids, (i) => dotRadius(graph.nodes[i]!), links, places.current)
    // A little air around every dot, so the disc fills evenly.
    for (const n of nodes) n.cr = n.r + 4.5
    const opts = mini ? { charge: -14, distance: 14, gravity: 0.08 } : { charge: -48, distance: 20, gravity: 0.36 }
    const s = new Simulation(nodes, links, opts)
    // A project sits in the middle of its own memories: while a first look
    // settles, after each tick it is put on their centroid. Held only by
    // springs, a hub this busy ends up at the edge of its burst, pushed out by
    // its own leaves. Once settled it is an ordinary node, so one dragged
    // stays where it is let go.
    const own = new Map<number, number[]>()
    for (const l of links) {
      for (const [hub, leaf] of [[l.s, l.t], [l.t, l.s]] as const) {
        if (graph.nodes[hub]!.kind !== 'project' || isEntity(graph.nodes[leaf]!.kind)) continue
        const list = own.get(hub)
        if (list) list.push(leaf)
        else own.set(hub, [leaf])
      }
    }
    const hold = { hubs: true }
    const tick = () => {
      s.tick()
      if (!hold.hubs) return
      for (const [hub, leaves] of own) {
        const n = nodes[hub]!
        if (n.fx !== undefined) continue
        let x = 0
        let y = 0
        for (const j of leaves) { x += nodes[j]!.x; y += nodes[j]!.y }
        Object.assign(n, { x: x / leaves.length, y: y / leaves.length, vx: 0, vy: 0 })
      }
    }
    const placed = nodes.filter((n) => places.current.has(n.id)).length
    // Every node placed (a re-read): a breath to take in a changed link.
    // Some new: settle them on screen, gently. None: a first look, settled
    // off screen before it is drawn.
    hold.hubs = placed === 0
    if (placed === nodes.length) s.alpha = 0.05
    else if (placed > 0) s.alpha = 0.3
    // New nodes after the first paint drop in.
    if (seen.current && !another && !reducedMotion()) {
      const now = performance.now()
      for (const n of graph.nodes) if (!seen.current.has(n.id) && !isEntity(n.kind)) born.current.set(n.id, now)
    }
    seen.current = new Set(ids)
    return { s, tick, hold, fresh: placed === 0 }
  }, [graph, mini])

  useEffect(() => {
    const { s: layout, tick, hold, fresh } = sim
    const cv = canvas.current
    const box = wrap.current
    if (!cv || !box) return
    const ctx = cv.getContext('2d')
    if (!ctx) return // jsdom, or a canvas the browser refused
    const still = reducedMotion()
    let colors = readColors(box)
    let w = 0
    let h = 0
    const dpr = () => window.devicePixelRatio || 1
    const nodes = layout.nodes
    const kinds = graph.nodes.map((n) => n.kind)
    const px = graph.nodes.map((n) => dotRadius(n))

    // The fitted view: the disc filling the panel. A small graph is not
    // blown up past MAX_K, so it stays a small, full disc in the middle.
    const MAX_K = 3
    const fitted = (): View => {
      const b = bounds(nodes)
      const pad = mini ? 6 : 28
      const size = Math.max(b.x1 - b.x0, b.y1 - b.y0, 1)
      const k = Math.min((Math.min(w, h) - pad * 2) / size, MAX_K)
      return { k, tx: w / 2 - ((b.x0 + b.x1) / 2) * k, ty: h / 2 - ((b.y0 + b.y1) / 2) * k }
    }
    let fitK = 1
    const fit = () => { view.current = fitted(); fitK = view.current.k }

    const resize = () => {
      // The inner size: the canvas sits absolutely inside, so sizing it
      // never feeds back into the box it is measured from.
      w = Math.max(1, box.clientWidth)
      h = Math.max(1, box.clientHeight)
      cv.width = Math.round(w * dpr())
      cv.height = Math.round(h * dpr())
      cv.style.width = `${w}px`
      cv.style.height = `${h}px`
      base.width = cv.width
      base.height = cv.height
      if (!touched.current) fit()
      else fitK = fitted().k
      baseDirty = true
      schedule()
    }

    // A dot grows a little as one zooms in, never as fast as the zoom, so
    // zooming spreads the graph rather than inflating it.
    const grow = (v: View) => Math.min(2.4, Math.max(0.7, Math.sqrt(v.k / fitK)))
    radiusAt.current = (i) => px[i]! * grow(view.current)

    // The focus: the hovered node, else the opened one; `lit` fades between
    // 0 and 1 so the rest dims gently.
    const hoveredId = () => (hover.current >= 0 ? nodes[hover.current]?.id : undefined)
    let focus: number | undefined
    let lit = 0
    let litFrom = 0
    let litAt = 0
    const near = new Set<number>()
    const setFocus = (id: number | undefined) => {
      focus = id
      near.clear()
      if (id === undefined) return
      near.add(id)
      for (const e of graph.edges) {
        if (e.from === id) near.add(e.to)
        if (e.to === id) near.add(e.from)
      }
    }
    setFocus(hoveredId() ?? (selected !== undefined && nodes.some((n) => n.id === selected) ? selected : undefined))
    lit = focus === undefined ? 0 : 1
    /** What the focus is heading for: `focus` lags it while fading out. */
    let aim = focus
    // Entities, busiest first: the order their labels come in.
    const hubs = nodes
      .map((_, i) => i)
      .filter((i) => isEntity(kinds[i]!))
      .sort((a, b) => (kinds[b] === 'project' ? 1 : 0) - (kinds[a] === 'project' ? 1 : 0) || (graph.nodes[b]!.degree ?? 0) - (graph.nodes[a]!.degree ?? 0))

    // Two layers. The base — edges, dots, labels — is drawn into a canvas of
    // its own only when it changes: the layout moved, the focus or the
    // colours changed, or a pan or zoom came to rest. Every frame copies it,
    // scaled while the view moves, and draws memories dropping in on top.
    // Stroking thousands of edges is the expensive part (about 150 ms for
    // 9,000 in a software-rendered browser, measured 2026-10-14), so it is
    // done once per change, not once per frame.
    const base = document.createElement('canvas')
    const bctx = base.getContext('2d')
    let baseView: View | null = null
    let baseDirty = true
    /** The cached base holds the current picture. */
    let cached = false
    /** The view last drawn straight onto the screen's canvas; null while the cache is shown. */
    let shown: View | null = null

    const sx = (x: number, v: View) => x * v.k + v.tx
    const sy = (y: number, v: View) => y * v.k + v.ty
    const fill = (k: string) => (k === 'project' ? colors.dot : k === 'topic' ? colors.topic : k === 'person' ? colors.person : colors.dot)
    const restAlpha = (k: string) => (k === 'project' ? 0.95 : isEntity(k as BrainNode['kind']) ? 0.86 : DOT_ALPHA)

    // Labels already placed this draw, as boxes: a label that would overlap
    // one is left out (they are placed most important first).
    let boxes: number[] = []
    const label = (c: CanvasRenderingContext2D, v: View, i: number, alpha: number, strong: boolean) => {
      if (alpha <= 0.01) return
      const n = nodes[i]!
      const r = px[i]! * grow(v)
      const x = sx(n.x, v)
      const y = sy(n.y, v) + r + 3
      if (x < -120 || x > w + 120 || y < -10 || y > h + 10) return
      const title = graph.nodes[i]!.title
      const text = title.length > 38 ? title.slice(0, 37) + '…' : title
      c.font = isEntity(kinds[i]!) ? LABEL_FONT_HUB : LABEL_FONT
      const half = c.measureText(text).width / 2 + 2
      const x0 = x - half
      const x1 = x + half
      const y1 = y + 14
      for (let b = 0; b < boxes.length; b += 4) {
        if (x0 < boxes[b + 2]! && x1 > boxes[b]! && y < boxes[b + 3]! && y1 > boxes[b + 1]!) return
      }
      boxes.push(x0, y, x1, y1)
      c.globalAlpha = alpha
      c.lineWidth = 3
      c.lineJoin = 'round'
      c.strokeStyle = colors.halo
      c.strokeText(text, x, y)
      c.fillStyle = strong ? colors.fg : colors.label
      c.fillText(text, x, y)
    }

    const drawBase = (c: CanvasRenderingContext2D, v: View) => {
      const d = dpr()
      c.setTransform(1, 0, 0, 1, 0, 0)
      c.clearRect(0, 0, c.canvas.width, c.canvas.height)
      // Screen space: dots and hairlines keep their pixel size at any zoom.
      c.setTransform(d, 0, 0, d, 0, 0)
      const g = grow(v)
      const rest = 1 - (1 - (focus === selected && hover.current < 0 ? DIM_OPENED : DIM)) * lit
      const big = nodes.length > 1500
      // Hairlines; behind a focus, its own links brighter on top.
      c.strokeStyle = colors.web
      c.lineWidth = big ? 0.5 : 0.65
      c.globalAlpha = Math.min(1, ((big ? 0.09 : EDGE_ALPHA) / 0.45) * rest)
      c.beginPath()
      for (const l of layout.links) {
        const a = nodes[l.s]!
        const b = nodes[l.t]!
        c.moveTo(sx(a.x, v), sy(a.y, v))
        c.lineTo(sx(b.x, v), sy(b.y, v))
      }
      c.stroke()
      if (focus !== undefined && lit > 0) {
        c.globalAlpha = 0.55 * lit
        c.strokeStyle = colors.fg
        c.lineWidth = 0.9
        c.beginPath()
        for (const l of layout.links) {
          const a = nodes[l.s]!
          const b = nodes[l.t]!
          if (a.id !== focus && b.id !== focus) continue
          c.moveTo(sx(a.x, v), sy(a.y, v))
          c.lineTo(sx(b.x, v), sy(b.y, v))
        }
        c.stroke()
      }
      // Dots, one path per kind: the rest, then the lit neighbourhood with a
      // soft glow.
      const groups = new Map<string, number[]>()
      nodes.forEach((n, i) => {
        if (born.current.has(n.id)) return
        const list = groups.get(kinds[i]!)
        if (list) list.push(i)
        else groups.set(kinds[i]!, [i])
      })
      const dots = (list: number[], pick: (i: number) => boolean, scale = 1) => {
        c.beginPath()
        for (const i of list) {
          if (!pick(i)) continue
          const n = nodes[i]!
          const r = px[i]! * g * scale
          const x = sx(n.x, v)
          const y = sy(n.y, v)
          if (x < -r || x > w + r || y < -r || y > h + r) continue
          c.moveTo(x + r, y)
          c.arc(x, y, r, 0, Math.PI * 2)
        }
        c.fill()
      }
      const inFocus = (i: number) => focus !== undefined && near.has(nodes[i]!.id)
      for (const [kind, list] of groups) {
        c.fillStyle = fill(kind)
        c.globalAlpha = restAlpha(kind) * rest
        dots(list, (i) => !inFocus(i) || lit === 0)
      }
      if (focus !== undefined && lit > 0) {
        // The glow: two soft halos under each lit dot, one path each (a
        // canvas shadow blur costs a software-rendered frame ten times more).
        const litDot = (i: number) => inFocus(i) && nodes[i]!.id !== focus
        c.fillStyle = colors.fg
        for (const [scale, a] of [[3.4, 0.05], [2.1, 0.09]] as const) {
          c.globalAlpha = a * lit
          for (const list of groups.values()) dots(list, litDot, scale)
        }
        for (const [kind, list] of groups) {
          c.fillStyle = fill(kind)
          const a = restAlpha(kind)
          c.globalAlpha = a * rest + (1 - a * rest) * lit
          dots(list, litDot)
        }
      }
      // One accent: the focus, and the opened node with a ring.
      const accent = (i: number, alpha: number, ringed: boolean) => {
        const n = nodes[i]!
        const r = px[i]! * g + 0.6
        const x = sx(n.x, v)
        const y = sy(n.y, v)
        c.fillStyle = colors.ring
        for (const [scale, a] of [[4, 0.07], [2.4, 0.14]] as const) {
          c.globalAlpha = a * alpha
          c.beginPath()
          c.arc(x, y, r * scale, 0, Math.PI * 2)
          c.fill()
        }
        c.globalAlpha = alpha
        c.beginPath()
        c.arc(x, y, r, 0, Math.PI * 2)
        c.fill()
        if (ringed) {
          c.strokeStyle = colors.ring
          c.lineWidth = 1
          c.beginPath()
          c.arc(x, y, r + 3, 0, Math.PI * 2)
          c.stroke()
        }
      }
      const fi = focus === undefined ? -1 : nodes.findIndex((n) => n.id === focus)
      const sel = selected === undefined ? -1 : nodes.findIndex((n) => n.id === selected)
      if (fi >= 0 && fi !== sel && lit > 0) accent(fi, lit, false)
      if (sel >= 0) accent(sel, 1, true)
      // Labels, Obsidian-style: none at rest; the hubs fade in with zoom,
      // then every memory; the focus and its neighbours whatever the zoom.
      if (!mini) {
        boxes = []
        c.textAlign = 'center'
        c.textBaseline = 'top'
        const zr = v.k / fitK
        const hubA = Math.min(1, Math.max(0, (zr - HUB_LABELS_AT) / LABEL_RAMP))
        const memA = Math.min(1, Math.max(0, (zr - ALL_LABELS_AT) / LABEL_RAMP))
        const done = new Set<number>()
        const put = (i: number, a: number, strong = false) => { if (!done.has(i)) { done.add(i); label(c, v, i, a, strong) } }
        if (fi >= 0 && lit > 0) {
          put(fi, lit, true)
          const ns = nodes.map((_, i) => i).filter((i) => i !== fi && near.has(nodes[i]!.id))
          const mems = ns.filter((i) => !isEntity(kinds[i]!))
          for (const i of ns) if (isEntity(kinds[i]!) || mems.length <= NEAR_NAMED || memA > 0) put(i, lit)
        }
        if (sel >= 0) put(sel, 1, true)
        if (hubA > 0) {
          const limit = Math.round(6 * zr * zr)
          for (const i of hubs.slice(0, limit)) put(i, hubA * rest, kinds[i] === 'project')
        }
        if (memA > 0) for (let i = 0; i < nodes.length; i++) if (!isEntity(kinds[i]!)) put(i, memA * rest)
      }
      c.globalAlpha = 1
    }

    /** The light layer: memories dropping in. True while one is. */
    const drawOver = (v: View, now: number): boolean => {
      const d = dpr()
      ctx.setTransform(d, 0, 0, d, 0, 0)
      let animating = false
      const g = grow(v)
      for (const [id, at] of born.current) {
        const i = nodes.findIndex((n) => n.id === id)
        if (i < 0) { born.current.delete(id); continue }
        const n = nodes[i]!
        const t = now - at
        if (t > DROP_MS + RIPPLE_MS) { born.current.delete(id); baseDirty = true; continue }
        animating = true
        const p = Math.min(1, t / DROP_MS)
        const ease = 1 - Math.pow(1 - p, 3)
        const fall = (1 - ease) * (mini ? 40 : 90)
        const x = sx(n.x, v)
        const y = sy(n.y, v)
        ctx.globalAlpha = (0.25 + 0.75 * ease) * DOT_ALPHA
        ctx.fillStyle = colors.dot
        ctx.beginPath()
        ctx.arc(x, y - fall, px[i]! * g * (1 + (1 - ease) * 0.8), 0, Math.PI * 2)
        ctx.fill()
        if (t > DROP_MS * 0.8) {
          const q = Math.min(1, (t - DROP_MS * 0.8) / RIPPLE_MS)
          ctx.globalAlpha = 0.45 * (1 - q)
          ctx.strokeStyle = colors.ring
          ctx.lineWidth = 0.8
          ctx.beginPath()
          ctx.arc(x, y, px[i]! * g + (mini ? 10 : 16) * q, 0, Math.PI * 2)
          ctx.stroke()
        }
      }
      ctx.globalAlpha = 1
      return animating
    }

    const same = (a: View, b: View | null) => !!b && a.k === b.k && a.tx === b.tx && a.ty === b.ty

    // A first look settles off screen before it is drawn, then fades in.
    let settling = fresh
    let settleFrom = 0
    let introAt = fresh ? -1 : 0
    if (fresh && !still) cv.style.opacity = '0'
    // A fit that glides: from, to, when.
    let glide: { from: View; to: View; at: number } | null = null

    let running = false
    const loop = (now: number) => {
      frame.current = 0
      if (settling) {
        const t0 = performance.now()
        settleFrom ||= t0
        while (!layout.done && performance.now() - t0 < SLICE_MS) tick()
        // A big graph (thousands of nodes) shows itself after SETTLE_MAX_MS
        // and finishes settling on screen; the rest open already still.
        if (!layout.done && t0 - settleFrom < SETTLE_MAX_MS) { frame.current = requestAnimationFrame(loop); return }
        settling = false
        if (layout.done) hold.hubs = false
        for (const n of nodes) places.current.set(n.id, { x: n.x, y: n.y })
        if (!touched.current) fit()
        introAt = still ? 0 : now
        baseDirty = true
      }
      let moving = false
      if (!layout.done) {
        if (still) {
          // No settling on screen: finish it at once.
          for (let i = 0; i < 400 && !layout.done; i++) tick()
        } else {
          const ticks = nodes.length > 2000 ? 1 : nodes.length > 500 ? 2 : 3
          for (let i = 0; i < ticks && !layout.done; i++) tick()
          moving = true
        }
        for (const n of nodes) places.current.set(n.id, { x: n.x, y: n.y })
        if (!touched.current) fit()
        if (layout.done) hold.hubs = false
        baseDirty = true
      }
      if (glide) {
        const p = Math.min(1, (now - glide.at) / GLIDE_MS)
        const e = 1 - Math.pow(1 - p, 3)
        const { from: a, to: b } = glide
        view.current = { k: a.k + (b.k - a.k) * e, tx: a.tx + (b.tx - a.tx) * e, ty: a.ty + (b.ty - a.ty) * e }
        if (p >= 1) glide = null
        lastMove.current = now
      }
      // The focus follows the pointer; a big graph keeps its base (the
      // relight would redraw thousands of edges per move).
      // An opened node that this selection does not show has no focus here.
      const opened = selected !== undefined && nodes.some((n) => n.id === selected) ? selected : undefined
      const want = (layout.links.length <= 3000 ? hoveredId() : undefined) ?? opened
      if (want !== aim && !mini) {
        // Onto a node, or off one: the fade carries on from where it is.
        // Off one, the focus stays put while it fades out.
        aim = want
        if (want !== undefined) setFocus(want)
        litFrom = lit
        litAt = now
        baseDirty = true
      }
      const target = want !== undefined && !mini ? 1 : 0
      if (lit !== target) {
        const p = still ? 1 : Math.min(1, (now - litAt) / FADE_MS)
        lit = litFrom + (target - litFrom) * p
        if (p >= 1) {
          lit = target
          if (target === 0) setFocus(undefined)
        }
        baseDirty = true
      }
      const v = view.current
      const interacting = now - lastMove.current < 160
      // The first look fades in on the element's opacity: no redraw for it.
      const intro = introAt <= 0 ? 1 : Math.min(1, (now - introAt) / INTRO_MS)
      cv.style.opacity = String(intro)
      const dropping = born.current.size > 0
      const d = dpr()
      if (interacting || dropping) {
        // While the view moves, or a memory drops in, the cached base is
        // copied (scaled while the view moves) and the light layer drawn
        // over it: the base is redrawn only when it changed.
        if (bctx && (baseDirty || !cached || (!same(v, baseView) && !interacting))) {
          drawBase(bctx, v)
          baseView = { ...v }
          cached = true
          baseDirty = false
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, cv.width, cv.height)
        if (baseView) {
          const s = v.k / baseView.k
          ctx.setTransform(s, 0, 0, s, d * (v.tx - baseView.tx * s), d * (v.ty - baseView.ty * s))
          ctx.drawImage(base, 0, 0)
        }
        shown = null
      } else if (baseDirty || !same(v, shown)) {
        // At rest: straight onto the screen's canvas, no copy (copying the
        // whole layer was most of a hover's cost in a software-rendered
        // browser, measured 2026-10-15).
        drawBase(ctx, v)
        shown = { ...v }
        baseDirty = false
        cached = false
      }
      const animating = dropping && drawOver(v, now)
      if (moving || animating || interacting || glide || intro < 1 || lit !== target || baseDirty || !same(v, shown)) frame.current = requestAnimationFrame(loop)
      else running = false
    }
    function schedule() {
      if (running) return
      running = true
      frame.current = requestAnimationFrame(loop)
    }
    kick.current = schedule
    fitNow.current = () => {
      touched.current = false
      const to = fitted()
      fitK = to.k
      if (still) view.current = to
      else glide = { from: { ...view.current }, to, at: performance.now() }
      baseDirty = true
      schedule()
    }

    const ro = new ResizeObserver(resize)
    ro.observe(box)
    resize()
    // A theme change repaints in its colours.
    const mo = new MutationObserver(() => { colors = readColors(box); baseDirty = true; schedule() })
    mo.observe(document.documentElement, { attributes: true })
    return () => {
      cancelAnimationFrame(frame.current)
      window.clearTimeout(unhover.current)
      unhover.current = 0
      ro.disconnect()
      mo.disconnect()
      running = false
    }
  }, [sim, graph, selected, mini])

  // Hit-testing, in screen pixels: the nearest dot within reach of the pointer.
  const pick = (cx: number, cy: number): number => {
    const v = view.current
    let best = -1
    let bd = Infinity
    sim.s.nodes.forEach((n, i) => {
      const d = Math.hypot(n.x * v.k + v.tx - cx, n.y * v.k + v.ty - cy) - radiusAt.current(i)
      if (d < 6 && d < bd) { bd = d; best = i }
    })
    return best
  }

  const gesture = useRef<Gesture | null>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const zoomAt = (x: number, y: number, k: number) => {
    const v = view.current
    k = Math.min(20, Math.max(0.05, k))
    touched.current = true
    lastMove.current = performance.now()
    view.current = { k, tx: x - ((x - v.tx) * k) / v.k, ty: y - ((y - v.ty) * k) / v.k }
    kick.current()
  }
  // The wheel, as a native listener: React's is passive, so it could not keep
  // the page from scrolling while the graph zooms. Out of hand it does
  // nothing at all and the page scrolls past.
  const onWheel = useRef<(e: WheelEvent) => void>(() => {})
  onWheel.current = (e) => {
    if (mini || !activeRef.current) return
    e.preventDefault()
    const p = local(e)
    zoomAt(p.x, p.y, view.current.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)))
  }
  useEffect(() => {
    const cv = canvas.current
    if (!cv) return
    const wheel = (e: WheelEvent) => onWheel.current(e)
    cv.addEventListener('wheel', wheel, { passive: false })
    return () => cv.removeEventListener('wheel', wheel)
  }, [])
  // A click anywhere outside lets it go.
  useEffect(() => {
    if (!active) return
    const down = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) activate(false)
    }
    document.addEventListener('pointerdown', down, true)
    return () => document.removeEventListener('pointerdown', down, true)
  }, [active])
  const panBy = (dx: number, dy: number) => {
    touched.current = true
    lastMove.current = performance.now()
    view.current = { ...view.current, tx: view.current.tx + dx, ty: view.current.ty + dy }
    kick.current()
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (mini) return
    if (!activeRef.current) {
      if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault()
        activate(true)
      }
      return
    }
    const cv = canvas.current
    const cx = (cv?.clientWidth ?? 0) / 2
    const cy = (cv?.clientHeight ?? 0) / 2
    const step = 48
    switch (e.key) {
      case 'Escape':
        // Only the graph lets go; whatever else Escape closes stays open.
        e.stopPropagation()
        activate(false)
        break
      case '+':
      case '=':
        zoomAt(cx, cy, view.current.k * 1.25)
        break
      case '-':
      case '_':
        zoomAt(cx, cy, view.current.k / 1.25)
        break
      case '0':
        fitNow.current()
        break
      case 'ArrowLeft': panBy(step, 0); break
      case 'ArrowRight': panBy(-step, 0); break
      case 'ArrowUp': panBy(0, step); break
      case 'ArrowDown': panBy(0, -step); break
      default:
        return
    }
    e.preventDefault()
  }

  const release = () => {
    const g = gesture.current
    if (g?.kind === 'node') {
      const n = sim.s.nodes[g.i]
      if (n) { delete n.fx; delete n.fy }
    }
  }

  return (
    <div
      ref={wrap}
      className={`group relative min-h-0 overflow-hidden outline-none ${mini ? '' : active ? 'ring-2 ring-accent/60' : 'focus-visible:ring-2 focus-visible:ring-accent/40'} ${className}`}
      data-brain-graph={mini ? 'mini' : 'full'}
      data-brain-active={mini ? undefined : active ? 'true' : 'false'}
      tabIndex={mini ? undefined : 0}
      role={mini ? undefined : 'group'}
      aria-label={mini ? undefined : active
        ? 'Second Brain graph, in hand: arrows pan, plus and minus zoom, 0 fits, Escape lets go'
        : 'Second Brain graph: press Enter to zoom and move it'}
      onKeyDown={onKey}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) activate(false)
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse' && !gesture.current) activate(false)
      }}
    >
      <canvas
        ref={canvas}
        role="img"
        aria-label={ariaLabel ?? `Second Brain graph: ${graph.nodes.length} nodes`}
        className={`absolute left-0 top-0 block ${onSelect ? 'cursor-pointer' : ''} ${mini || !active ? '' : 'touch-none'}`}
        onPointerDown={(e) => {
          if (mini) return
          wrap.current?.focus({ preventScroll: true })
          const p = local(e)
          pointers.current.set(e.pointerId, p)
          e.currentTarget.setPointerCapture?.(e.pointerId)
          if (pointers.current.size === 2) {
            if (!activeRef.current) return
            // Two fingers: a pinch, whatever the first one was doing.
            release()
            const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }]
            const v = view.current
            gesture.current = { kind: 'pinch', d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), k: v.k, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, tx: v.tx, ty: v.ty }
            return
          }
          const i = pick(p.x, p.y)
          gesture.current = i >= 0
            ? { kind: 'node', i, x: p.x, y: p.y, moved: false }
            : { kind: 'pan', x: p.x, y: p.y, tx: view.current.tx, ty: view.current.ty, moved: false }
        }}
        onPointerMove={(e) => {
          const p = local(e)
          if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, p)
          const g = gesture.current
          if (g?.kind === 'pinch' && pointers.current.size >= 2) {
            const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }]
            const k = Math.min(20, Math.max(0.05, g.k * (Math.hypot(a.x - b.x, a.y - b.y) / g.d)))
            const mx = (a.x + b.x) / 2
            const my = (a.y + b.y) / 2
            touched.current = true
            lastMove.current = performance.now()
            // The world point under the pinch's start stays under its middle.
            view.current = { k, tx: mx - ((g.mx - g.tx) * k) / g.k, ty: my - ((g.my - g.ty) * k) / g.k }
            kick.current()
            return
          }
          if (g?.kind === 'pan') {
            if (Math.hypot(p.x - g.x, p.y - g.y) > 3) g.moved = true
            if (g.moved) {
              if (!activeRef.current) return
              touched.current = true
              lastMove.current = performance.now()
              view.current = { ...view.current, tx: g.tx + p.x - g.x, ty: g.ty + p.y - g.y }
              kick.current()
              return
            }
          }
          if (g?.kind === 'node') {
            if (Math.hypot(p.x - g.x, p.y - g.y) > 3) g.moved = true
            if (g.moved) {
              if (!activeRef.current) return
              // Hold the dot under the pointer; its neighbours follow on
              // their links, and the rest barely stir.
              const v = view.current
              const n = sim.s.nodes[g.i]!
              n.fx = (p.x - v.tx) / v.k
              n.fy = (p.y - v.ty) / v.k
              touched.current = true
              if (reducedMotion()) { n.x = n.fx; n.y = n.fy; places.current.set(n.id, { x: n.x, y: n.y }) }
              else sim.s.alpha = Math.max(sim.s.alpha, 0.12)
              kick.current()
              return
            }
          }
          const i = pick(p.x, p.y)
          if (i >= 0) {
            window.clearTimeout(unhover.current)
            unhover.current = 0
            if (i !== hover.current) { hover.current = i; kick.current() }
          } else if (hover.current >= 0 && !unhover.current) {
            // Off a dot: the focus lingers a moment, so moving from one dot
            // to the next does not fade the whole graph out and back in.
            unhover.current = window.setTimeout(() => { unhover.current = 0; hover.current = -1; kick.current() }, LINGER_MS)
          }
        }}
        onPointerLeave={() => {
          if (gesture.current) return
          window.clearTimeout(unhover.current)
          unhover.current = 0
          hover.current = -1
          kick.current()
        }}
        onPointerCancel={(e) => { pointers.current.delete(e.pointerId); release(); gesture.current = null }}
        onPointerUp={(e) => {
          pointers.current.delete(e.pointerId)
          const g = gesture.current
          if (g?.kind === 'pinch') {
            if (pointers.current.size === 0) gesture.current = null
            return
          }
          release()
          gesture.current = null
          // A click (no drag) takes the graph in hand; a dot under it opens too.
          if (g && !g.moved && !mini) activate(true)
          if (g?.kind === 'node') {
            if (g.moved) { sim.s.alpha = Math.max(sim.s.alpha, 0.08); kick.current(); return }
            onSelect?.(sim.s.nodes[g.i]!.id)
            return
          }
          if (g?.moved) return
          const p = local(e)
          const i = pick(p.x, p.y)
          if (i >= 0) onSelect?.(sim.s.nodes[i]!.id)
        }}
        onDoubleClick={() => fitNow.current()}
      />
      {!mini && !active && (
        <span
          aria-hidden
          data-brain-hint
          className="pointer-events-none absolute left-2 top-2 rounded-[6px] bg-panel/80 px-1.5 py-0.5 text-[11px] text-fg-muted opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          Click to zoom and move
        </span>
      )}
      {!mini && (
        <button
          type="button"
          onClick={() => fitNow.current()}
          title="Fit the graph to the panel (or double-click it)"
          aria-label="Fit the graph"
          data-brain-fit
          className="absolute bottom-2 right-2 inline-flex h-[26px] items-center gap-1 rounded-[6px] border border-border bg-panel/80 px-2 text-[11.5px] text-fg-muted backdrop-blur-sm hover:border-border-strong hover:text-fg"
        >
          <svg aria-hidden viewBox="0 0 16 16" className="h-[12px] w-[12px]" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" />
          </svg>
          Fit
        </button>
      )}
    </div>
  )
}
