import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MachineScreen } from './Machine'
import { ApiError, type SessionSummary } from '@/lib/api'
import { machinesApi, type Machine } from '@/lib/machines'

const ID = 'f7kc4QaG4HRPYEjg19Pr-au-FeTljmKHkikFrAmRTzM'
const mini: Machine = { id: ID, name: 'Mac mini', relay: 'wss://relay.example', added_at: 1, status: 'online', kind: 'machine', role: 'controller', streams: 0 }
const s = (id: string, status: SessionSummary['status'], title: string) => ({ session_id: id, title, cwd: '/home/me/proj', project: 'proj', status, last_event_at: 1 } as SessionSummary)

describe('MachineScreen — another computer’s sessions (ADR-067)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('lists what runs there and what ran, each opening through /v1/m/', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([mini])
    const read = vi.spyOn(machinesApi, 'sessions').mockResolvedValue([s('a', 'active', 'Running one'), s('b', 'ended', 'Done one')])
    render(<MachineScreen id={ID} />)
    const running = await screen.findByText('Running one')
    expect(read).toHaveBeenCalledWith(ID, false)
    expect(running.closest('a')!.getAttribute('href')).toBe(`#/m/${ID}/session/a`)
    expect(screen.getByText('Recent · 1')).toBeTruthy()
  })

  it('opens one session in a frame of this dashboard pointed at that computer', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([mini])
    render(<MachineScreen id={ID} session="a" />)
    const frame = (await screen.findByTitle('Mac mini: session')) as HTMLIFrameElement
    expect(frame.getAttribute('src')).toBe(`/?machine=${ID}#/session/a?tab=terminal`)
  })

  it('says offline with the reason and offers to try again', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([mini])
    vi.spyOn(machinesApi, 'sessions').mockRejectedValue(new ApiError(503, '503', { error: 'the computer is offline', status: 'offline' }))
    render(<MachineScreen id={ID} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Mac mini is offline. It is not at its relay')
    expect(alert.getAttribute('title')).toBe('the computer is offline')
    expect(alert.textContent).toContain('Try again')
  })

  it('draws no frame for a computer that removed this one, and says what to do', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([{ ...mini, status: 'revoked' }])
    render(<MachineScreen id={ID} session="a" />)
    expect((await screen.findByRole('alert')).textContent).toContain('removed this computer')
    expect(screen.queryByTitle('Mac mini: session')).toBeNull()
  })

  it('says when the computer is not linked here', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([])
    render(<MachineScreen id={ID} />)
    expect(await screen.findByText('No such computer')).toBeTruthy()
  })
})
