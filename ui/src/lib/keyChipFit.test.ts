import { describe, expect, it } from 'vitest'
import { chipFits, fitFoldedChips } from './keyChipFit'

describe('a row’s key chip', () => {
  const room = { labelFree: 0, give: 0, overflow: 0, chip: 40, gap: 8 }
  it('stays while the words are whole and nothing spills', () => {
    expect(chipFits(room, true)).toBe(true)
    expect(chipFits({ ...room, labelFree: -12 }, true)).toBe(false)
    expect(chipFits({ ...room, overflow: 20 }, true)).toBe(false)
    // A subpixel is not a cut.
    expect(chipFits({ ...room, labelFree: -0.3 }, true)).toBe(true)
  })
  it('comes back once the spare room holds the chip and its gap', () => {
    expect(chipFits({ ...room, labelFree: 30 }, false)).toBe(false)
    expect(chipFits({ ...room, labelFree: 30, give: 18 }, false)).toBe(true)
    expect(chipFits({ ...room, labelFree: 60, overflow: 20 }, false)).toBe(false)
  })
  it('never flips back and forth at one width', () => {
    // Shown and just fitting; dropped, the same row reads the chip's room as spare.
    const shown = { ...room, labelFree: 0 }
    const dropped = { ...room, labelFree: 48 }
    expect(chipFits(shown, true)).toBe(true)
    expect(chipFits(dropped, false)).toBe(true)
  })
})

describe('the folded row’s keys', () => {
  // Measured at the New agent size: ⇧⌘F ⇧⌘M ⌘0 ⌘, ⇧⌘B, then the theme with no key.
  const mac = [39.5, 39.5, 31.6, 31.6, 39.5, null]
  it('all fit where the columns hold them', () => {
    expect(fitFoldedChips(mac, 214)).toEqual([true, true, true, true, true, false])
  })
  it('drops the widest first, the rightmost of a tie, until the rest fit', () => {
    expect(fitFoldedChips(mac, 210)).toEqual([true, true, true, true, false, false])
    expect(fitFoldedChips(mac, 200)).toEqual([true, false, true, true, false, false])
    expect(fitFoldedChips(mac, 194)).toEqual([false, false, true, true, false, false])
  })
  it('a column with no key, or a dropped one, is the icon’s 32px', () => {
    expect(fitFoldedChips(mac, 192)).toEqual([false, false, true, true, false, false])
    expect(fitFoldedChips(mac, 150)).toEqual([false, false, false, false, false, false])
    expect(fitFoldedChips([20, null], 64)).toEqual([true, false])
  })
})
