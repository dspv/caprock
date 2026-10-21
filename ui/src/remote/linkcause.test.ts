import { describe, expect, it } from 'vitest'
import { agoText, classify, offersPairing, retryLine } from './linkcause'

// The owner, 2026-10-21 (translated): "When the phone loses network while
// Caprock is open, I see 'Retry' and 'Pair again' … the connection is just
// bad sometimes." Each cause told apart; only a refused pairing pairs again.
describe('why the computer cannot be reached', () => {
  it('a phone with no network is offline, whatever the channel last said', () => {
    expect(classify('no-internet', true)).toBe('offline')
    expect(classify('lost', false)).toBe('offline')
    expect(classify('machine-offline', false)).toBe('offline')
    expect(classify('', false)).toBe('offline')
  })
  it('the relay down with a network is the relay', () => {
    expect(classify('relay-unreachable', true)).toBe('relay')
  })
  it('the relay up and the computer silent is the computer', () => {
    expect(classify('machine-offline', true)).toBe('computer')
    expect(classify('no-answer', true)).toBe('computer')
  })
  it('a dropped channel with no verdict yet is reconnecting', () => {
    expect(classify('lost', true)).toBe('reconnecting')
    expect(classify('', true)).toBe('reconnecting')
  })
  it('only the computer refusing the pairing is unpaired, and offline still wins', () => {
    expect(classify('removed', true)).toBe('unpaired')
    expect(classify('wrong-machine', true)).toBe('unpaired')
    expect(classify('removed', false)).toBe('offline')
  })
  it('offers Pair again for unpaired only: never for a timeout or a network error', () => {
    expect(offersPairing('unpaired')).toBe(true)
    for (const c of ['offline', 'relay', 'computer', 'reconnecting'] as const) expect(offersPairing(c)).toBe(false)
  })
})

describe('the live lines', () => {
  it('counts down to the next try and numbers it', () => {
    expect(retryLine(false, 10_000 + 4_200, 2, 10_000)).toBe('Next try in 5 s · attempt 3')
    expect(retryLine(true, null, 2, 0)).toBe('Trying now…')
    expect(retryLine(false, null, 0, 0)).toBe('Trying now…')
  })
  it('says how old the dimmed screen is', () => {
    expect(agoText(0)).toBe('1\u00a0s ago')
    expect(agoText(40_000)).toBe('40\u00a0s ago')
    expect(agoText(125_000)).toBe('2\u00a0min ago')
    expect(agoText(2 * 3600_000 + 5)).toBe('2\u00a0h ago')
  })
})
