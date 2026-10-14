import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { api } from '@/lib/api'
import { JUST_PAIRED_KEY } from '@/screens/Pair'
import { appReport, ReadyCard, ReadyGate, readyCardDue } from './ReadyCard'

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
