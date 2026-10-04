import { describe, expect, it } from 'vitest'
import { PHOTO_MAX_SIDE, fitWithin, needsDownscale } from './downscale'

describe('making a phone photo fit to send', () => {
  it('brings a 12 MP photo down to the longest side, keeping its shape', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: PHOTO_MAX_SIDE, height: 1536 })
    expect(fitWithin(3024, 4032)).toEqual({ width: 1536, height: PHOTO_MAX_SIDE })
  })

  it('never enlarges a small one', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 })
  })

  it('leaves a small, light photo as it is, and re-encodes a large or heavy one', () => {
    expect(needsDownscale(1200, 900, 400_000)).toBe(false)
    expect(needsDownscale(4032, 3024, 400_000)).toBe(true)
    expect(needsDownscale(1200, 900, 4_000_000)).toBe(true)
  })
})
