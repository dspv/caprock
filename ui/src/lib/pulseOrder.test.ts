import { describe, expect, it } from 'vitest'
import { pulseOrder } from './pulseOrder'

const s = (session_id: string, started_at: number) => ({ session_id, started_at })
const ids = (list: { session_id: string }[]) => list.map((x) => x.session_id)

describe('pulseOrder', () => {
  const a = s('a', 100), b = s('b', 200), c = s('c', 300), d = s('d', 400)

  it('is start order, whatever order the sessions arrive in', () => {
    expect(ids(pulseOrder([c, a, b]))).toEqual(['a', 'b', 'c'])
    expect(ids(pulseOrder([b, c, a]))).toEqual(['a', 'b', 'c'])
  })

  it('follows the tab strip among tabbed sessions, in the slots they held', () => {
    // b and d have tabs, d's first: they trade places; a and c stay put.
    expect(ids(pulseOrder([a, b, c, d], [], ['d', 'b']))).toEqual(['a', 'd', 'c', 'b'])
    // A tab for a session not on screen changes nothing.
    expect(ids(pulseOrder([a, b, c], [], ['zz']))).toEqual(['a', 'b', 'c'])
  })

  it('puts the order set by hand first, and the rest after in their usual turn', () => {
    expect(ids(pulseOrder([a, b, c, d], ['c', 'a']))).toEqual(['c', 'a', 'b', 'd'])
    // By hand outranks the strip.
    expect(ids(pulseOrder([a, b, c], ['b', 'a', 'c'], ['c', 'a', 'b']))).toEqual(['b', 'a', 'c'])
  })

  it('lands a new session last', () => {
    expect(ids(pulseOrder([a, b, s('n', 500)], ['b', 'a']))).toEqual(['b', 'a', 'n'])
  })
})
