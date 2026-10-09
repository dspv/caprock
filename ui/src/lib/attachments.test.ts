import { describe, expect, it, vi } from 'vitest'
import { accept, baseName, copyImage, imageTypeOfPath, imagesIn, MAX_SHOT_BYTES, MAX_SHOTS, nextShot, stepLine } from './attachments'

const png = (name = 'a.png', size = 10) => new File([new Uint8Array(size)], name, { type: 'image/png' })

describe('accept', () => {
  it('takes images only, and says so', () => {
    const r = accept(0, [png(), new File(['x'], 'notes.txt', { type: 'text/plain' })])
    expect(r.take.map((f) => f.name)).toEqual(['a.png'])
    expect(r.note).toContain('Only images')
  })

  it('stops at the cap, counting what is already attached', () => {
    expect(MAX_SHOTS).toBe(4)
    const r = accept(3, [png('1.png'), png('2.png')])
    expect(r.take.map((f) => f.name)).toEqual(['1.png'])
    expect(r.note).toContain('Up to 4')
    expect(accept(4, [png()]).take).toEqual([])
  })

  it('leaves out an image GitHub would refuse', () => {
    const big = { name: 'big.png', type: 'image/png', size: MAX_SHOT_BYTES + 1 } as File
    const r = accept(0, [big, png('ok.png')])
    expect(r.take.map((f) => f.name)).toEqual(['ok.png'])
    expect(r.note).toContain('10 MB')
  })

  it('says nothing when everything fits', () => {
    expect(accept(0, [png(), png('b.png')]).note).toBe('')
  })
})

describe('imagesIn', () => {
  it('reads files, and falls back to items a screenshot tool fills', () => {
    const f = png()
    expect(imagesIn({ files: [f], items: [] } as unknown as DataTransfer)).toEqual([f])
    const item = { kind: 'file', type: 'image/png', getAsFile: () => f }
    expect(imagesIn({ files: [], items: [item] } as unknown as DataTransfer)).toEqual([f])
    expect(imagesIn({ files: [], items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] } as unknown as DataTransfer)).toEqual([])
    expect(imagesIn(null)).toEqual([])
  })
})

describe('copyImage', () => {
  it('writes a PNG ClipboardItem and reports success', async () => {
    const written: unknown[] = []
    class Item { constructor(public data: Record<string, Blob>) {} }
    vi.stubGlobal('ClipboardItem', Item)
    const clip = { write: vi.fn(async (items: unknown[]) => { written.push(...items) }) } as unknown as Clipboard
    const blob = png()
    expect(await copyImage(blob, clip)).toBe(true)
    expect((written[0] as Item).data['image/png']).toBe(blob)
    vi.unstubAllGlobals()
  })

  it('answers false when the clipboard refuses or does not exist', async () => {
    vi.stubGlobal('ClipboardItem', class { constructor(public d: unknown) {} })
    const refusing = { write: vi.fn(async () => { throw new Error('NotAllowedError') }) } as unknown as Clipboard
    expect(await copyImage(png(), refusing)).toBe(false)
    expect(await copyImage(png(), undefined)).toBe(false)
    vi.unstubAllGlobals()
    vi.stubGlobal('ClipboardItem', undefined)
    expect(await copyImage(png(), { write: vi.fn() } as unknown as Clipboard)).toBe(false)
    vi.unstubAllGlobals()
  })
})

describe('the attach step', () => {
  it('cycles through the screenshots and wraps after the last', () => {
    expect([0, 1, 2].map((i) => nextShot(i, 3))).toEqual([1, 2, 0])
    expect(nextShot(0, 1)).toBe(0)
    expect(nextShot(0, 0)).toBe(0)
  })

  it('says which one is on the clipboard and where it goes', () => {
    expect(stepLine(0, 2, true, '⌘V')).toBe('Screenshot 1 of 2 is on your clipboard — press ⌘V in the GitHub comment box.')
    expect(stepLine(0, 1, true, 'Ctrl+V')).toBe('Your screenshot is on your clipboard — press Ctrl+V in the GitHub comment box.')
    // A refused clipboard is a calm next step, never an error.
    expect(stepLine(1, 2, false, '⌘V')).toBe('One more step: save the screenshots, then drag them into the GitHub comment box.')
    expect(stepLine(0, 1, false, '⌘V', true)).toBe('Saved to your downloads — drag it into the GitHub comment box.')
  })
})

describe('a dropped path', () => {
  it('is an image by the extensions the app reads, in any case', () => {
    expect(imageTypeOfPath('/a/b/Shot.PNG')).toBe('image/png')
    expect(imageTypeOfPath('C:\\x\\photo.jpeg')).toBe('image/jpeg')
    expect(imageTypeOfPath('/a/x.jpg')).toBe('image/jpeg')
    expect(imageTypeOfPath('/a/x.gif')).toBe('image/gif')
    expect(imageTypeOfPath('/a/x.webp')).toBe('image/webp')
    for (const no of ['/a/x.txt', '/a/x', '/a/x.svg', '/a/x.png.exe']) expect(imageTypeOfPath(no)).toBe('')
  })

  it('is named by its last part on any OS', () => {
    expect(baseName('/Users/me/shot.png')).toBe('shot.png')
    expect(baseName('C:\\Users\\me\\shot.png')).toBe('shot.png')
  })
})
