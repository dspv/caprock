/**
 * The share offer used to appear only at a money milestone, so most people
 * were never asked and anyone who was got a banner that stayed until the
 * number moved. Both halves of "ask on a rhythm, then stop asking" are here.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { dueShare, isDue, markAnswered, resetPrompts } from './prompts'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.parse('2026-08-26T12:00:00Z')

beforeEach(() => resetPrompts())

describe('prompt cadence', () => {
  it('offers on a first visit', () => {
    expect(isDue('share-week', T0)).toBe(true)
  })

  it('stops asking for a full period once answered', () => {
    markAnswered('share-week', T0)
    expect(isDue('share-week', T0 + 6 * DAY)).toBe(false)
    expect(isDue('share-week', T0 + 7 * DAY)).toBe(true)
  })

  it('does not treat taking the offer differently from dismissing it', () => {
    // Someone who just shared this week has nothing new to share tomorrow, so
    // both answers put the offer away for the same period.
    markAnswered('share-week', T0)
    expect(isDue('share-week', T0 + DAY)).toBe(false)
  })

  it('shows one offer at a time, the rarer one first', () => {
    expect(dueShare(T0)).toBe('share-month')
    markAnswered('share-month', T0)
    // And the weekly one does not immediately take over: the two would
    // otherwise alternate on consecutive days, which is a pile of banners
    // wearing a schedule.
    expect(dueShare(T0 + DAY)).toBeNull()
    expect(dueShare(T0 + 8 * DAY)).toBe('share-week')
  })

  it('a dismissed week says nothing about the month', () => {
    markAnswered('share-week', T0)
    expect(isDue('share-month', T0 + DAY)).toBe(true)
  })

  it('survives a corrupt store instead of taking the screen down', () => {
    localStorage.setItem('caprock-prompts', 'not json')
    expect(isDue('share-week', T0)).toBe(true)
  })
})
