import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MachineRows } from './MachineRows'
import { type SessionSummary } from '@/lib/api'
import { machinesApi, type Machine } from '@/lib/machines'
import { clearShared } from '@/lib/refresh'

const ID = 'f7kc4QaG4HRPYEjg19Pr-au-FeTljmKHkikFrAmRTzM'
const mini: Machine = { id: ID, name: 'Mac mini', relay: 'wss://relay.example', added_at: 1, status: 'online', kind: 'machine', role: 'controller', streams: 0 }
const session = (id: string, title: string): SessionSummary => ({ session_id: id, title, cwd: '/Users/me/proj', project: 'proj', status: 'active', last_event_at: 1 } as SessionSummary)

describe('MachineRows — the sidebar’s other computers (ADR-067)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    clearShared()
    localStorage.clear()
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
    await vi.waitFor(() => expect(screen.getAllByText(/^offline · /).length).toBe(1))
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

  // The owner could not rename a computer from the sidebar (2026-11-20).
  it('renames a computer from its row menu: right-click, Rename, type, Enter', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([mini])
    vi.spyOn(machinesApi, 'allSessions').mockResolvedValue([{ id: ID, name: 'Mac mini', status: 'online', at: 1, sessions: [] }])
    const rename = vi.spyOn(machinesApi, 'rename').mockResolvedValue({ ...mini, name: 'Home PC' })
    render(<MachineRows onOpen={vi.fn()} dashboardActive={false} />)
    const row = await screen.findByRole('button', { name: /^Mac mini/ })
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = screen.getByRole('textbox', { name: 'Computer name' })
    fireEvent.change(input, { target: { value: 'Home PC' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await vi.waitFor(() => expect(rename).toHaveBeenCalledWith(ID, 'Home PC'))
  })

  it('opens the same menu from the keyboard, Shift+F10 as on Windows and Linux', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([mini])
    vi.spyOn(machinesApi, 'allSessions').mockResolvedValue([{ id: ID, name: 'Mac mini', status: 'online', at: 1, sessions: [] }])
    render(<MachineRows onOpen={vi.fn()} dashboardActive={false} />)
    fireEvent.keyDown(await screen.findByRole('button', { name: /^Mac mini/ }), { key: 'F10', shiftKey: true })
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Open' })).toBeTruthy()
  })

  // The owner's pick of 2026-11-25 (list A): two lines a computer, a count badge, and All N.
  it('draws each computer on two lines — OS · memory · running — with a count badge and All N', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([mini])
    vi.spyOn(machinesApi, 'allSessions').mockResolvedValue([{ id: ID, name: 'Mac mini', status: 'online', at: 1, sessions: [session('s1', 'One'), session('s2', 'Two')] }])
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => String(u).endsWith('/v1/setup')
      ? new Response(JSON.stringify({ os: 'darwin', items: [] }), { status: 200 })
      : new Response(JSON.stringify({ machine: { cpus: 12, mem_total: 36 * 2 ** 30, mem_available: 8 * 2 ** 30 } }), { status: 200 }))
    const onOpen = vi.fn()
    render(<MachineRows onOpen={onOpen} dashboardActive={false} />)
    await vi.waitFor(() => expect(document.querySelector('[data-machine-row-line]')?.textContent).toBe('macOS · 36 GB · 2 running'))
    expect(document.querySelector('[data-machine-row-count]')?.textContent).toBe('2')
    fireEvent.click(screen.getByRole('button', { name: 'All 1' }))
    expect(onOpen).toHaveBeenCalledWith('#/m')
  })

  it('greys an offline computer and says when it was last seen, with no badge', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([{ ...mini, status: 'offline', last_seen: Date.now() - 3 * 86_400_000 }])
    vi.spyOn(machinesApi, 'allSessions').mockResolvedValue([{ id: ID, name: 'Mac mini', status: 'offline', error: 'the computer is offline' }])
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 503 }))
    render(<MachineRows onOpen={vi.fn()} dashboardActive={false} />)
    await vi.waitFor(() => expect(document.querySelector('[data-machine-row-line]')?.textContent).toBe('offline · seen 3d ago'))
    expect(document.querySelector('[data-machine-row-line]')!.className).toContain('text-fg-faint')
    expect(document.querySelector('[data-machine-row-count]')).toBeNull()
  })
})
