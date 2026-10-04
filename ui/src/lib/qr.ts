/**
 * A QR code encoder, small enough to read in one sitting.
 *
 * It exists so the pairing screen can show a code a phone's camera opens
 * without the page asking anyone for anything: no CDN, no image service, no
 * dependency. Rule 4 is the reason — the pairing URL carries a code that lets a
 * device in, and it must not leave the machine to be drawn.
 *
 * Deliberately narrow: byte mode, error correction level M, versions 1–10 (up
 * to 213 bytes, far more than an address and a six-digit code need). Written
 * from ISO/IEC 18004; the structure follows the well-known reference design
 * (Project Nayuki's), which is the shape every small encoder takes.
 */

/** A square of modules; `true` is dark. Index as `modules[y][x]`. */
export type QR = { size: number; modules: boolean[][] }

// Error correction level M, per version (index 0 unused).
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]
const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5]
const MAX_VERSION = 10
/** Format bits for level M. */
const ECL_M = 0

/** Encode `text` as UTF-8 into the smallest QR code that holds it. */
export function encodeQR(text: string): QR {
  const bytes = Array.from(new TextEncoder().encode(text))
  let version = 1
  for (; version <= MAX_VERSION; version++) {
    const countBits = version < 10 ? 8 : 16
    if (4 + countBits + bytes.length * 8 <= dataCodewords(version) * 8) break
  }
  if (version > MAX_VERSION) throw new Error('text too long for a QR code here')

  // The bit stream: mode, length, data, terminator, padding.
  const bits: number[] = []
  const put = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1)
  }
  put(0b0100, 4)
  put(bytes.length, version < 10 ? 8 : 16)
  for (const b of bytes) put(b, 8)
  const capacity = dataCodewords(version) * 8
  put(0, Math.min(4, capacity - bits.length))
  put(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8)

  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]!
    data.push(b)
  }

  const q = new Grid(version)
  q.drawFunctionPatterns()
  q.drawCodewords(withEcc(data, version))

  // Every mask produces a valid code; the lowest penalty scans best.
  let best = 0
  let bestScore = Infinity
  for (let m = 0; m < 8; m++) {
    q.applyMask(m)
    q.drawFormatBits(m)
    const score = q.penalty()
    if (score < bestScore) {
      best = m
      bestScore = score
    }
    q.applyMask(m) // XOR again to undo
  }
  q.applyMask(best)
  q.drawFormatBits(best)
  return { size: q.size, modules: q.modules }
}

/** Data + error-correction modules in a version, before the format and version areas. */
function rawDataModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2
    n -= (25 * align - 10) * align - 55
    if (ver >= 7) n -= 36
  }
  return n
}

function dataCodewords(ver: number): number {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver]! * BLOCKS[ver]!
}

/** Split into blocks, append Reed-Solomon codewords, and interleave. */
function withEcc(data: number[], ver: number): number[] {
  const numBlocks = BLOCKS[ver]!
  const eccLen = ECC_PER_BLOCK[ver]!
  const raw = Math.floor(rawDataModules(ver) / 8)
  const numShort = numBlocks - (raw % numBlocks)
  const shortLen = Math.floor(raw / numBlocks)
  const divisor = rsDivisor(eccLen)
  const blocks: number[][] = []
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1))
    k += dat.length
    const ecc = rsRemainder(dat, divisor)
    if (i < numShort) dat.push(0)
    blocks.push(dat.concat(ecc))
  }
  const out: number[] = []
  for (let i = 0; i < blocks[0]!.length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      // Skip the padding byte that short blocks carry to line up.
      if (i !== shortLen - eccLen || j >= numShort) out.push(blocks[j]![i]!)
    }
  }
  return out
}

function gfMul(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

function rsDivisor(degree: number): number[] {
  const out = new Array<number>(degree).fill(0)
  out[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < out.length; j++) {
      out[j] = gfMul(out[j]!, root)
      if (j + 1 < out.length) out[j] = out[j]! ^ out[j + 1]!
    }
    root = gfMul(root, 0x02)
  }
  return out
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const out = new Array<number>(divisor.length).fill(0)
  for (const b of data) {
    const factor = b ^ (out.shift() as number)
    out.push(0)
    for (let i = 0; i < out.length; i++) out[i] = out[i]! ^ gfMul(divisor[i]!, factor)
  }
  return out
}

class Grid {
  readonly version: number
  readonly size: number
  readonly modules: boolean[][]
  private readonly fn: boolean[][]

  constructor(version: number) {
    this.version = version
    this.size = version * 4 + 17
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
    this.fn = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
  }

  private set(x: number, y: number, dark: boolean) {
    this.modules[y]![x] = dark
    this.fn[y]![x] = true
  }

  private get(x: number, y: number): boolean {
    return this.modules[y]![x]!
  }

