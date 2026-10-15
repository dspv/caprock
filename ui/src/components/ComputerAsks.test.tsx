import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ComputerAsks } from './ComputerAsks'
import { api, clearDeviceToken, setDeviceToken, type PairState } from '@/lib/api'
import { live, type Frame } from '@/lib/live'

const state = (devices: PairState['devices']): PairState => ({ enabled: false, devices })
const mini = { id: 'd1', name: 'MacBook', paired_at: 1, last_seen: 1, role: 'controller' as const, kind: 'machine' as const, pending: true }

describe('ComputerAsks — a computer waits for Allow (ADR-067)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    clearDeviceToken()
  })

  it('names the computer and allows it on Allow', async () => {
    const ps = vi.spyOn(api, 'pairState').mockResolvedValue(state([mini]))
    const allow = vi.spyOn(api, 'pairAllow').mockResolvedValue({ id: 'd1', role: 'controller' })
    render(<ComputerAsks />)
    const card = await screen.findByTestId('computer-asks')
    expect(card.textContent).toContain('MacBook wants to control this computer')
    expect(card.textContent).toContain('could not change settings or pairing')
    ps.mockResolvedValue(state([{ ...mini, pending: false }]))
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await vi.waitFor(() => expect(allow).toHaveBeenCalledWith('d1'))
    await vi.waitFor(() => expect(screen.queryByTestId('computer-asks')).toBeNull())
  })

  it('removes it on Deny', async () => {
    vi.spyOn(api, 'pairState').mockResolvedValue(state([mini]))
    const revoke = vi.spyOn(api, 'pairRevoke').mockResolvedValue({ revoked: 1 })
    render(<ComputerAsks />)
    await screen.findByTestId('computer-asks')
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith('d1'))
  })

  it('asks again when the daemon says the devices changed, and never for a phone or an allowed computer', async () => {
    const ps = vi.spyOn(api, 'pairState').mockResolvedValue(state([
      { ...mini, id: 'p1', name: 'Phone', kind: undefined, pending: undefined },
      { ...mini, id: 'm2', name: 'Mini', pending: false },
    ]))
    let push: ((f: Frame) => void) | undefined
    vi.spyOn(live, 'onFrame').mockImplementation((fn) => { push = fn; return () => {} })
    render(<ComputerAsks />)
    await vi.waitFor(() => expect(ps).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('computer-asks')).toBeNull()
    ps.mockResolvedValue(state([mini]))
    await act(async () => { push?.({ type: 'devices', data: {} }) })
    expect((await screen.findByTestId('computer-asks')).textContent).toContain('MacBook')
  })

  it('is never shown on a paired device', async () => {
    setDeviceToken('t')
    const ps = vi.spyOn(api, 'pairState').mockResolvedValue(state([mini]))
    render(<ComputerAsks />)
    await new Promise((r) => setTimeout(r, 10))
    expect(ps).not.toHaveBeenCalled()
    expect(screen.queryByTestId('computer-asks')).toBeNull()
  })
})
