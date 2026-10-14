/**
 * A force-directed layout for Second Brain's graph (ADR-063), small enough
 * to own: many-body repulsion by Barnes–Hut (a quadtree, so 5,000 nodes cost
 * n·log n a tick, not n²), springs along the edges, and a pull to the
 * centre so islands stay on screen. The model is d3-force's, written out so
 * the dashboard takes no dependency for it.
 *
 * Positions survive a new graph: a node already placed keeps its place, a
 * new one starts beside a neighbour, so a memory dropping in does not
 * reshuffle the picture.
 */

export interface SimNode {
  id: number
  x: number
  y: number
  vx: number
  vy: number
  /** Drawn radius; repulsion does not use it. */
  r: number
}

export interface SimLink {
  /** Indexes into nodes. */
  s: number
  t: number
}

export interface SimOptions {
  /** Many-body strength, negative to repel. */
  charge?: number
  /** Rest length of a spring. */
  distance?: number
  /** Pull towards (0, 0). */
  gravity?: number
  /** Barnes–Hut accuracy: larger is faster and coarser. */
  theta?: number
}

const ALPHA_MIN = 0.002
const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / 300)
const VELOCITY_DECAY = 0.4

interface Quad {
  x0: number
  y0: number
  size: number
  /** Centre of mass and mass (node count). */
  cx: number
  cy: number
  mass: number
  /** A leaf's node index, -1 for an inner quad or an empty one. */
  body: number
  /** More nodes at the same leaf (coincident points). */
  extra: number[] | null
  kids: (Quad | null)[] | null
}

function quad(x0: number, y0: number, size: number): Quad {
  return { x0, y0, size, cx: 0, cy: 0, mass: 0, body: -1, extra: null, kids: null }
}

function insert(q: Quad, i: number, nodes: SimNode[], depth: number): void {
  const n = nodes[i]!
  if (q.kids === null && q.body === -1 && q.mass === 0) {
    q.body = i
    q.mass = 1
    q.cx = n.x
    q.cy = n.y
    return
  }
  // Update the aggregate on the way down.
  q.cx = (q.cx * q.mass + n.x) / (q.mass + 1)
  q.cy = (q.cy * q.mass + n.y) / (q.mass + 1)
  q.mass += 1
  if (q.kids === null) {
    // A leaf holding one body: split it, unless the two coincide or the tree
    // is already deep, when the leaf just carries both.
    const b = nodes[q.body]!
    if (depth > 24 || (Math.abs(b.x - n.x) < 1e-6 && Math.abs(b.y - n.y) < 1e-6)) {
      ;(q.extra ??= []).push(i)
      return
    }
    const old = q.body
    q.body = -1
    q.kids = [null, null, null, null]
    place(q, old, nodes, depth)
    for (const e of q.extra ?? []) place(q, e, nodes, depth)
    q.extra = null
  }
  place(q, i, nodes, depth)
}

function place(q: Quad, i: number, nodes: SimNode[], depth: number): void {
  const h = q.size / 2
  const n = nodes[i]!
  const right = n.x >= q.x0 + h ? 1 : 0
  const down = n.y >= q.y0 + h ? 1 : 0
  const k = right + 2 * down
  let c = q.kids![k]!
  if (c === null) {
    c = quad(q.x0 + right * h, q.y0 + down * h, h)
    q.kids![k] = c
  }
  insert(c, i, nodes, depth + 1)
}

export class Simulation {
  readonly nodes: SimNode[]
  readonly links: SimLink[]
  alpha = 1
  private readonly charge: number
  private readonly distance: number
  private readonly gravity: number
  private readonly theta2: number
  private readonly bias: Float64Array
  private readonly strength: Float64Array

  constructor(nodes: SimNode[], links: SimLink[], o: SimOptions = {}) {
    this.nodes = nodes
    this.links = links
    this.charge = o.charge ?? -40
    this.distance = o.distance ?? 30
    this.gravity = o.gravity ?? 0.04
    this.theta2 = (o.theta ?? 0.9) ** 2
    const count = new Float64Array(nodes.length)
    for (const l of links) {
      count[l.s] = count[l.s]! + 1
      count[l.t] = count[l.t]! + 1
    }
    this.bias = new Float64Array(links.length)
    this.strength = new Float64Array(links.length)
    links.forEach((l, i) => {
      this.bias[i] = count[l.s]! / (count[l.s]! + count[l.t]!)
      this.strength[i] = 1 / Math.min(count[l.s]!, count[l.t]!)
    })
  }

  /** Settled enough to stop drawing frames for it. */
  get done(): boolean {
    return this.alpha < ALPHA_MIN
  }

  /** Wake it again, as after new nodes arrive. */
  reheat(alpha = 0.6): void {
    this.alpha = Math.max(this.alpha, alpha)
  }

