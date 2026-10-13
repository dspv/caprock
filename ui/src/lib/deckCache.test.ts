import { afterEach, describe, expect, it, vi } from 'vitest'
import { forgetDeckAnswers, freshText, readDeck, writeDeck } from './deckCache'
import { GROUP_LIMITS } from './swr'

afterEach(() => { forgetDeckAnswers(); vi.restoreAllMocks(); localStorage.clear() })

describe('the deck’s kept answers', () => {
  it('survive a fresh start of the app through storage', () => {
    writeDeck('prs:s1', { prs: [{ number: 9 }] }, 1_000)
    forgetDeckAnswers() // what a new page load starts with
    expect(readDeck('prs:s1')).toEqual({ d: { prs: [{ number: 9 }] }, at: 1_000 })
  })

  it('keep only the newest few in storage, and the rest in memory', () => {
    const max = GROUP_LIMITS['deck:']!
    for (let i = 0; i < max + 5; i++) writeDeck(`k${i}`, { i }, 1_000 + i)
    const stored = Object.keys(localStorage).filter((k) => k.includes(':deck:'))
    expect(stored).toHaveLength(max)
    expect(readDeck('k0')).toBeDefined()
    forgetDeckAnswers()
    expect(readDeck('k0')).toBeUndefined()
    expect(readDeck(`k${max + 4}`)?.d).toEqual({ i: max + 4 })
  })

  it('work in memory when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => writeDeck('prs:s1', { ok: true })).not.toThrow()
    expect(readDeck('prs:s1')?.d).toEqual({ ok: true })
  })

  it('say how fresh an answer is', () => {
    expect(freshText(2_000)).toBe('updated just now')
    expect(freshText(12_000)).toBe('updated 12 s ago')
    expect(freshText(3 * 60_000)).toBe('updated 3 min ago')
    expect(freshText(2 * 3_600_000)).toBe('updated 2 h ago')
  })
})
