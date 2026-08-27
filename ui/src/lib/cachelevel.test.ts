/**
 * The bands exist to describe a real spread, so what matters is that they are
 * exclusive, that the boundaries land where they are documented, and that
 * nothing is said at all when there is nothing to say.
 */
import { describe, expect, it } from 'vitest'
import { cacheLevel } from './cachelevel'

describe('cacheLevel', () => {
  it('names each band at its boundary', () => {
    // Stated as exact edges: a band that drifts by a point turns
    // "outstanding" into a word half the sessions earn.
    expect(cacheLevel(100)?.label).toBe('outstanding')
    expect(cacheLevel(99)?.label).toBe('outstanding')
    expect(cacheLevel(98.9)?.label).toBe('good')
    expect(cacheLevel(95)?.label).toBe('good')
    expect(cacheLevel(94.9)?.label).toBe('ok')
    expect(cacheLevel(85)?.label).toBe('ok')
    expect(cacheLevel(84.9)?.label).toBe('low')
    expect(cacheLevel(6.1)?.label).toBe('low')
  })

  it('says nothing when there is no cache activity', () => {
    // A fresh install has 0%, and "0% low" reads as a fault rather than as
    // "nothing has happened yet".
    expect(cacheLevel(0)).toBeUndefined()
    expect(cacheLevel(undefined)).toBeUndefined()
    expect(cacheLevel(NaN)).toBeUndefined()
    expect(cacheLevel(-1)).toBeUndefined()
  })

  it('colours only what is worth colouring', () => {
    // The middle band is deliberately uncoloured: on this dashboard colour
    // means something, and an ordinary reading is not something.
    expect(cacheLevel(99)?.color).toBe('text-ok')
    expect(cacheLevel(96)?.color).toBe('text-ok')
    expect(cacheLevel(90)?.color).toBe('')
    expect(cacheLevel(50)?.color).toBe('text-warn')
  })

  it('keeps outstanding rare against real data', () => {
    // The owner's 122 sessions, bucketed: 11% sit at 99 or above. A label
    // that fires on most sessions is decoration, so this pins the intent
    // rather than the implementation.
    const sample = [6.1, 40, 49.6, 62, 71, 78, 84, 86, 90, 93.6, 95, 97, 98, 99, 99.4, 99.6]
    const outstanding = sample.filter((p) => cacheLevel(p)?.label === 'outstanding')
    expect(outstanding.length).toBeLessThan(sample.length / 3)
    expect(outstanding.length).toBeGreaterThan(0)
  })
})
