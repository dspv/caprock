import { describe, expect, it } from 'vitest'
import { atPrompt, endable, sessionJump } from './sessionJump'
import type { SessionSummary } from './api'

const s = (over: Partial<SessionSummary> = {}) => ({ status: 'active', owned: true, activity: { phrase: 'waiting for you', health: 'waiting-on-you', at: '' }, ...over }) as SessionSummary

describe('sessionJump', () => {
  it('brings a tab forward when one shows the session, Caprock\'s or not', () => {
    expect(sessionJump(s(), 2)).toEqual({ kind: 'tab', digit: 2, typeable: true })
    expect(sessionJump(s({ owned: false }), null)).toEqual({ kind: 'tab', digit: null, typeable: false })
  })
  it('opens a tab for a session Caprock holds a terminal for', () => {
    expect(sessionJump(s(), undefined)).toEqual({ kind: 'open' })
  })
  it('goes nowhere for one in the user\'s terminal, or Caprock\'s without a terminal', () => {
    expect(sessionJump(s({ owned: false }), undefined)).toEqual({ kind: 'away', why: 'terminal' })
    expect(sessionJump(s({ detached: true }), undefined)).toEqual({ kind: 'away', why: 'detached' })
  })
})

describe('atPrompt and endable', () => {
  it('counts a session at its prompt after a turn, or idle', () => {
    expect(atPrompt(s())).toBe(true)
    expect(atPrompt(s({ activity: { phrase: 'was editing', health: 'idle', at: '' } }))).toBe(true)
  })
  it('never counts one working, asking for approval, or with subagents running', () => {
    expect(atPrompt(s({ activity: { phrase: 'running go test', health: 'working', at: '' } }))).toBe(false)
    expect(atPrompt(s({ activity: { phrase: 'waiting for approval — Bash', tool: 'Bash', health: 'waiting-on-you', at: '' } }))).toBe(false)
    expect(atPrompt(s({ activity: { phrase: 'waiting for your answer', health: 'waiting-on-you', at: '' } }))).toBe(false)
    expect(atPrompt(s({ live_subagents: 2 }))).toBe(false)
    expect(atPrompt(s({ status: 'ended' }))).toBe(false)
  })
  it('offers End only for a session Caprock started', () => {
    expect(endable(s())).toBe(true)
    expect(endable(s({ owned: false }))).toBe(false)
  })
})
