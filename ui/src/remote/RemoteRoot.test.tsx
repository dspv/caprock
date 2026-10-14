/**
 * The phone's page says what is wrong and what to do, never a bare
 * "Connecting…" (owner, 2026-10-14), and offers the app once.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { listenForInstall } from './install'
import RemoteRoot, { barLabel, explain } from './RemoteRoot'

describe('the words for each problem', () => {
  it('names the computer, the relay and the next step', () => {
    expect(explain('machine-offline', 'Mac mini', 'wss://relay.caprock.dev').title).toBe('Your computer is offline or Caprock isn’t running')
    expect(explain('relay-unreachable', 'Mac mini', 'wss://relay.caprock.dev').body).toContain('relay.caprock.dev')
    expect(explain('removed', 'Mac mini', '').title).toBe('This phone was removed: pair again')
    expect(explain('removed', 'Mac mini', '').body).toContain('Settings → Use on your phone → Show a code')
    expect(explain('no-answer', 'Mac mini', '').body).toContain('asleep')
  })
  it('keeps the bar short, and says "Connecting…" only while an attempt is under way', () => {
    expect(barLabel('open', '')).toBe('')
    expect(barLabel('connecting', 'machine-offline')).toBe('Connecting…')
    expect(barLabel('offline', 'machine-offline')).toBe('Computer offline')
    expect(barLabel('open', 'removed')).toBe('Removed: pair again')
  })
})

describe('the first screen', () => {
  it('offers to install the app when Chrome says it can be installed', async () => {
    listenForInstall(window)
    window.dispatchEvent(
      Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
        prompt: async () => {},
        userChoice: Promise.resolve({ outcome: 'dismissed' as const }),
      }),
    )
    render(<RemoteRoot />)
    expect(await screen.findByRole('button', { name: 'Install the Caprock app' })).toBeTruthy()
  })
})
