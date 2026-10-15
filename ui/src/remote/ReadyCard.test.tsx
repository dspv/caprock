import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { api } from '@/lib/api'
import { JUST_PAIRED_KEY } from '@/screens/Pair'
import { appReport, homeScreenSteps, ReadyCard, ReadyGate, readyCardDue } from './ReadyCard'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('readyCardDue', () => {
  it('shows once after pairing, whatever the role', () => {
    expect(readyCardDue({ justPaired: true, role: 'controller', dismissed: '', machine: 'm' })).toBe(true)
  })
  it('shows while the phone cannot type, until closed for that answer', () => {
    expect(readyCardDue({ justPaired: false, role: 'viewer', dismissed: '', machine: 'm' })).toBe(true)
    expect(readyCardDue({ justPaired: false, role: 'viewer', dismissed: 'm:viewer', machine: 'm' })).toBe(false)
    expect(readyCardDue({ justPaired: false, role: 'viewer', dismissed: 'other:viewer', machine: 'm' })).toBe(true)
  })
  it('stays away from a controller that has seen it', () => {
    expect(readyCardDue({ justPaired: false, role: 'controller', dismissed: '', machine: 'm' })).toBe(false)
    expect(readyCardDue({ justPaired: false, role: '', dismissed: '', machine: 'm' })).toBe(false)
  })
})

describe('appReport', () => {
  it('reports installed, not installed, or nothing', () => {
    expect(appReport(null, true)).toBe(true)
    expect(appReport('installed', false)).toBe(true)
    expect(appReport('button', false)).toBe(false)
    expect(appReport('ios', false)).toBeUndefined()
    expect(appReport(null, false)).toBeUndefined()
  })
})

describe('ReadyCard', () => {
  it('says Ready, the computer, and that this phone can type', () => {
    render(<ReadyCard name="Mac mini" me={{ role: 'controller' }} offer="button" onOpen={() => {}} onClose={() => {}} />)
    expect(screen.getByRole('heading').textContent).toBe('Ready')
    expect(screen.getByTestId('ready-connected').textContent).toContain('Connected to Mac mini')
    expect(screen.getByTestId('ready-type').dataset.ok).toBe('1')
    expect(screen.getByRole('button', { name: 'Install the Caprock app' })).toBeTruthy()
  })
  it('a view-only phone gets the exact place on the computer that fixes it', () => {
    render(<ReadyCard name="Mac mini" me={{ role: 'viewer' }} offer={null} onOpen={() => {}} onClose={() => {}} />)
    expect(screen.getByRole('heading').textContent).toBe('Connected, view only')
    const row = screen.getByTestId('ready-type')
    expect(row.dataset.ok).toBe('0')
    expect(row.textContent).toContain('View only. To type, on the computer: Caprock app → Settings → Use on your phone → Let it control sessions next to this phone')
  })
})

describe('ReadyGate', () => {
  beforeEach(() => localStorage.setItem('caprock.device.token', 'tok'))

  it('is never in the way: not while a code is being redeemed, and not when the machine does not answer', async () => {
    localStorage.setItem(JUST_PAIRED_KEY, '1')
    localStorage.removeItem('caprock.device.token')
    vi.spyOn(api, 'pairMe').mockRejectedValue(new Error('401'))
    render(<ReadyGate machineId="m" machineName="Mac mini"><p>dashboard</p></ReadyGate>)
    expect(screen.getByText('dashboard')).toBeTruthy()
    cleanup()
    localStorage.setItem('caprock.device.token', 'tok')
    render(<ReadyGate machineId="m" machineName="Mac mini"><p>dashboard</p></ReadyGate>)
    expect(await screen.findByText('dashboard')).toBeTruthy()
  })

  it('after pairing, shows the card before the dashboard, and Open sessions lets it through', async () => {
    localStorage.setItem(JUST_PAIRED_KEY, '1')
    vi.spyOn(api, 'pairMe').mockResolvedValue({ role: 'controller' })
    render(<ReadyGate machineId="m" machineName="Mac mini"><p>dashboard</p></ReadyGate>)
    expect(await screen.findByTestId('ready-card')).toBeTruthy()
    expect(screen.queryByText('dashboard')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open sessions' }))
    expect(await screen.findByText('dashboard')).toBeTruthy()
    expect(localStorage.getItem(JUST_PAIRED_KEY)).toBeNull()
  })
  it('a controller that has seen it goes straight to the dashboard', async () => {
    const me = vi.spyOn(api, 'pairMe').mockResolvedValue({ role: 'controller' })
    render(<ReadyGate machineId="m" machineName="Mac mini"><p>dashboard</p></ReadyGate>)
    expect(screen.getByText('dashboard')).toBeTruthy()
    await waitFor(() => expect(me).toHaveBeenCalled())
    expect(screen.queryByTestId('ready-card')).toBeNull()
  })
  it('a view-only phone sees it until closed, and not again for that answer', async () => {
    vi.spyOn(api, 'pairMe').mockResolvedValue({ role: 'viewer' })
    render(<ReadyGate machineId="m" machineName="Mac mini"><p>dashboard</p></ReadyGate>)
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
    expect(await screen.findByText('dashboard')).toBeTruthy()
    cleanup()
    render(<ReadyGate machineId="m" machineName="Mac mini"><p>dashboard</p></ReadyGate>)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId('ready-card')).toBeNull()
  })
})

// Vova, 2026-10-15: the address is the way back, said once right after
// pairing, with the home-screen step in the words of this phone's browser.
describe('the way back, after pairing', () => {
  it('names the address to open next time while the app is not installed', () => {
    render(<ReadyCard name="Mac mini" me={{ role: 'controller' }} offer="ios" page="m.caprock.dev" kind="ios" onOpen={() => {}} onClose={() => {}} />)
    expect(screen.getByTestId('ready-return').textContent).toContain('Next time, just open m.caprock.dev on this phone: it stays paired.')
  })
  it('says nothing more once the app is installed', () => {
    render(<ReadyCard name="Mac mini" me={{ role: 'controller' }} offer="installed" page="m.caprock.dev" kind="android" onOpen={() => {}} onClose={() => {}} />)
    expect(screen.queryByTestId('ready-return')).toBeNull()
  })
  it('gives Chrome on Android its own menu step, never "Add to Home screen"', () => {
    render(<ReadyCard name="Mac mini" me={{ role: 'controller' }} offer={null} page="m.caprock.dev" kind="android" onOpen={() => {}} onClose={() => {}} />)
    expect(screen.getByTestId('ready-app').textContent).toContain('⋮ → Install app')
    expect(homeScreenSteps(null, 'android')).not.toContain('Add to Home')
    expect(homeScreenSteps('ios', null)).toBe('In Safari: Share → Add to Home Screen.')
    expect(homeScreenSteps(null, null)).toBe('Install the app when the browser offers it.')
  })
})
