import { describe, expect, it } from 'vitest'
import { DotMotion, damp } from './anim'

describe('damp', () => {
  it('monotonically approaches the target without overshoot', () => {
    let v = 0
    const target = 1
    let prev = v
    for (let i = 0; i < 200; i++) {
      v = damp(v, target, 16)
      expect(v).toBeGreaterThanOrEqual(prev) // never goes backward (no overshoot)
      expect(v).toBeLessThanOrEqual(target + 1e-9) // never past the target
      prev = v
    }
    expect(v).toBe(target) // snaps to target eventually
  })

  it('works downward too (verify→needs_you moves a dot back)', () => {
    let v = 1
    for (let i = 0; i < 200; i++) v = damp(v, 0.2, 16)
    expect(v).toBeCloseTo(0.2)
  })

  it('is frame-rate independent (bigger dt = more progress per step)', () => {
    const small = damp(0, 1, 16)
    const big = damp(0, 1, 64)
    expect(big).toBeGreaterThan(small)
  })
})

describe('DotMotion', () => {
  it('seeds a new dot at its target (no first-paint glide) then glides on change', () => {
    const m = new DotMotion()
    m.setTarget('t1', 0.18) // assigned
    expect(m.get('t1')).toBe(0.18) // seeded at target
    // task advances to verifying (t=0.62) — now it should glide, not jump
    m.setTarget('t1', 0.62)
    m.step(16, new Set(['t1']))
    const after = m.get('t1')!
    expect(after).toBeGreaterThan(0.18)
    expect(after).toBeLessThan(0.62) // mid-glide, not teleported
  })

  it('settles at the target after enough steps and reports not-moving', () => {
    const m = new DotMotion()
    m.setTarget('t1', 0.18)
    m.setTarget('t1', 0.85)
    let moving = true
    for (let i = 0; i < 300 && moving; i++) moving = m.step(16, new Set(['t1']))
    expect(m.get('t1')).toBeCloseTo(0.85)
    expect(m.step(16, new Set(['t1']))).toBe(false) // settled → nothing moves
  })

  it('drops dots whose task disappeared', () => {
    const m = new DotMotion()
    m.setTarget('t1', 0.5)
    m.step(16, new Set()) // t1 no longer alive
    expect(m.get('t1')).toBeUndefined()
  })

  it('handles a mid-flight retarget without overshoot', () => {
    const m = new DotMotion()
    m.setTarget('t1', 0.18)
    m.setTarget('t1', 0.85)
    m.step(50, new Set(['t1'])) // partway to 0.85
    const mid = m.get('t1')!
    m.setTarget('t1', 0.45) // retarget mid-flight (a verify bounce)
    for (let i = 0; i < 300; i++) m.step(16, new Set(['t1']))
    expect(m.get('t1')).toBeCloseTo(0.45)
    expect(mid).toBeGreaterThan(0.18) // it had moved before the retarget
  })
})
