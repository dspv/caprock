import { describe, expect, it, vi } from 'vitest'
import { WRITE_SLICE, writeSliced } from './termwrite'

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
