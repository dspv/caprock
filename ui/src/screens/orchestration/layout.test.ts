import { describe, expect, it } from 'vitest'
import { angleFor, geometry, phaseT, pointOnSpoke, ringPositions, slotCount, MIN_SLOTS } from './layout'

describe('orchestration layout', () => {
  const g = geometry({ width: 800, height: 600 })

  it('keeps a small ring at MIN_SLOTS so a lone worker is not alone', () => {
    expect(slotCount(1)).toBe(MIN_SLOTS)
    expect(slotCount(MIN_SLOTS + 3)).toBe(MIN_SLOTS + 3)
  })

  it('starts at the top and goes clockwise', () => {
    // slot 0 of 4 → angle -π/2 (top). Its y is above center.
    const a0 = angleFor(0, 4)
    expect(a0).toBeCloseTo(-Math.PI / 2)
  })

  // THE anti-jitter invariant: adding a new worker must NOT move existing ones.
  it('does not move existing nodes when a new worker appears', () => {
    const reg1 = ['worker-1', 'worker-2']
    const active1 = new Set(reg1)
    const before = ringPositions(reg1, active1, g)

    // A third worker joins — registry grows, but existing slots keep their index.
    const reg2 = ['worker-1', 'worker-2', 'worker-3']
    const active2 = new Set(reg2)
    const after = ringPositions(reg2, active2, g)

    for (const id of reg1) {
      const b = before.find((n) => n.id === id)!
      const a = after.find((n) => n.id === id)!
      expect(a.x).toBeCloseTo(b.x)
      expect(a.y).toBeCloseTo(b.y)
      expect(a.angle).toBeCloseTo(b.angle)
    }
  })

  // A worker leaving (dropping out of `active`) must not shift the others.
  it('does not move remaining nodes when a worker leaves', () => {
    const registry = ['worker-1', 'worker-2', 'worker-3']
    const before = ringPositions(registry, new Set(registry), g)
    const after = ringPositions(registry, new Set(['worker-1', 'worker-3']), g)

    for (const id of ['worker-1', 'worker-3']) {
      const b = before.find((n) => n.id === id)!
      const a = after.find((n) => n.id === id)!
      expect(a.x).toBeCloseTo(b.x)
      expect(a.y).toBeCloseTo(b.y)
    }
    expect(after.find((n) => n.id === 'worker-2')).toBeUndefined()
  })

  it('places nodes within the viewport bounds', () => {
    const registry = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    for (const n of ringPositions(registry, new Set(registry), g)) {
      expect(n.x).toBeGreaterThanOrEqual(0)
      expect(n.x).toBeLessThanOrEqual(800)
      expect(n.y).toBeGreaterThanOrEqual(0)
      expect(n.y).toBeLessThanOrEqual(600)
    }
  })

  it('puts the verify gate between center and node', () => {
    const [node] = ringPositions(['w'], new Set(['w']), g)
    const gate = pointOnSpoke(node, g, g.gateT)
    // Gate is closer to the node than the center along the spoke.
    const dCenter = Math.hypot(gate.x - g.cx, gate.y - g.cy)
    const dNode = Math.hypot(gate.x - node.x, gate.y - node.y)
    expect(dCenter).toBeGreaterThan(dNode) // gateT 0.62 > 0.5
  })

  it('orders phase positions so verifying sits at the gate and done past it', () => {
    expect(phaseT('assigned')).toBeLessThan(phaseT('in_progress'))
    expect(phaseT('in_progress')).toBeLessThan(phaseT('verifying'))
    expect(phaseT('verifying')).toBeLessThan(phaseT('done'))
    expect(phaseT('verifying')).toBeCloseTo(g.gateT)
  })
})
