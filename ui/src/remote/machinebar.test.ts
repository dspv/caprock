/**
 * The machine bar only when it has something to say (owner, 2026-10-14,
 * translated: "the 'DimaS-MBP' info isn't really needed either").
 */
import { describe, expect, it } from 'vitest'
import { BAR_GRACE_MS, machineBarShown } from './RemoteRoot'

const open = { state: 'open' as const, problem: '' as const, everOpen: true, downFor: 0 }

describe('machineBarShown', () => {
  it('is hidden while connected to the one machine', () => {
    expect(machineBarShown(open, false, false)).toBe(false)
    expect(machineBarShown(open, false, true)).toBe(false)
  })

  it('shows before the first connection and once a drop outlasts the grace', () => {
    expect(machineBarShown({ ...open, state: 'connecting', everOpen: false, downFor: 0 }, false, true)).toBe(true)
    expect(machineBarShown({ ...open, state: 'connecting', downFor: BAR_GRACE_MS - 1 }, false, true)).toBe(false)
    expect(machineBarShown({ ...open, state: 'offline', problem: 'machine-offline', downFor: BAR_GRACE_MS }, false, true)).toBe(true)
  })

  it('shows when only pairing again helps', () => {
    expect(machineBarShown({ ...open, problem: 'removed' }, false, true)).toBe(true)
  })

  it('with several machines: shows outside a session, and leaves the switch to the session sheet inside one', () => {
    expect(machineBarShown(open, true, false)).toBe(true)
    expect(machineBarShown(open, true, true)).toBe(false)
  })
})
