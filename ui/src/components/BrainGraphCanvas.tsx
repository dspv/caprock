/**
 * Second Brain drawn (ADR-063): the graph on a canvas, laid out by
 * lib/forcegraph. The `#/brain` screen's Graph view and the sidebar's
 * mini-graph are this one component; `mini` drops the labels, the pan and
 * the zoom.
 *
 * Built for thousands of nodes: one canvas, edges in one path, nodes in one
 * path per colour, labels only for the nodes that matter at this zoom (the
 * most linked topics and projects, the one hovered, the one opened and its
 * neighbours), and frames only while something moves.
 *
 * Read at a glance (owner, 2026-10-15: "it must look perfect"; the old
 * picture piled labels onto the hubs and flung dots across an empty
 * canvas):
 *
 * - **Clusters.** Each memory is pulled towards its project, and the
 *   projects sit on a ring around the middle, so a project reads as one
 *   cluster; the view fits itself to the graph until it is moved by hand.
 * - **Size is links, colour is kind.** A dot's size follows its degree; a
 *   memory is filled in its kind's colour, a topic is an open ring, a
 *   project a larger ring in the text colour.
 * - **Few labels.** Only the hubs are named at rest — every project and the
 *   most linked topics — with room kept for their labels (a collision
 *   radius). A memory is named on hover (the tooltip) or when it, or a
 *   neighbour, is opened.
 * - **Focus.** Edges are faint at rest. Hovering or opening a node lights
 *   its links and neighbours and dims the rest to about a quarter.
 *
 * The Pensieve (the owner's picture, translated: "memories drawn out with a
 * wand and laid in the Pensieve"): a memory that arrives while the graph is
 * on screen drops in from above, and a ring spreads where it lands. With
 * prefers-reduced-motion it is simply there.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { BrainGraph, BrainKind, BrainNode } from '@/lib/api'
import { isEntity, KIND_COLOR } from '@/lib/brain'
import { bounds, seed, Simulation, type SimLink, type SimNode } from '@/lib/forcegraph'

const DROP_MS = 900
const RIPPLE_MS = 900
/** Topics named at the zoom the view opens at, besides every project; more as one zooms in. */
const LABELS_BASE = 8
/** A focus names its neighbouring memories only when it has at most this many. */
const FEW = 6
/** How much of the rest stays visible while a node has the focus. */
const DIM = 0.22
const LABEL_FONT = '11.5px ui-sans-serif, system-ui, -apple-system, sans-serif'
const LABEL_FONT_HUB = '600 12.5px ui-sans-serif, system-ui, -apple-system, sans-serif'

interface View { k: number; tx: number; ty: number }

function reducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/** Resolves the kind colours (CSS variables built with color-mix) to strings a canvas takes. */
export function readColors(el: HTMLElement): Record<string, string> & { edge: string; label: string; fg: string; ring: string; halo: string } {
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
  }
  probe.remove()
  return res
}

