import { afterEach, describe, expect, it, vi } from 'vitest'
import { DECK_DEFAULT, DECK_KEY, DECK_MIN, DECK_STEP, clampDeck, deckKeyStep, pulseMinutes, readDeck, saveDeck } from './deck'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('the session deck height', () => {
  it('is clamped between its floor and 60% of the pane', () => {
    expect(clampDeck(10, 800)).toBe(DECK_MIN)
    expect(clampDeck(300, 800)).toBe(300)
    expect(clampDeck(700, 800)).toBe(480)
    expect(clampDeck(212.6, 800)).toBe(213)
    // A pane too small for the floor still gets the floor: the deck is closed, not crushed.
    expect(clampDeck(200, 90)).toBe(DECK_MIN)
    // Without a pane only the floor applies.
    expect(clampDeck(5000)).toBe(5000)
    expect(clampDeck(Number.NaN, 800)).toBe(DECK_DEFAULT)
  })

  it('opens closed at the default height when nothing, or nothing of ours, is kept', () => {
    expect(readDeck()).toEqual({ open: false, height: DECK_DEFAULT })
    localStorage.setItem(DECK_KEY, '{not json')
    expect(readDeck()).toEqual({ open: false, height: DECK_DEFAULT })
    localStorage.setItem(DECK_KEY, JSON.stringify({ open: 'yes', height: 'tall' }))
    expect(readDeck()).toEqual({ open: false, height: DECK_DEFAULT })
  })

  it('keeps whether it is open and its height, never below the floor', () => {
    saveDeck({ open: true, height: 340 })
    expect(readDeck()).toEqual({ open: true, height: 340 })
    localStorage.setItem(DECK_KEY, JSON.stringify({ open: true, height: 4 }))
    expect(readDeck()).toEqual({ open: true, height: DECK_MIN })
  })

  it('lowers a height kept before the chart left by a third, once', () => {
    localStorage.setItem(DECK_KEY, JSON.stringify({ open: true, height: 300 }))
    expect(readDeck()).toEqual({ open: true, height: 200 })
    saveDeck(readDeck())
    expect(readDeck()).toEqual({ open: true, height: 200 })
  })

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(readDeck()).toEqual({ open: false, height: DECK_DEFAULT })
    expect(() => saveDeck({ open: true, height: 200 })).not.toThrow()
  })

  it('moves with the divider keys: up is taller, within the range', () => {
    expect(deckKeyStep('ArrowUp', 200, 800)).toBe(200 + DECK_STEP)
    expect(deckKeyStep('ArrowDown', 200, 800)).toBe(200 - DECK_STEP)
    expect(deckKeyStep('ArrowDown', DECK_MIN, 800)).toBe(DECK_MIN)
    expect(deckKeyStep('PageUp', 470, 800)).toBe(480)
    expect(deckKeyStep('Home', 200, 800)).toBe(480)
    expect(deckKeyStep('End', 300, 800)).toBe(DECK_MIN)
    expect(deckKeyStep('Enter', 200, 800)).toBeUndefined()
  })
})

describe('the minutes of bars the held events can draw', () => {
  const now = Date.parse('2026-10-11T12:00:00Z')
  const at = (minAgo: number) => ({ ts: new Date(now - minAgo * 60_000).toISOString() })

  it('is the whole hour while the list is not full: nothing older was left out', () => {
    expect(pulseMinutes([at(10), at(5)], now, 400)).toBe(60)
    expect(pulseMinutes([], now, 400)).toBe(60)
  })

  it('starts at the oldest event held once the list is full, so no minute is drawn as silence it may not have been', () => {
    const full = [at(23.5), ...Array.from({ length: 3 }, () => at(1))]
    expect(pulseMinutes(full, now, 4)).toBe(23)
    expect(pulseMinutes([at(90), at(1), at(1), at(1)], now, 4)).toBe(60)
    expect(pulseMinutes([at(0.2), at(0.1), at(0.1), at(0)], now, 4)).toBe(1)
  })
})
