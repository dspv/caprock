import { afterEach, describe, expect, it, vi } from 'vitest'
import { PHOTO_MAX_SIDE, downscalePhoto, fitWithin, isHeic, needsDownscale } from './downscale'

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

describe('a HEIC photo', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('is known by its type, or by its name when the type is empty', () => {
    expect(isHeic({ name: 'IMG_1.HEIC', type: 'image/heic' })).toBe(true)
    expect(isHeic({ name: 'x', type: 'image/heif' })).toBe(true)
    expect(isHeic({ name: 'IMG_1.heic', type: '' })).toBe(true)
    expect(isHeic({ name: 'IMG_1.jpg', type: 'image/jpeg' })).toBe(false)
  })

  // The daemon keeps no HEIC: a small one picked in Files would be refused.
  it('is re-encoded as JPEG even when small, where a small JPEG goes as it is', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 800, height: 600, close() {} })))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => cb(new Blob(['j'], { type: 'image/jpeg' })))
    const heic = new File(['h'], 'IMG_0007.HEIC', { type: 'image/heic' })
    const out = await downscalePhoto(heic)
    expect(out.name).toBe('IMG_0007.jpg')
    expect(out.type).toBe('image/jpeg')
    const jpg = new File(['j'], 'IMG_0008.jpg', { type: 'image/jpeg' })
    expect(await downscalePhoto(jpg)).toBe(jpg)
  })
})
