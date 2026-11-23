import { describe, expect, it } from 'vitest'
import { POP_MARGIN, placeBeside, placeNear, type PopPlace, type PopSize } from './popoverPlace'

const rect = (top: number, left: number, w = 120, h = 16) => ({ top, bottom: top + h, left, right: left + w })
const inside = (p: PopPlace, card: PopSize, vp: PopSize) => {
  expect(p.left).toBeGreaterThanOrEqual(POP_MARGIN)
  expect(p.left + Math.min(card.w, vp.w - 2 * POP_MARGIN)).toBeLessThanOrEqual(vp.w - POP_MARGIN)
  expect(p.top).toBeGreaterThanOrEqual(POP_MARGIN)
  expect(p.top + p.maxHeight).toBeLessThanOrEqual(vp.h - POP_MARGIN)
}

describe('placeBeside: the cockpit card left of the panel', () => {
  const vp = { w: 1280, h: 600 }
  const card = { w: 380, h: 360 }

  it('stands level with a row that has room under it', () => {
    const p = placeBeside(rect(100, 1000), 960, card, vp)
    expect(p).toEqual({ left: 960 - 10 - 380, top: 92, maxHeight: 360, side: 'beside' })
  })

  it('lifts off the window foot for a row near the bottom (the owner screenshot: 16 checks, 9 shown)', () => {
    const p = placeBeside(rect(560, 1000), 960, card, vp)
    expect(p.maxHeight).toBe(360)
    expect(p.top + p.maxHeight).toBe(vp.h - POP_MARGIN)
    inside(p, card, vp)
  })

  it('is cut to the window and scrolls when taller than it', () => {
    const p = placeBeside(rect(560, 1000), 960, { w: 380, h: 900 }, vp)
    expect(p).toMatchObject({ top: POP_MARGIN, maxHeight: vp.h - 2 * POP_MARGIN })
  })

  it('keeps to the left margin when the panel leaves no room beside it', () => {
    const phone = { w: 390, h: 700 }
    const p = placeBeside(rect(600, 20), 0, { w: 374, h: 300 }, phone)
    expect(p.left).toBe(POP_MARGIN)
    inside(p, { w: 374, h: 300 }, phone)
  })
})

describe('placeNear: under or over the summary', () => {
  const vp = { w: 1280, h: 600 }

  it('opens under when it fits there, its right edge on the anchor’s', () => {
    const p = placeNear(rect(100, 600), { w: 380, h: 200 }, vp)
    expect(p).toEqual({ left: 720 - 380, top: 122, maxHeight: 200, side: 'below' })
  })

  it('flips over the anchor near the window foot', () => {
    const a = rect(500, 600)
    const p = placeNear(a, { w: 380, h: 300 }, vp)
    expect(p.side).toBe('above')
    expect(p.top + p.maxHeight).toBe(a.top - 6)
    inside(p, { w: 380, h: 300 }, vp)
  })

  it('fitting neither side, takes the larger and is cut to it', () => {
    const p = placeNear(rect(400, 600), { w: 380, h: 900 }, vp)
    expect(p.side).toBe('above')
    expect(p.top).toBe(POP_MARGIN)
    inside(p, { w: 380, h: 900 }, vp)
    const q = placeNear(rect(150, 600), { w: 380, h: 900 }, vp)
    expect(q.side).toBe('below')
    inside(q, { w: 380, h: 900 }, vp)
  })

  it('stays inside the window sideways', () => {
    expect(placeNear(rect(100, 0, 40), { w: 380, h: 100 }, vp).left).toBe(POP_MARGIN)
    expect(placeNear(rect(100, 1250, 60), { w: 380, h: 100 }, vp).left).toBe(1280 - POP_MARGIN - 380)
  })
})
