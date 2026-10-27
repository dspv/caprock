import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MachineRows } from './MachineRows'
import { type SessionSummary } from '@/lib/api'
import { machinesApi, type Machine } from '@/lib/machines'

const ID = 'f7kc4QaG4HRPYEjg19Pr-au-FeTljmKHkikFrAmRTzM'
const mini: Machine = { id: ID, name: 'Mac mini', relay: 'wss://relay.example', added_at: 1, status: 'online', kind: 'machine', role: 'controller', streams: 0 }
const session = (id: string, title: string): SessionSummary => ({ session_id: id, title, cwd: '/Users/me/proj', project: 'proj', status: 'active', last_event_at: 1 } as SessionSummary)

describe('MachineRows — the sidebar’s other computers (ADR-067)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('with none linked, is one quiet "Add a machine" row that opens Settings → Computers', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([])
    const onSettingsSection = vi.fn()
    render(<MachineRows onOpen={vi.fn()} onSettingsSection={onSettingsSection} dashboardActive={false} />)
    const row = await screen.findByRole('button', { name: /Add a machine/ })
    // Quiet: no badge, no count beside it.
    expect(row.textContent).toBe('Add a machine')
    fireEvent.click(row)
    expect(onSettingsSection).toHaveBeenCalledWith('computers')
  })

  it('lists each computer and the sessions running there, tagged by it', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([mini])
    const all = vi.spyOn(machinesApi, 'allSessions').mockResolvedValue([{ id: ID, name: 'Mac mini', status: 'online', at: 1, sessions: [session('s1', 'Fix the build'), { ...session('s2', 'Old'), status: 'ended' }] }])
    const onOpen = vi.fn()
    render(<MachineRows onOpen={onOpen} dashboardActive={false} />)
    const row = await screen.findByRole('button', { name: /Fix the build/ })
    expect(all).toHaveBeenCalled()
    expect(row.querySelector('[data-machine-tag]')?.textContent).toBe('Mac mini')
    expect(screen.queryByText('Old')).toBeNull()
    fireEvent.click(row)
    expect(onOpen).toHaveBeenCalledWith(`#/m/${ID}/session/s1`)
    fireEvent.click(screen.getByRole('button', { name: /^Mac mini/ }))
    expect(onOpen).toHaveBeenCalledWith(`#/m/${ID}`)
  })

  it('says offline when the proxy does, and never asks a computer that removed this one', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([mini, { ...mini, id: `${ID.slice(0, -1)}B`, name: 'Linux box', status: 'revoked' }])
    const all = vi.spyOn(machinesApi, 'allSessions').mockResolvedValue([
      { id: ID, name: 'Mac mini', status: 'offline', error: 'the computer is offline', last_ok: 5 },
      { id: `${ID.slice(0, -1)}B`, name: 'Linux box', status: 'revoked' },
    ])
    render(<MachineRows onOpen={vi.fn()} dashboardActive={false} />)
    await vi.waitFor(() => expect(screen.getAllByText('offline').length).toBe(1))
    expect(screen.getByText('removed there')).toBeTruthy()
    // One request for every computer: the daemon reads each one.
    expect(all).toHaveBeenCalledTimes(1)
  })

  it('puts a session there that needs you first, with the warn dot and the reason', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([mini])
    const waiting = { ...session('s2', 'Waits'), last_event_at: 2, activity: { health: 'waiting-on-you', need: { reason: 'permission' } } } as unknown as SessionSummary
    vi.spyOn(machinesApi, 'allSessions').mockResolvedValue([{ id: ID, name: 'Mac mini', status: 'online', at: 1, sessions: [{ ...session('s1', 'Works'), activity: { health: 'working' } } as unknown as SessionSummary, waiting] }])
    render(<MachineRows onOpen={vi.fn()} dashboardActive={false} />)
    const row = await screen.findByRole('button', { name: /Waits/ })
    const rows = [...document.querySelectorAll('[data-machine-session-row]')].map((r) => r.getAttribute('data-machine-session-row'))
    expect(rows).toEqual(['s2', 's1'])
    expect(row.hasAttribute('data-needs-you')).toBe(true)
    expect(row.getAttribute('title')).toContain('needs you: permission')
    expect(screen.getByText('1 needs you')).toBeTruthy()
  })
})
