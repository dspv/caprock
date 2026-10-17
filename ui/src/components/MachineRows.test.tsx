import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MachineRows } from './MachineRows'
import { ApiError, type SessionSummary } from '@/lib/api'
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
    const sessions = vi.spyOn(machinesApi, 'sessions').mockResolvedValue([session('s1', 'Fix the build'), { ...session('s2', 'Old'), status: 'ended' }])
    const onOpen = vi.fn()
    render(<MachineRows onOpen={onOpen} dashboardActive={false} />)
    const row = await screen.findByRole('button', { name: /Fix the build/ })
    expect(sessions).toHaveBeenCalledWith(ID)
    expect(row.querySelector('[data-machine-tag]')?.textContent).toBe('Mac mini')
    expect(screen.queryByText('Old')).toBeNull()
    fireEvent.click(row)
    expect(onOpen).toHaveBeenCalledWith(`#/m/${ID}/session/s1`)
    fireEvent.click(screen.getByRole('button', { name: /^Mac mini/ }))
    expect(onOpen).toHaveBeenCalledWith(`#/m/${ID}`)
  })

  it('says offline when the proxy does, and never asks a computer that removed this one', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([mini, { ...mini, id: `${ID.slice(0, -1)}B`, name: 'Linux box', status: 'revoked' }])
    const sessions = vi.spyOn(machinesApi, 'sessions').mockRejectedValue(new ApiError(503, '503', { error: 'the computer is offline', status: 'offline' }))
    render(<MachineRows onOpen={vi.fn()} dashboardActive={false} />)
    await vi.waitFor(() => expect(screen.getAllByText('offline').length).toBe(1))
    expect(screen.getByText('removed there')).toBeTruthy()
    expect(sessions).toHaveBeenCalledTimes(1)
  })
})
