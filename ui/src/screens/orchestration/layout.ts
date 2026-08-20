/**
 * Pure radial-layout math for the orchestration graph. Deterministic, no physics.
 * The anti-jitter core (persona panel's #1 constraint): a node's angular slot is
 * its index in the ever-seen, sorted registry — which only grows — so a node
 * appearing or leaving never moves any other node. Nodes fade in/out at their
 * reserved angle; they never reflow.
 */

export interface Viewport {
  width: number
  height: number
}

export interface NodePos {
  id: string
  x: number
  y: number
  angle: number
}

export interface Geometry {
  cx: number
  cy: number
  r: number // ring radius
  nodeR: number // node circle radius
  gateT: number // verify-gate position along a spoke (0=center, 1=node)
}

// Layout constants. MIN_SLOTS keeps a lone worker from sitting alone — the ring
// always reads as an intentional circle.
export const MIN_SLOTS = 6
const MARGIN = 72
const NODE_R = 38
const GATE_T = 0.62

// geometry computes the ring/center sizing for a viewport. Recomputed only on
// resize (never on data change), so nodes glide only when the window resizes.
export function geometry(vp: Viewport): Geometry {
  const cx = vp.width / 2
  const cy = vp.height / 2
  const r = Math.max(80, Math.min(vp.width, vp.height) / 2 - MARGIN - NODE_R)
  return { cx, cy, r, nodeR: NODE_R, gateT: GATE_T }
}

// slotCount is how many angular slots the ring is divided into: the registry
// size, but never fewer than MIN_SLOTS, so a small graph still looks like a ring.
export function slotCount(registrySize: number): number {
  return Math.max(registrySize, MIN_SLOTS)
}

// angleFor returns the angle (radians) for a node at a given registry slot index,
// out of `slots` total. Starts at the top (-π/2) and goes clockwise. Because the
// slot index comes from the monotonically-growing registry, angles are stable.
export function angleFor(slotIndex: number, slots: number): number {
  return -Math.PI / 2 + (2 * Math.PI * slotIndex) / slots
}

// ringPositions places each id at its reserved angle. `registry` is the stable
// sorted list of every id ever seen (grows only); `active` is who to actually
// place now. Absent-from-active ids are simply not returned, but their angle is
// still reserved (the slot stays empty), so the remaining nodes do not rotate.
export function ringPositions(registry: string[], active: Set<string>, g: Geometry): NodePos[] {
  const slots = slotCount(registry.length)
  const out: NodePos[] = []
  registry.forEach((id, i) => {
    if (!active.has(id)) return
    const angle = angleFor(i, slots)
    out.push({
      id,
      angle,
      x: g.cx + g.r * Math.cos(angle),
      y: g.cy + g.r * Math.sin(angle),
    })
  })
  return out
}

// pointOnSpoke returns the (x,y) at parameter t along the spoke from center to a
// node (t=0 center, t=1 node). Used for task dots and the verify gate.
export function pointOnSpoke(node: NodePos, g: Geometry, t: number): { x: number; y: number } {
  return {
    x: g.cx + (node.x - g.cx) * t,
    y: g.cy + (node.y - g.cy) * t,
  }
}

// The resting parameter t for a task at each phase along its worker's spoke.
// assign near center, in_progress mid, verifying AT the gate, done settled out.
export const PHASE_T: Record<string, number> = {
  assigned: 0.18,
  in_progress: 0.45,
  verifying: GATE_T,
  done: 0.85,
  needs_you: 0.5,
  failed: 0.5,
  inbox: 0.08,
}

export function phaseT(status: string): number {
  return PHASE_T[status] ?? 0.3
}
