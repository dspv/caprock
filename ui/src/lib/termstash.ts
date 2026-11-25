/**
 * A hidden terminal's old scrollback, packed (.ai/04-ui.md § What the window
 * keeps in memory, *Hidden scrollback, packed*).
 *
 * xterm keeps every line of scrollback as its own object around a typed array
 * of 12 bytes a cell, the full width of the terminal however short the line:
 * in WebKit about 2 KB a line at 110 columns, so a terminal with its 10,000
 * lines held about 20 MB, and eight tabs most of the window's memory
 * (measured 2026-11-25 in Playwright's WebKit). A tab out of sight a while
 * moves the lines above its last `keep` into one array here — each line's
 * characters up to where its trailing blanks start, its colours as runs — and
 * takes them out of xterm; shown again, they go back above the rest before
 * anything else is drawn, cell for cell what they were.
 *
 * It reaches into xterm's private buffer (`_core.buffers.normal`, its line
 * list, `ybase`/`ydisp`/`savedY`, each line's `_data`), so every step checks
 * what it finds and does nothing it cannot do whole: an xterm that renamed
 * any of it leaves the scrollback where it was, as before. Anything that
 * removes lines from the top of that buffer while they are packed — a reset,
 * "erase scrollback", a buffer filling to its limit — drops the packed lines
 * too, as it would have dropped them from xterm.
 */
import type { Terminal } from '@xterm/xterm'

/** One cell is three words: content, foreground, background (xterm's CELL_SIZE). */
const CELL = 3

interface Line {
  _data: Uint32Array
  _combined: Record<number, string>
  _extendedAttrs: Record<number, unknown>
  length: number
  isWrapped: boolean
  constructor: new (cols: number) => Line
}
interface Lines {
  length: number
  maxLength: number
  get(i: number): Line | undefined
  trimStart(n: number): void
  splice(start: number, deleteCount: number, ...items: Line[]): void
  onTrim(cb: (n: number) => void): { dispose(): void }
}
interface Buf { lines: Lines; ybase: number; ydisp: number; savedY: number }
interface Core { buffers?: { normal?: Buf }; _viewport?: { queueSync?: () => void } }

/** What a terminal's packed lines are; undefined from `stashScrollback` when nothing was moved. */
export interface Stash {
  /** Lines held, oldest first. */
  readonly lines: number
  /** Bytes they take here (the pool and the offsets). */
  readonly bytes: number
  /** Puts them back above the buffer's lines; the count put back (0 when they had to go). */
  restore(): number
  /** Lets them go without putting them back. */
  drop(): void
}

function core(term: Terminal): Core | undefined {
  return (term as unknown as { _core?: Core })._core
}

function normalBuffer(term: Terminal): Buf | undefined {
  const b = core(term)?.buffers?.normal
  const l = b?.lines
  if (!b || !l || typeof l.get !== 'function' || typeof l.trimStart !== 'function' || typeof l.splice !== 'function' || typeof l.onTrim !== 'function') return undefined
  if (typeof b.ybase !== 'number' || typeof b.ydisp !== 'number' || typeof b.savedY !== 'number') return undefined
  return b
}

function plainLine(l: Line | undefined): l is Line {
  return !!l && l._data instanceof Uint32Array && typeof l.length === 'number' && l._data.length >= l.length * CELL
    && typeof l._combined === 'object' && typeof l._extendedAttrs === 'object' && typeof l.constructor === 'function'
}

function hasKeys(o: object): boolean {
  for (const _ in o) return true
  return false
}

/**
 * Packs the lines above the last `keep` of scrollback of `term`'s normal
 * buffer and takes them out of it. Only when the view is at the bottom (a
 * reader scrolled up keeps everything where it is) and nothing is selected.
 */