  private isFn(x: number, y: number): boolean {
    return this.fn[y]![x]!
  }

  drawFunctionPatterns() {
    const s = this.size
    for (let i = 0; i < s; i++) {
      this.set(6, i, i % 2 === 0)
      this.set(i, 6, i % 2 === 0)
    }
    this.finder(3, 3)
    this.finder(s - 4, 3)
    this.finder(3, s - 4)
    const pos = this.alignmentPositions()
    const n = pos.length
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const corner = (i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)
        if (!corner) this.alignment(pos[i]!, pos[j]!)
      }
    }
    this.drawFormatBits(0) // reserve the area; redrawn once the mask is chosen
    this.drawVersion()
  }

  private finder(cx: number, cy: number) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        this.set(x, y, d !== 2 && d !== 4)
      }
    }
  }

  private alignment(cx: number, cy: number) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    }
  }

  private alignmentPositions(): number[] {
    if (this.version === 1) return []
    const n = Math.floor(this.version / 7) + 2
    const step = Math.ceil((this.version * 4 + 4) / (n * 2 - 2)) * 2
    const out = [6]
    for (let p = this.size - 7; out.length < n; p -= step) out.splice(1, 0, p)
    return out
  }

  drawFormatBits(mask: number) {
    const data = (ECL_M << 3) | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((data << 10) | rem) ^ 0x5412
    const bit = (i: number) => ((bits >>> i) & 1) === 1
    const s = this.size
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i))
    this.set(8, 7, bit(6))
    this.set(8, 8, bit(7))
    this.set(7, 8, bit(8))
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i))
    for (let i = 0; i < 8; i++) this.set(s - 1 - i, 8, bit(i))
    for (let i = 8; i < 15; i++) this.set(8, s - 15 + i, bit(i))
    this.set(8, s - 8, true) // the dark module, always dark
  }

  private drawVersion() {
    if (this.version < 7) return
    let rem = this.version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (this.version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1
      const a = this.size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      this.set(a, b, dark)
      this.set(b, a, dark)
    }
  }

  drawCodewords(data: number[]) {
    const s = this.size
    let i = 0
    for (let right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5 // skip the vertical timing column
      for (let vert = 0; vert < s; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? s - 1 - vert : vert
          if (!this.isFn(x, y) && i < data.length * 8) {
            this.modules[y]![x] = ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1
            i++
          }
        }
      }
    }
  }

  applyMask(m: number) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.isFn(x, y)) continue
        let invert: boolean
        switch (m) {
          case 0: invert = (x + y) % 2 === 0; break
          case 1: invert = y % 2 === 0; break
          case 2: invert = x % 3 === 0; break
          case 3: invert = (x + y) % 3 === 0; break
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
        }
        if (invert) this.modules[y]![x] = !this.get(x, y)
      }
    }
  }

  /** The standard penalty: runs, 2×2 blocks, finder look-alikes, balance. */
  penalty(): number {
    const s = this.size
    const at = (x: number, y: number) => this.get(x, y)
    let score = 0
    const finderLike = (line: boolean[]) => {
      // 1:1:3:1:1 dark-light pattern with four light modules on one side.
      let n = 0
      const pat = [true, false, true, true, true, false, true]
      for (let i = 0; i + 7 <= line.length; i++) {
        if (!pat.every((p, k) => line[i + k] === p)) continue
        const before = i >= 4 && line.slice(i - 4, i).every((v) => !v)
        const after = i + 11 <= line.length && line.slice(i + 7, i + 11).every((v) => !v)
        if (before || after) n++
      }
      return n
    }
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < s; a++) {
        const line: boolean[] = []
        for (let b = 0; b < s; b++) line.push(pass === 0 ? at(b, a) : at(a, b))
        let run = 1
        for (let b = 1; b <= s; b++) {
          if (b < s && line[b] === line[b - 1]) {
            run++
            continue
          }
          if (run >= 5) score += run - 2
          run = 1
        }
        score += finderLike(line) * 40
      }
    }
    for (let y = 0; y + 1 < s; y++) {
      for (let x = 0; x + 1 < s; x++) {
        const c = at(x, y)
        if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) score += 3
      }
    }
    let dark = 0
    for (const row of this.modules) for (const v of row) if (v) dark++
    const total = s * s
    score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10
    return score
  }
}

/** One SVG path for every dark module, with a four-module quiet zone. */
export function qrPath(q: QR): { d: string; viewBox: string } {
  const quiet = 4
  let d = ''
  for (let y = 0; y < q.size; y++) {
    for (let x = 0; x < q.size; x++) {
      if (q.modules[y]?.[x]) d += `M${x + quiet},${y + quiet}h1v1h-1z`
    }
  }
  const n = q.size + quiet * 2
  return { d, viewBox: `0 0 ${n} ${n}` }
}
