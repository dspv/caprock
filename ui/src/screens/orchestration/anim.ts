/**
 * The graph's motion clock. A single requestAnimationFrame loop drives every
 * in-flight task dot toward its target position along its spoke, with
 * critically-damped easing (no overshoot, always settles). A new "task" frame
 * only updates a dot's targetT — the loop smoothly re-aims from wherever the dot
 * currently is, so there is never a competing animation to cancel (the "damp all
 * motion" + "mid-flight retarget without jitter" requirement).
 */

// Time constant for the damping (ms). Larger = slower, calmer glide.
const TAU = 260

// damp advances `current` toward `target` by dt (ms) using an exponential
// approach: current += (target-current)·(1 - e^(-dt/τ)). Frame-rate independent,
// overshoot-free. Snaps when close enough to avoid asymptotic crawl.
export function damp(current: number, target: number, dtMs: number, tau = TAU): number {
  const next = current + (target - current) * (1 - Math.exp(-dtMs / tau))
  return Math.abs(target - next) < 0.001 ? target : next
}

export interface Ticker {
  stop(): void
}

// startTicker runs `onFrame(dtMs)` every animation frame until stopped. The
// clock source is injectable for tests (default performance.now via rAF).
export function startTicker(onFrame: (dtMs: number) => void): Ticker {
  let raf = 0
  let last = performance.now()
  const loop = (now: number) => {
    const dt = Math.min(now - last, 64) // clamp huge gaps (tab was backgrounded)
    last = now
    onFrame(dt)
    raf = requestAnimationFrame(loop)
  }
  raf = requestAnimationFrame(loop)
  return { stop: () => cancelAnimationFrame(raf) }
}

// DotMotion tracks the damped t (0..1 along a spoke) for each task id and steps
// them toward per-task targets. Pure state + a step function so it is unit
// testable without a real clock. A newly-seen dot starts at its target (no glide
// on first paint); subsequent target changes glide.
export class DotMotion {
  private cur = new Map<string, number>()

  // setTarget records the goal t for a task; seeds current=target on first sight.
  setTarget(id: string, target: number) {
    if (!this.cur.has(id)) this.cur.set(id, target)
    this.targets.set(id, target)
  }
  private targets = new Map<string, number>()

  // step damps every tracked dot toward its target by dt ms; drops dots whose
  // task disappeared. Returns whether anything is still moving.
  step(dtMs: number, aliveIds: Set<string>): boolean {
    let moving = false
    for (const id of Array.from(this.cur.keys())) {
      if (!aliveIds.has(id)) {
        this.cur.delete(id)
        this.targets.delete(id)
        continue
      }
      const target = this.targets.get(id) ?? this.cur.get(id)!
      const next = damp(this.cur.get(id)!, target, dtMs)
      if (next !== this.cur.get(id)) moving = true
      this.cur.set(id, next)
    }
    return moving
  }

  get(id: string): number | undefined {
    return this.cur.get(id)
  }
}
