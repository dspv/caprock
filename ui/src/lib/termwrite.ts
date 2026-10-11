/**
 * Output to xterm in slices (WP-16).
 *
 * xterm parses one `write` in a single task and yields only between writes,
 * so a terminal's replay — a few hundred KB when a tab opens — held the page
 * for 70–150 ms in one go (bench/results-2026-10-06). Sliced, each task stays
 * near xterm's own 12 ms budget. A slice may end inside a UTF-8 sequence or
 * an escape sequence: xterm's decoder and parser carry state across writes.
 */
import type { Terminal as Xterm } from '@xterm/xterm'

/** The most handed to xterm in one write. */
export const WRITE_SLICE = 16 * 1024

/** Writes `data` in slices of WRITE_SLICE; `done` runs once the last is parsed. */
export function writeSliced(term: Pick<Xterm, 'write'>, data: Uint8Array | string, done?: () => void): void {
  if (data.length <= WRITE_SLICE) {
    term.write(data, done)
    return
  }
  for (let i = 0; i < data.length; i += WRITE_SLICE) {
    const end = Math.min(i + WRITE_SLICE, data.length)
    const part = typeof data === 'string' ? data.slice(i, end) : data.subarray(i, end)
    term.write(part, end === data.length ? done : undefined)
  }
}

/** How often a phone's terminal is handed what arrived (coalescedWriter). */
export const PHONE_WRITE_MS = 100

export interface CoalescedWriter {
  write(data: Uint8Array | string, done?: () => void): void
  /** Forgets what is waiting (the terminal is about to be cleared); its callbacks still run. */
  drop(): void
  /** Stops: nothing waiting is written, and no callback runs (the terminal is going away). */
  dispose(): void
}

/**
 * Output to a phone's terminal, at most once per `everyMs`.
 *
 * A working agent redraws its status line ten or more times a second, and
 * each write is a parse and a repaint; on a phone the repaints were most of
 * the cost (.ai/04-ui.md § From a phone, measured 2026-10-11). Writes that
 * arrive within `everyMs` of the last one wait and go in together, so the
 * terminal is handed output at most 1000/everyMs times a second. The first
 * write after a quiet spell goes at once, so an echo is not delayed. Every
 * `done` runs once the write it came with is parsed, which is what the
 * socket's flow control counts (lib/termv2).
 */
export function coalescedWriter(term: Pick<Xterm, 'write'>, everyMs = PHONE_WRITE_MS): CoalescedWriter {
  const enc = new TextEncoder()
  let parts: Uint8Array[] = []
  let dones: (() => void)[] = []
  let timer: ReturnType<typeof setTimeout> | 0 = 0
  let last = -Infinity
  const flush = () => {
    timer = 0
    if (parts.length === 0) return
    last = Date.now()
    let data = parts[0]!
    if (parts.length > 1) {
      data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
      let at = 0
      for (const p of parts) { data.set(p, at); at += p.length }
    }
    const waiting = dones
    parts = []
    dones = []
    writeSliced(term, data, waiting.length ? () => { for (const d of waiting) d() } : undefined)
  }
  return {
    write(data, done) {
      parts.push(typeof data === 'string' ? enc.encode(data) : data)
      if (done) dones.push(done)
      if (timer) return
      const wait = everyMs - (Date.now() - last)
      if (wait <= 0) flush()
      else timer = setTimeout(flush, wait)
    },
    drop() {
      if (timer) clearTimeout(timer)
      timer = 0
      const waiting = dones
      parts = []
      dones = []
      for (const d of waiting) d()
    },
    dispose() {
      if (timer) clearTimeout(timer)
      timer = 0
      parts = []
      dones = []
    },
  }
}
