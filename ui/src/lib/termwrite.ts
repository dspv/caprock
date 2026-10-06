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