export function stashScrollback(term: Terminal, keep: number): Stash | undefined {
  const buf = normalBuffer(term)
  if (!buf || buf.ydisp !== buf.ybase || term.hasSelection()) return undefined
  const n = buf.ybase - keep
  if (n <= 0) return undefined
  const first = buf.lines.get(0)
  if (!plainLine(first)) return undefined
  const Ctor = first.constructor

  // [length, wrapped, used, runs, fill c f b, content × used, (start fg bg) × runs] per line.
  let pool = new Uint32Array(Math.max(1024, n * 64))
  let at = 0
  const offsets = new Uint32Array(n + 1)
  const extras = new Map<number, { c: Record<number, string>; e: Record<number, unknown> }>()
  const need = (k: number) => {
    if (at + k <= pool.length) return
    const next = new Uint32Array(Math.max(pool.length * 2, at + k))
    next.set(pool.subarray(0, at))
    pool = next
  }
  for (let i = 0; i < n; i++) {
    const line = buf.lines.get(i)
    if (!plainLine(line)) return undefined
    const d = line._data
    const len = line.length
    // Where the trailing run of cells equal to the last one starts.
    let used = len
    if (len > 0) {
      const lc = d[(len - 1) * CELL]!, lf = d[(len - 1) * CELL + 1]!, lb = d[(len - 1) * CELL + 2]!
      while (used > 0 && d[(used - 1) * CELL] === lc && d[(used - 1) * CELL + 1] === lf && d[(used - 1) * CELL + 2] === lb) used--
    }
    let runs = 0
    for (let x = 0, f = -1, b = -1; x < used; x++) {
      if (d[x * CELL + 1] !== f || d[x * CELL + 2] !== b) { runs++; f = d[x * CELL + 1]!; b = d[x * CELL + 2]! }
    }
    need(7 + used + runs * 3)
    offsets[i] = at
    pool[at++] = len
    pool[at++] = line.isWrapped ? 1 : 0
    pool[at++] = used
    pool[at++] = runs
    if (len > 0) { pool[at++] = d[(len - 1) * CELL]!; pool[at++] = d[(len - 1) * CELL + 1]!; pool[at++] = d[(len - 1) * CELL + 2]! } else { at += 3 }
    for (let x = 0; x < used; x++) pool[at++] = d[x * CELL]!
    for (let x = 0, f = -1, b = -1; x < used; x++) {
      if (d[x * CELL + 1] !== f || d[x * CELL + 2] !== b) {
        f = d[x * CELL + 1]!; b = d[x * CELL + 2]!
        pool[at++] = x; pool[at++] = f; pool[at++] = b
      }
    }
    if (hasKeys(line._combined) || hasKeys(line._extendedAttrs)) extras.set(i, { c: line._combined, e: line._extendedAttrs })
  }
  offsets[n] = at
  pool = pool.slice(0, at)

  // Out of xterm, as its own scrollback trim does it (Buffer.resize): the
  // list's array is rebuilt so the lines taken out are not still held there.
  const lines = buf.lines
  const max = lines.maxLength
  lines.trimStart(n)
  lines.maxLength = max + 1
  lines.maxLength = max
  buf.ybase -= n
  buf.ydisp -= n
  buf.savedY = Math.max(buf.savedY - n, 0)
  core(term)?._viewport?.queueSync?.()

  let live = true
  let held: Uint32Array | undefined = pool
  // Lines leaving the top of this buffer while these wait above it: they
  // would have left first.
  const trimSub = lines.onTrim(() => { stash.drop() })
  const cols = term.cols
  const stash: Stash = {
    lines: n,
    bytes: pool.byteLength + offsets.byteLength,
    drop() {
      if (!live) return
      live = false
      held = undefined
      extras.clear()
      trimSub.dispose()
    },
    restore() {
      if (!live) return 0
      const data = held!
      const now = normalBuffer(term)
      // A reset made new buffers; a resize while hidden changed the width these were cut at.
      if (now !== buf || term.cols !== cols) { stash.drop(); return 0 }
      // Never more than the list has room for (what xterm itself would have kept).
      const room = Math.max(0, lines.maxLength - lines.length)
      const from = Math.max(0, n - room)
      const back: Line[] = []
      for (let i = from; i < n; i++) {
        let p = offsets[i]!
        const len = data[p++]!, wrapped = data[p++] === 1, used = data[p++]!, runs = data[p++]!
        const fc = data[p++]!, ff = data[p++]!, fb = data[p++]!
        const d = new Uint32Array(len * CELL)
        for (let x = 0; x < used; x++) d[x * CELL] = data[p++]!
        for (let r = 0; r < runs; r++) {
          const start = data[p]!, f = data[p + 1]!, b = data[p + 2]!
          const end = r + 1 < runs ? data[p + 3]! : used
          p += 3
          for (let x = start; x < end; x++) { d[x * CELL + 1] = f; d[x * CELL + 2] = b }
        }
        for (let x = used; x < len; x++) { d[x * CELL] = fc; d[x * CELL + 1] = ff; d[x * CELL + 2] = fb }
        const line = new Ctor(0)
        line._data = d
        line.length = len
        line.isWrapped = wrapped
        const ex = extras.get(i)
        line._combined = ex ? ex.c : {}
        line._extendedAttrs = ex ? ex.e : {}
        back.push(line)
      }
      stash.drop()
      const count = back.length
      if (!count) return 0
      // In blocks: an argument list has a limit.
      for (let i = count; i > 0; i -= 4096) lines.splice(0, 0, ...back.slice(Math.max(0, i - 4096), i))
      buf.ybase += count
      buf.ydisp += count
      buf.savedY += count
      core(term)?._viewport?.queueSync?.()
      return count
    },
  }
  return stash
}
