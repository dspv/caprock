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
})
