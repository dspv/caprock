/**
 * What every share card shares: the periods' names and the file's name. The
 * card itself is tested in lib/week.test.tsx and Share.test.tsx.
 */
import { describe, expect, it } from 'vitest'
import { cardFilename, PERIOD_LABEL } from './ShareCard'

describe('cardFilename', () => {
  it('carries the date, so repeated saves are tellable apart', () => {
    expect(cardFilename(new Date(2026, 7, 27))).toBe('caprock-2026-08-27.png')
  })
  it('pads single digits, so names sort', () => {
    expect(cardFilename(new Date(2026, 0, 5))).toBe('caprock-2026-01-05.png')
  })
})

describe('the period a card is about', () => {
  it('names the stretch, so a card out of context still says what it is', () => {
    expect(PERIOD_LABEL['7d']).toBe('this week')
    expect(PERIOD_LABEL['30d']).toBe('this month')
    expect(PERIOD_LABEL.today).toBe('today')
    expect(PERIOD_LABEL.all).toBe('all time')
  })
})
