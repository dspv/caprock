import { describe, expect, it } from 'vitest'
import { bounds, seed, Simulation, type SimLink } from './forcegraph'

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)

function settle(sim: Simulation, max = 400) {
  for (let i = 0; i < max && !sim.done; i++) sim.tick()
}

describe('force layout', () => {
  it('pulls linked nodes together and pushes the rest apart', () => {
    // Two triangles, joined by nothing.
    const links: SimLink[] = [{ s: 0, t: 1 }, { s: 1, t: 2 }, { s: 0, t: 2 }, { s: 3, t: 4 }, { s: 4, t: 5 }, { s: 3, t: 5 }]
    const nodes = seed([1, 2, 3, 4, 5, 6], () => 3, links, new Map())
    const sim = new Simulation(nodes, links)
    settle(sim)
    expect(sim.done).toBe(true)
    const within = dist(nodes[0]!, nodes[1]!)
    const across = Math.min(...[0, 1, 2].flatMap((i) => [3, 4, 5].map((j) => dist(nodes[i]!, nodes[j]!))))
    expect(within).toBeGreaterThan(5)
    expect(across).toBeGreaterThan(within)
    for (const n of nodes) expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true)
  })

  it('parts nodes that start on the same point', () => {
    const nodes = [1, 2, 3].map((id) => ({ id, x: 0, y: 0, vx: 0, vy: 0, r: 3 }))
    const sim = new Simulation(nodes, [])
    settle(sim)
    expect(dist(nodes[0]!, nodes[1]!)).toBeGreaterThan(1)
    expect(dist(nodes[1]!, nodes[2]!)).toBeGreaterThan(1)
  })

  it('keeps the places it had, and starts a newcomer beside its neighbour', () => {
    const prev = new Map([[10, { x: 100, y: -50 }], [11, { x: 130, y: -40 }]])
    const nodes = seed([10, 11, 12], () => 3, [{ s: 2, t: 0 }], prev)
    expect(nodes[0]).toMatchObject({ x: 100, y: -50 })
    expect(nodes[1]).toMatchObject({ x: 130, y: -40 })
    expect(dist(nodes[2]!, nodes[0]!)).toBeLessThan(15)
  })

  it('lays out five thousand nodes', () => {
    const n = 5000
    const ids = Array.from({ length: n }, (_, i) => i + 1)
    const links: SimLink[] = []
    for (let i = 200; i < n; i++) {
      links.push({ s: i, t: i % 200 }, { s: i, t: (i * 7) % 200 })
    }
    const nodes = seed(ids, () => 3, links, new Map())
    const sim = new Simulation(nodes, links)
    const t0 = performance.now()
    for (let i = 0; i < 10; i++) sim.tick()
    const per = (performance.now() - t0) / 10
    // Logged, not asserted: a shared CI runner's timing is not the product's.
    console.info(`forcegraph: ${n} nodes, ${links.length} links, ${per.toFixed(1)} ms a tick`)
    const b = bounds(nodes)
    expect(Number.isFinite(b.x0) && Number.isFinite(b.x1)).toBe(true)
  })

  it('pulls a node towards its own anchor, so a project reads as a cluster', () => {
    const mk = (id: number, ax: number) => ({ id, x: id * 3, y: 0, vx: 0, vy: 0, r: 3, ax, ay: 0, pull: 0.1 })
    const nodes = [mk(1, -200), mk(2, -200), mk(3, 200), mk(4, 200)]
    const sim = new Simulation(nodes, [], { charge: -5 })
    settle(sim)
    expect(nodes[0]!.x).toBeLessThan(-120)
    expect(nodes[2]!.x).toBeGreaterThan(120)
    expect(dist(nodes[0]!, nodes[1]!)).toBeLessThan(dist(nodes[0]!, nodes[2]!) / 4)
  })

  it('keeps collision circles apart, room for a hub and its label', () => {
    const nodes = [0, 1, 2].map((i) => ({ id: i, x: i * 0.5, y: 0, vx: 0, vy: 0, r: 4, cr: 20 }))
    const sim = new Simulation(nodes, [], { charge: 0, gravity: 0.05 })
    settle(sim)
    for (const [a, b] of [[0, 1], [1, 2], [0, 2]] as const) expect(dist(nodes[a]!, nodes[b]!)).toBeGreaterThan(36)
  })

  it('settles unlinked nodes into an even, round disc whose radius grows with the square root of the count', () => {
    const disc = (n: number) => {
      const nodes = seed(Array.from({ length: n }, (_, i) => i + 1), () => 2, [], new Map())
      const sim = new Simulation(nodes, [], { charge: -48, gravity: 0.36 })
      settle(sim)
      const cx = nodes.reduce((a, m) => a + m.x, 0) / n
      const cy = nodes.reduce((a, m) => a + m.y, 0) / n
      const r = nodes.map((m) => Math.hypot(m.x - cx, m.y - cy))
      const b = bounds(nodes)
      return { max: Math.max(...r), mean: r.reduce((a, x) => a + x, 0) / n, aspect: (b.x1 - b.x0) / (b.y1 - b.y0) }
    }
    const small = disc(100)
    const big = disc(400)
    // An evenly filled disc: the mean distance from the middle is two thirds
    // of the radius (a ring would be near 1, a clump near 0.5 or less).
    for (const d of [small, big]) {
      expect(d.mean / d.max).toBeGreaterThan(0.58)
      expect(d.mean / d.max).toBeLessThan(0.76)
      expect(d.aspect).toBeGreaterThan(0.85)
      expect(d.aspect).toBeLessThan(1.18)
    }
    // Four times the nodes, about twice the radius.
    expect(big.max / small.max).toBeGreaterThan(1.6)
    expect(big.max / small.max).toBeLessThan(2.4)
  })

  it("gives a link its own length and strength", () => {
    const pair = (d: number) => {
      const nodes = seed([1, 2], () => 2, [], new Map())
      const sim = new Simulation(nodes, [{ s: 0, t: 1, d, w: 1 }], { charge: 0, gravity: 0 })
      settle(sim)
      return dist(nodes[0]!, nodes[1]!)
    }
    expect(pair(60)).toBeGreaterThan(pair(10) * 3)
    // A loose tie (w well under 1) lets the push win: the pair ends further apart.
    const loose = (w: number) => {
      const nodes = seed([1, 2], () => 2, [], new Map())
      const sim = new Simulation(nodes, [{ s: 0, t: 1, d: 5, w }], { charge: -30, gravity: 0 })
      settle(sim)
      return dist(nodes[0]!, nodes[1]!)
    }
    expect(loose(0.05)).toBeGreaterThan(loose(1))
  })

  it('keeps a held node where it is held, and its neighbour follows', () => {
    const nodes = seed([1, 2, 3], () => 2, [{ s: 0, t: 1 }], new Map())
    const sim = new Simulation(nodes, [{ s: 0, t: 1, d: 10 }], { charge: -5, gravity: 0.02 })
    settle(sim)
    Object.assign(nodes[0]!, { fx: 200, fy: -80 })
    sim.reheat(0.3)
    settle(sim)
    expect(nodes[0]).toMatchObject({ x: 200, y: -80 })
    expect(dist(nodes[1]!, nodes[0]!)).toBeLessThan(30)
    // The unlinked one stays near the middle.
    expect(Math.hypot(nodes[2]!.x, nodes[2]!.y)).toBeLessThan(100)
  })
})
