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
    expect(cacheLevel(98.9)?.label).toBe('excellent')
    expect(cacheLevel(98)?.label).toBe('excellent')
    expect(cacheLevel(97.9)?.label).toBe('very good')
    expect(cacheLevel(96)?.label).toBe('very good')
    expect(cacheLevel(95.9)?.label).toBe('good')
    expect(cacheLevel(90)?.label).toBe('good')
    expect(cacheLevel(89.9)?.label).toBe('ok')
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
    // `ok` is deliberately uncoloured: on this dashboard colour means
    // something, and an ordinary reading is not something. The bands above it
    // all read as fine, so they share one colour rather than inventing a
    // gradient — the word carries the distinction, not the hue.
    expect(cacheLevel(99)?.color).toBe('text-ok')
    expect(cacheLevel(98)?.color).toBe('text-ok')
    expect(cacheLevel(96)?.color).toBe('text-ok')
    expect(cacheLevel(90)?.color).toBe('text-ok')
    expect(cacheLevel(87)?.color).toBe('')
    expect(cacheLevel(50)?.color).toBe('text-warn')
  })

  // The words have to read in order, or a reader ranking them by sound gets a
  // different answer from the one the numbers give. "very good" below
  // "excellent" below "outstanding" is the order they were chosen in.
  it('ranks its words in the order the numbers do', () => {
    const order: string[] = []
    for (const p of [99.5, 98.5, 97, 92, 87, 50]) {
      order.push(cacheLevel(p)!.label)
    }
    expect(order).toEqual(['outstanding', 'excellent', 'very good', 'good', 'ok', 'low'])
  })

  it('keeps outstanding off the whole spread', () => {
    // The owner's sessions when this was written: 11% sat at 99 or above.
    // A label that fires on everything is decoration, so this pins the intent.
    //
    // Measured again when the middle bands were added, that share had grown to
    // 59% — the machine's real distribution moved, not the code. This sample
    // is the historical spread and still holds the property that matters here:
    // the top word is not the only word. Whether 99+ should keep a word at all
    // on today's data is an open question recorded in cachelevel.ts.
    const sample = [6.1, 40, 49.6, 62, 71, 78, 84, 86, 90, 93.6, 95, 97, 98, 99, 99.4, 99.6]
    const outstanding = sample.filter((p) => cacheLevel(p)?.label === 'outstanding')
    expect(outstanding.length).toBeLessThan(sample.length / 3)
    expect(outstanding.length).toBeGreaterThan(0)
    // Every band the spread reaches is used: a word nothing lands on is dead
    // code pretending to be a distinction.
    expect(new Set(sample.map((p) => cacheLevel(p)!.label)).size).toBeGreaterThanOrEqual(5)
  })
})
