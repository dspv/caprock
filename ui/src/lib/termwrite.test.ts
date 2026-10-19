import { describe, expect, it, vi } from 'vitest'
import { DESK_WRITE_MS, PHONE_WRITE_MS, WRITE_SLICE, coalescedWriter, writeSliced } from './termwrite'

const fakeTerm = () => {
  const writes: { data: Uint8Array | string; done?: () => void }[] = []
  return { writes, term: { write: (data: Uint8Array | string, done?: () => void) => { writes.push({ data, done }) } } }
}

describe('writeSliced', () => {
  it('passes a small write through whole', () => {
    const { writes, term } = fakeTerm()
    const done = vi.fn()
    writeSliced(term, 'hello', done)
    expect(writes).toEqual([{ data: 'hello', done }])
  })

  it('slices a replay so no write exceeds WRITE_SLICE, in order, with done on the last', () => {
    const { writes, term } = fakeTerm()
    const data = new Uint8Array(WRITE_SLICE * 2 + 100).map((_, i) => i % 251)
    const done = vi.fn()
    writeSliced(term, data, done)
    expect(writes.map((w) => w.data.length)).toEqual([WRITE_SLICE, WRITE_SLICE, 100])
    expect(writes.slice(0, -1).every((w) => w.done === undefined)).toBe(true)
    expect(writes.at(-1)?.done).toBe(done)
    const joined = new Uint8Array(writes.reduce((n, w) => n + w.data.length, 0))
    let at = 0
    for (const w of writes) { joined.set(w.data as Uint8Array, at); at += w.data.length }
    expect(joined).toEqual(data)
  })

  it('slices strings too', () => {
    const { writes, term } = fakeTerm()
    const data = 'x'.repeat(WRITE_SLICE + 1)
    writeSliced(term, data)
    expect(writes.map((w) => w.data)).toEqual(['x'.repeat(WRITE_SLICE), 'x'])
  })
})

describe('coalescedWriter (a desktop terminal under a flood)', () => {
  it('writes at most once per DESK_WRITE_MS and keeps every byte in order', () => {
    vi.useFakeTimers()
    try {
      const { writes, term } = fakeTerm()
      const w = coalescedWriter(term, DESK_WRITE_MS)
      const want: number[] = []
      const dones = vi.fn()
      // 600 chunks over a second, every 1-2 ms, bytes and strings mixed.
      for (let i = 0; i < 600; i++) {
        const b = i % 251
        want.push(b)
        if (i % 3 === 0) w.write(String.fromCharCode(b % 128 === b ? b : 65), dones)
        else w.write(new Uint8Array([b]), dones)
        if (i % 3 === 0 && b >= 128) want[want.length - 1] = 65
        vi.advanceTimersByTime(1 + (i % 2))
      }
      vi.advanceTimersByTime(DESK_WRITE_MS)
      const got = writes.flatMap((x) => [...(typeof x.data === 'string' ? new TextEncoder().encode(x.data) : x.data)])
      expect(got).toEqual(want)
      // About 900 ms of output: no more than one write per interval, plus the first.
      expect(writes.length).toBeLessThanOrEqual(Math.ceil(900 / DESK_WRITE_MS) + 2)
      expect(writes.length).toBeGreaterThan(10)
      for (const x of writes) x.done?.()
      expect(dones).toHaveBeenCalledTimes(600)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('coalescedWriter (a phone terminal)', () => {
  it('writes the first chunk at once, then joins what arrives within the interval into one write', () => {
    vi.useFakeTimers()
    try {
      const { writes, term } = fakeTerm()
      const w = coalescedWriter(term)
      const d1 = vi.fn(); const d2 = vi.fn(); const d3 = vi.fn()
      w.write(new Uint8Array([1]), d1)
      expect(writes).toHaveLength(1) // an echo is not delayed
      w.write(new Uint8Array([2, 3]), d2)
      w.write('é', d3)
      expect(writes).toHaveLength(1)
      vi.advanceTimersByTime(PHONE_WRITE_MS)
      expect(writes).toHaveLength(2)
      expect([...(writes[1]!.data as Uint8Array)]).toEqual([2, 3, 0xc3, 0xa9])
      writes[0]!.done?.(); writes[1]!.done?.()
      expect(d1).toHaveBeenCalledOnce(); expect(d2).toHaveBeenCalledOnce(); expect(d3).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drop forgets what waits but still answers its callbacks; dispose answers none', () => {
    vi.useFakeTimers()
    try {
      const { writes, term } = fakeTerm()
      const w = coalescedWriter(term)
      w.write('a')
      const kept = vi.fn()
      w.write('b', kept)
      w.drop()
      expect(kept).toHaveBeenCalledOnce()
      const gone = vi.fn()
      w.write('c', gone)
      w.dispose()
      vi.runAllTimers()
      expect(gone).not.toHaveBeenCalled()
      expect(writes.map((x) => new TextDecoder().decode(x.data as Uint8Array))).toEqual(['a'])
    } finally {
      vi.useRealTimers()
    }
  })
})