export interface BrainGraphCanvasProps {
  graph: BrainGraph
  selected?: number
  onSelect?: (id: number) => void
  /** The sidebar's small one: no labels, no pan or zoom, fitted. */
  mini?: boolean
  className?: string
  ariaLabel?: string
}

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
  const [tip, setTip] = useState<{ x: number; y: number; node: BrainNode } | null>(null)
  const frame = useRef(0)
  const kick = useRef<() => void>(() => {})
  const redraw = useRef<() => void>(() => {})
  // When the view last moved by hand: while it moves the base layer is scaled, not redrawn.
  const lastMove = useRef(0)

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n] as const)), [graph])

  const sim = useMemo(() => {
    const ids = graph.nodes.map((n) => n.id)
    const index = new Map(ids.map((id, i) => [id, i] as const))
    const links: SimLink[] = []
    for (const e of graph.edges) {
      const s = index.get(e.from)
      const t = index.get(e.to)
      if (s !== undefined && t !== undefined && s !== t) links.push({ s, t })
    }
    const radius = (i: number) => {
      const n = graph.nodes[i]!
      const deg = Math.sqrt(n.degree ?? 0)
      if (n.kind === 'project') return Math.min(6 + deg * 1.2, mini ? 7 : 16)
      if (isEntity(n.kind)) return Math.min(3 + deg * 1.1, mini ? 5 : 11)
      return Math.min(3 + deg * 0.8 + (n.pinned ? 1 : 0), mini ? 4 : 7)
    }
    const nodes = seed(ids, radius, links, places.current)
    // Projects on a ring, most linked first; each memory pulled to its own.
    const projects = graph.nodes
      .map((n, i) => ({ n, i }))
      .filter((x) => x.n.kind === 'project')
      .sort((a, b) => (b.n.degree ?? 0) - (a.n.degree ?? 0))
    const ringR = projects.length > 1 ? (mini ? 30 : 90) + (mini ? 6 : 26) * projects.length : 0
    const anchor = new Map<number, { x: number; y: number }>()
    projects.forEach(({ i }, k) => {
      const a = (k / projects.length) * Math.PI * 2 - Math.PI / 2
      const at = { x: Math.cos(a) * ringR, y: Math.sin(a) * ringR }
      anchor.set(i, at)
      Object.assign(nodes[i]!, { ax: at.x, ay: at.y, pull: 0.25 })
    })
    for (const l of links) {
      for (const [m, pj] of [[l.s, l.t], [l.t, l.s]] as const) {
        const at = anchor.get(pj)
        if (at && !isEntity(graph.nodes[m]!.kind)) Object.assign(nodes[m]!, { ax: at.x, ay: at.y, pull: 0.06 })
      }
    }
    // Room for a hub's label; a little air around everything else.
    nodes.forEach((n, i) => {
      const kind = graph.nodes[i]!.kind
      n.cr = n.r + (mini ? 1 : kind === 'project' ? 16 : kind === 'topic' ? 8 : 3)
    })
    const s = new Simulation(nodes, links, mini ? { charge: -18, distance: 14, gravity: 0.12 } : { charge: -45, distance: 28, gravity: 0.03 })
    if (nodes.every((n) => places.current.has(n.id))) s.alpha = 0.3
    // A first look settles off screen briefly, so it opens on a shape rather
    // than a burst; the rest of the settling is drawn.
    const warm = mini ? 120 : nodes.length > 1500 ? 20 : 60
    if (!places.current.size) for (let i = 0; i < warm && !s.done; i++) s.tick()
    // New nodes after the first paint drop in.
    if (seen.current && !reducedMotion()) {
      const now = performance.now()
      for (const n of graph.nodes) if (!seen.current.has(n.id) && !isEntity(n.kind)) born.current.set(n.id, now)
    }
    seen.current = new Set(ids)
    return s
  }, [graph, mini])

  useEffect(() => {
    const cv = canvas.current
    const box = wrap.current
    if (!cv || !box) return
    const ctx = cv.getContext('2d')
    if (!ctx) return // jsdom, or a canvas the browser refused
    let colors = readColors(box)
    let w = 0
    let h = 0
    const dpr = () => window.devicePixelRatio || 1
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
      baseDirty = true
      schedule()
    }
    const fit = () => {
      const b = bounds(sim.nodes)
      const pad = mini ? 8 : 40
      const k = Math.min((w - pad * 2) / Math.max(b.x1 - b.x0, 1), (h - pad * 2) / Math.max(b.y1 - b.y0, 1), mini ? 4 : 2)
      view.current = { k, tx: w / 2 - ((b.x0 + b.x1) / 2) * k, ty: h / 2 - ((b.y0 + b.y1) / 2) * k }
    }
    // The focus: the hovered node, else the opened one. Its links and
    // neighbours are lit; the rest dims.
    const hoveredId = () => (hover.current >= 0 ? sim.nodes[hover.current]?.id : undefined)
    let focus: number | undefined
    const neighbours = new Set<number>()
    const setFocus = (id: number | undefined) => {
      focus = id
      neighbours.clear()
      if (id === undefined) return
      neighbours.add(id)
      for (const e of graph.edges) {
        if (e.from === id) neighbours.add(e.to)
        if (e.to === id) neighbours.add(e.from)
      }
    }
    setFocus(hoveredId() ?? selected)
    // The labelled: the most linked entities, more as one zooms in.
    const ranked = sim.nodes
      .map((n, i) => ({ n, i, node: graph.nodes[i]! }))
      .filter((x) => isEntity(x.node.kind))
      .sort((a, b) => (b.node.degree ?? 0) - (a.node.degree ?? 0))

    // Two layers. The base — edges, nodes, the opened node's links, the
    // labels — is drawn into a canvas of its own only when it changes: the
    // layout moved, the selection or the colours changed, or a pan or zoom
    // came to rest. Every frame copies it, scaled while the view moves, and
    // draws the light things on top: the hovered node and memories dropping
    // in. Stroking thousands of edges is the expensive part (about 150 ms for
    // 9,000 in a software-rendered browser, measured 2026-10-14), so it is
    // done once per change, not once per frame.
    const base = document.createElement('canvas')
    const bctx = base.getContext('2d')
    let baseView: View | null = null
    let baseDirty = true
    const minR = (v: View) => 1.6 / v.k
    // A node's drawn radius in world units: never under 1.6 px on screen,
    // never over 2.5 times its own size, so zooming in spreads the graph
    // rather than inflating it.
    const rad = (n: SimNode, v: View) => Math.max(Math.min(n.r, (n.r * 2.5) / v.k), minR(v))

    const label = (c: CanvasRenderingContext2D, v: View, i: number, strong: boolean) => {
      const n = sim.nodes[i]!
      const x = n.x * v.k + v.tx + rad(n, v) * v.k + 4
      const y = n.y * v.k + v.ty
      if (x < -200 || x > w + 10 || y < -10 || y > h + 10) return
      const title = graph.nodes[i]!.title
      const text = title.length > 42 ? title.slice(0, 41) + '…' : title
      const project = graph.nodes[i]!.kind === 'project'
      c.font = project ? LABEL_FONT_HUB : LABEL_FONT
      c.globalAlpha = 1
      c.lineWidth = 3.5
      c.lineJoin = 'round'
      c.strokeStyle = colors.halo
      c.strokeText(text, x, y)
      c.fillStyle = project ? colors.fg : strong ? colors.ring : colors.label
      c.fillText(text, x, y)
    }
    const ring = (c: CanvasRenderingContext2D, v: View, n: SimNode) => {
      c.globalAlpha = 1
      c.strokeStyle = colors.ring
      c.lineWidth = 2 / v.k
      c.beginPath()
      c.arc(n.x, n.y, rad(n, v) + 3 / v.k, 0, Math.PI * 2)
      c.stroke()
    }

    const drawBase = (c: CanvasRenderingContext2D, v: View, edges: boolean) => {
      const d = dpr()
      c.setTransform(1, 0, 0, 1, 0, 0)
      c.clearRect(0, 0, base.width, base.height)
      c.setTransform(d * v.k, 0, 0, d * v.k, d * v.tx, d * v.ty)
      const nodes = sim.nodes
      const lit = focus !== undefined
      if (edges) {
        // Faint at rest (each project's spokes would otherwise be a fan of
        // solid lines); fainter still behind a focus.
        c.globalAlpha = (mini ? 0.3 : nodes.length > 1500 ? 0.1 : 0.16) * (lit ? 0.6 : 1)
        c.strokeStyle = colors.edge
        c.lineWidth = 1 / v.k
        c.beginPath()
        for (const l of sim.links) {
          const s = nodes[l.s]!
          const t = nodes[l.t]!
          c.moveTo(s.x, s.y)
          c.lineTo(t.x, t.y)
        }
        c.stroke()
      }
      if (lit) {
        c.globalAlpha = 0.85
        c.strokeStyle = colors.ring
        c.lineWidth = 1.4 / v.k
        c.beginPath()
        for (const l of sim.links) {
          const s = nodes[l.s]!
          const t = nodes[l.t]!
          if (s.id === focus || t.id === focus) {
            c.moveTo(s.x, s.y)
            c.lineTo(t.x, t.y)
          }
        }
        c.stroke()
      }
      // Memories filled in their kind's colour, one path per kind; topics
      // and projects as rings. Behind a focus, all but its neighbourhood dim.
      const groups = new Map<string, number[]>()
      nodes.forEach((_, i) => {
        const kind = graph.nodes[i]!.kind
        const list = groups.get(kind)
        if (list) list.push(i)
        else groups.set(kind, [i])
      })
      for (const [kind, list] of groups) {
        const color = colors[kind as BrainKind] ?? '#888'
        const entity = isEntity(kind as BrainKind)
        for (const strong of lit ? [false, true] : [true]) {
          c.globalAlpha = lit && !strong ? DIM : 1
          c.beginPath()
          for (const i of list) {
            const n = nodes[i]!
            if (born.current.has(n.id) || (lit && strong !== neighbours.has(n.id))) continue
            const r = rad(n, v)
            c.moveTo(n.x + r, n.y)
            c.arc(n.x, n.y, r, 0, Math.PI * 2)
          }
          if (entity) {
            c.fillStyle = colors.halo
            c.fill()
            c.strokeStyle = color
            c.lineWidth = (kind === 'project' ? 2.2 : 1.4) / v.k
            c.stroke()
          } else {
            c.fillStyle = color
            c.fill()
          }
        }
      }
      const sel = selected === undefined ? -1 : nodes.findIndex((n) => n.id === selected)
      if (sel >= 0) ring(c, v, nodes[sel]!)
      // Labels, in screen space so they stay readable at every zoom.
      if (!mini) {
        c.setTransform(d, 0, 0, d, 0, 0)
        c.font = LABEL_FONT
        c.textBaseline = 'middle'
        // The hubs only: every project, the most linked topics (more as one
        // zooms in); behind a focus, its neighbourhood instead.
        const limit = Math.round(LABELS_BASE * Math.max(1, v.k * v.k))
        const done = new Set<number>()
        const put = (i: number, strong = false) => { if (!done.has(i)) { done.add(i); label(c, v, i, strong) } }
        if (lit) {
          // A hub's memories would pile up: name its entities, and its
          // memories only when there are a few.
          const near = nodes.map((_, i) => i).filter((i) => neighbours.has(nodes[i]!.id) && nodes[i]!.id !== focus)
          const mems = near.filter((i) => !isEntity(graph.nodes[i]!.kind))
          for (const i of near) if (isEntity(graph.nodes[i]!.kind) || mems.length <= FEW) put(i)
          const fi = nodes.findIndex((n) => n.id === focus)
          // The hovered memory is named by its tooltip; an opened one, or a hub, here.
          if (fi >= 0 && (focus === selected || isEntity(graph.nodes[fi]!.kind))) { done.delete(fi); put(fi, true) }
        } else {
          for (const r of ranked) if (r.node.kind === 'project') put(r.i, true)
          for (const r of ranked.filter((x) => x.node.kind !== 'project').slice(0, limit)) put(r.i)
        }
        if (sel >= 0 && !lit) { done.delete(sel); put(sel, true) }
      }
      c.globalAlpha = 1
    }

    /** The light layer: memories dropping in, the hovered node. True while something animates. */
    const drawOver = (v: View, now: number): boolean => {
      const d = dpr()
      ctx.setTransform(d * v.k, 0, 0, d * v.k, d * v.tx, d * v.ty)
      let animating = false
      for (const [id, at] of born.current) {
        const i = sim.nodes.findIndex((n) => n.id === id)
        if (i < 0) { born.current.delete(id); continue }
        const n = sim.nodes[i]!
        const t = now - at
        if (t > DROP_MS + RIPPLE_MS) { born.current.delete(id); baseDirty = true; continue }
        animating = true
        const p = Math.min(1, t / DROP_MS)
        const ease = 1 - Math.pow(1 - p, 3)
        const fall = ((1 - ease) * (mini ? 40 : 90)) / v.k
        ctx.globalAlpha = 0.25 + 0.75 * ease
        ctx.fillStyle = colors[graph.nodes[i]!.kind] ?? '#888'
        ctx.beginPath()
        ctx.arc(n.x, n.y - fall, rad(n, v) * (1 + (1 - ease) * 0.6), 0, Math.PI * 2)
        ctx.fill()
        if (t > DROP_MS * 0.8) {
          const q = Math.min(1, (t - DROP_MS * 0.8) / RIPPLE_MS)
          ctx.globalAlpha = 0.6 * (1 - q)
          ctx.strokeStyle = colors.ring
          ctx.lineWidth = 1.2 / v.k
          ctx.beginPath()
          ctx.arc(n.x, n.y, n.r + ((mini ? 10 : 18) * q) / Math.min(v.k, 1.5), 0, Math.PI * 2)
          ctx.stroke()
        }
      }
      const hv = hover.current >= 0 ? sim.nodes[hover.current] : undefined
      if (hv) ring(ctx, v, hv)
      ctx.globalAlpha = 1
      return animating
    }

    const same = (a: View, b: View | null) => !!b && a.k === b.k && a.tx === b.tx && a.ty === b.ty

    let running = false
    const loop = (now: number) => {
      frame.current = 0
      let moving = false
      // The focus follows the pointer; a big graph keeps its base (the
      // relight would redraw thousands of edges per move).
      const want = (sim.links.length <= 3000 ? hoveredId() : undefined) ?? selected
      if (want !== focus && !mini) { setFocus(want); baseDirty = true }
      if (!sim.done) {
        // Big graphs take one tick a frame; small ones settle faster.
        const ticks = sim.nodes.length > 2000 ? 1 : sim.nodes.length > 500 ? 2 : 4
        for (let i = 0; i < ticks && !sim.done; i++) sim.tick()
        for (const n of sim.nodes) places.current.set(n.id, { x: n.x, y: n.y })
        if (!touched.current) fit()
        moving = true
        baseDirty = true
      }
      const v = view.current
      const interacting = now - lastMove.current < 160
      if (bctx && (baseDirty || (!same(v, baseView) && !interacting))) {
        // A large graph settles without its edges; they come once it rests.
        drawBase(bctx, v, !moving || sim.links.length <= 3000)
        baseView = { ...v }
        baseDirty = false
      }
      const d = dpr()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, cv.width, cv.height)
      if (baseView) {
        const s = v.k / baseView.k
        ctx.setTransform(s, 0, 0, s, d * (v.tx - baseView.tx * s), d * (v.ty - baseView.ty * s))
        ctx.drawImage(base, 0, 0)
      }
      const animating = drawOver(v, now)
      if (moving || animating || interacting || !same(v, baseView) || baseDirty) frame.current = requestAnimationFrame(loop)
      else running = false
    }
    function schedule() {
      if (running) return
      running = true
      frame.current = requestAnimationFrame(loop)
    }
    kick.current = schedule
    redraw.current = () => { baseDirty = true; schedule() }

    if (reducedMotion()) {
      // No settling on screen: settle first, in slices, then draw once.
      let left = 300
      const slice = () => {
        for (let i = 0; i < 30 && left > 0 && !sim.done; i++, left--) sim.tick()
        if (left > 0 && !sim.done) { frame.current = requestAnimationFrame(slice); return }
        sim.alpha = 0
        for (const n of sim.nodes) places.current.set(n.id, { x: n.x, y: n.y })
        if (!touched.current) fit()
        schedule()
      }
      slice()
    } else {
      schedule()
    }

    const ro = new ResizeObserver(resize)
    ro.observe(box)
    resize()
    if (!touched.current) fit()
    // A theme change repaints in its colours.
    const mo = new MutationObserver(() => { colors = readColors(box); baseDirty = true; schedule() })
    mo.observe(document.documentElement, { attributes: true })
    return () => {
      cancelAnimationFrame(frame.current)
      ro.disconnect()
      mo.disconnect()
      running = false
    }
  }, [sim, graph, selected, mini])

  // Hit-testing: the nearest node within reach of the pointer.
  const pick = (cx: number, cy: number): number => {
    const v = view.current
    const x = (cx - v.tx) / v.k
    const y = (cy - v.ty) / v.k
    let best = -1
    let bd = Infinity
    const reach = 6 / v.k
    sim.nodes.forEach((n, i) => {
      const d = Math.hypot(n.x - x, n.y - y) - Math.max(Math.min(n.r, (n.r * 2.5) / v.k), 1.6 / v.k)
      if (d < reach && d < bd) { bd = d; best = i }
    })
    return best
  }

  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null)
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  return (
    <div ref={wrap} className={`relative min-h-0 overflow-hidden ${className}`} data-brain-graph={mini ? 'mini' : 'full'}>
      <canvas
        ref={canvas}
        role="img"
        aria-label={ariaLabel ?? `Second Brain graph: ${graph.nodes.length} nodes`}
        className={`absolute left-0 top-0 block ${onSelect ? 'cursor-pointer' : ''} ${mini ? '' : 'touch-none'}`}
        onPointerDown={(e) => {
          if (mini) return
          const p = local(e)
          drag.current = { x: p.x, y: p.y, tx: view.current.tx, ty: view.current.ty, moved: false }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          const p = local(e)
          const g = drag.current
          if (g) {
            if (Math.hypot(p.x - g.x, p.y - g.y) > 3) g.moved = true
            if (g.moved) {
              touched.current = true
              lastMove.current = performance.now()
              view.current = { ...view.current, tx: g.tx + p.x - g.x, ty: g.ty + p.y - g.y }
              setTip(null)
              kick.current()
              return
            }
          }
          const i = pick(p.x, p.y)
          if (i !== hover.current) {
            hover.current = i
            kick.current()
          }
          const node = i >= 0 ? byId.get(sim.nodes[i]!.id) : undefined
          setTip(node && !mini ? { x: p.x, y: p.y, node } : null)
        }}
        onPointerLeave={() => { hover.current = -1; setTip(null); kick.current() }}
        onPointerUp={(e) => {
          const g = drag.current
          drag.current = null
          if (g?.moved) return
          const p = local(e)
          const i = pick(p.x, p.y)
          if (i >= 0) onSelect?.(sim.nodes[i]!.id)
        }}
        onWheel={(e) => {
          if (mini) return
          const p = local(e)
          const v = view.current
          const k = Math.min(8, Math.max(0.05, v.k * Math.exp(-e.deltaY * 0.0015)))
          touched.current = true
          lastMove.current = performance.now()
          view.current = { k, tx: p.x - ((p.x - v.tx) * k) / v.k, ty: p.y - ((p.y - v.ty) * k) / v.k }
          kick.current()
        }}
        onDoubleClick={() => { touched.current = false; sim.reheat(0.05); redraw.current() }}
      />
      {tip && (
        <div
          className="pointer-events-none absolute z-10 max-w-[280px] rounded-md border border-border bg-panel px-2 py-1 text-[12px] text-fg shadow-sm"
          style={{ left: Math.min(tip.x + 12, (wrap.current?.clientWidth ?? 0) - 290), top: tip.y + 12 }}
        >
          <span className="text-fg-faint">{tip.node.kind}</span> {tip.node.title}
        </div>
      )}
    </div>
  )
}
