import { describe, expect, it } from 'vitest'
import { encodeQR, qrPath } from './qr'

// What a scanner relies on before it reads a single data bit: the size, the
// three finder squares, the timing lines, and the format bits that say which
// error-correction level and mask were used. A real decode was checked by hand
// with zbarimg for versions 1–10 (see .ai/13-testing.md); these keep the
// structure from drifting.

/** Read the 15 format bits from the copy beside the top-left finder. */
function formatBits(q: ReturnType<typeof encodeQR>): number {
  const m = (x: number, y: number) => q.modules[y]?.[x] === true
  const bits: boolean[] = []
  for (let i = 0; i <= 5; i++) bits.push(m(8, i))
  bits.push(m(8, 7), m(8, 8), m(7, 8))
  for (let i = 9; i < 15; i++) bits.push(m(14 - i, 8))
  return bits.reduce((n, b, i) => n | ((b ? 1 : 0) << i), 0)
}

describe('encodeQR', () => {
  it('picks the smallest version that fits', () => {
    expect(encodeQR('hi').size).toBe(21) // version 1
    // A pairing URL with a six-digit code is version 4 at level M.
    expect(encodeQR('http://192.168.100.200:22776/#/pair?code=987654').size).toBe(33)
    expect(encodeQR('z'.repeat(213)).size).toBe(57) // version 10, the ceiling
  })

  it('refuses what it cannot hold rather than drawing a broken code', () => {
    expect(() => encodeQR('z'.repeat(214))).toThrow()
  })

  it('draws the three finder squares', () => {
    const q = encodeQR('http://10.0.0.2:22776/#/pair?code=123456')
    const s = q.size
    const m = (x: number, y: number) => q.modules[y]?.[x]
    for (const [cx, cy] of [[3, 3], [s - 4, 3], [3, s - 4]] as const) {
      expect(m(cx, cy)).toBe(true) // centre
      expect(m(cx + 2, cy)).toBe(false) // light ring
      expect(m(cx + 3, cy)).toBe(true) // dark border
    }
  })

  it('alternates the timing lines', () => {
    const q = encodeQR('timing')
    for (let i = 8; i < q.size - 8; i++) {
      expect(q.modules[6]?.[i]).toBe(i % 2 === 0)
      expect(q.modules[i]?.[6]).toBe(i % 2 === 0)
    }
  })

  it('writes format bits that say level M and a valid mask', () => {
    const q = encodeQR('http://10.0.0.2:22776/#/pair?code=123456')
    const raw = formatBits(q) ^ 0x5412
    const data = raw >>> 10
    expect(data >>> 3).toBe(0) // level M
    // The BCH remainder must match the data it protects.
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    expect(raw & 0x3ff).toBe(rem & 0x3ff)
  })

  it('is deterministic', () => {
    const a = encodeQR('same input')
    const b = encodeQR('same input')
    expect(a.modules).toEqual(b.modules)
  })
})

describe('qrPath', () => {
  it('leaves a four-module quiet zone', () => {
    const q = encodeQR('hi')
    const p = qrPath(q)
    expect(p.viewBox).toBe(`0 0 ${q.size + 8} ${q.size + 8}`)
    expect(p.d.startsWith('M4,4')).toBe(true) // the top-left finder's corner
  })
})