  tick(): void {
    const { nodes, links, alpha } = this
    if (nodes.length === 0) return
    // Springs.
    for (let i = 0; i < links.length; i++) {
      const s = nodes[links[i]!.s]!
      const t = nodes[links[i]!.t]!
      let dx = t.x + t.vx - s.x - s.vx
      let dy = t.y + t.vy - s.y - s.vy
      if (dx === 0 && dy === 0) {
        dx = 1e-3
        dy = 1e-3
      }
      const len = Math.sqrt(dx * dx + dy * dy)
      const f = ((len - this.distance) / len) * alpha * this.strength[i]!
      dx *= f
      dy *= f
      const b = this.bias[i]!
      t.vx -= dx * b
      t.vy -= dy * b
      s.vx += dx * (1 - b)
      s.vy += dy * (1 - b)
    }
    // Repulsion, by the quadtree.
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const n of nodes) {
      if (n.x < x0) x0 = n.x
      if (n.y < y0) y0 = n.y
      if (n.x > x1) x1 = n.x
      if (n.y > y1) y1 = n.y
    }
    const size = Math.max(x1 - x0, y1 - y0, 1) + 1
    const root = quad(x0, y0, size)
    for (let i = 0; i < nodes.length; i++) insert(root, i, nodes, 0)
    const k = this.charge * alpha
    for (let i = 0; i < nodes.length; i++) this.repel(root, i, k)
    // Gravity, then move.
    const g = this.gravity * alpha
    for (const n of nodes) {
      n.vx -= n.x * g
      n.vy -= n.y * g
      n.vx *= 1 - VELOCITY_DECAY
      n.vy *= 1 - VELOCITY_DECAY
      n.x += n.vx
      n.y += n.vy
    }
    this.alpha += (0 - this.alpha) * ALPHA_DECAY
  }

  private repel(q: Quad, i: number, k: number): void {
    const n = this.nodes[i]!
    const stack: Quad[] = [q]
    while (stack.length) {
      const c = stack.pop()!
      if (c.mass === 0) continue
      let dx = c.cx - n.x
      let dy = c.cy - n.y
      let d2 = dx * dx + dy * dy
      const leaf = c.kids === null
      if (!leaf && (c.size * c.size) / Math.max(d2, 1e-9) >= this.theta2) {
        for (const kid of c.kids!) if (kid) stack.push(kid)
        continue
      }
      let mass = c.mass
      if (leaf && (c.body === i || c.extra?.includes(i))) {
        // The node itself is in this leaf: the rest of the leaf, if any,
        // pushes it from a jittered point so coincident nodes part.
        mass -= 1
        if (mass <= 0) continue
        dx = (i % 7) - 3 || 1
        dy = (i % 5) - 2 || 1
        d2 = dx * dx + dy * dy
      }
      if (d2 < 1) d2 = 1
      const f = (k * mass) / d2
      n.vx += dx * f
      n.vy += dy * f
    }
  }
}

/** The bounding box of nodes, for fitting a view to them. */
export function bounds(nodes: readonly SimNode[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const n of nodes) {
    x0 = Math.min(x0, n.x - n.r)
    y0 = Math.min(y0, n.y - n.r)
    x1 = Math.max(x1, n.x + n.r)
    y1 = Math.max(y1, n.y + n.r)
  }
  if (!isFinite(x0)) return { x0: -1, y0: -1, x1: 1, y1: 1 }
  return { x0, y0, x1, y1 }
}

/**
 * Nodes for a graph, keeping the places of the ones already laid out
 * (`prev`), and starting a new one next to a neighbour already placed, else
 * on a phyllotaxis spiral (an even, deterministic spread).
 */
export function seed(
  ids: readonly number[],
  radius: (i: number) => number,
  links: readonly SimLink[],
  prev: ReadonlyMap<number, { x: number; y: number }>,
): SimNode[] {
  const nodes: SimNode[] = ids.map((id, i) => {
    const p = prev.get(id)
    return { id, x: p?.x ?? NaN, y: p?.y ?? NaN, vx: 0, vy: 0, r: radius(i) }
  })
  const nb: number[][] = ids.map(() => [])
  for (const l of links) {
    nb[l.s]!.push(l.t)
    nb[l.t]!.push(l.s)
  }
  const step = Math.PI * (3 - Math.sqrt(5))
  nodes.forEach((n, i) => {
    if (!isNaN(n.x)) return
    const near = nb[i]!.map((j) => nodes[j]!).find((m) => !isNaN(m.x))
    if (near) {
      const a = (i * step) % (2 * Math.PI)
      n.x = near.x + Math.cos(a) * 12
      n.y = near.y + Math.sin(a) * 12
      return
    }
    const r = 10 * Math.sqrt(0.5 + i)
    n.x = r * Math.cos(i * step)
    n.y = r * Math.sin(i * step)
  })
  return nodes
}
