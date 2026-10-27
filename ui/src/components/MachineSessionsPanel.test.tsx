import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/lib/api'
import { machinesApi, remoteRunning, type Machine } from '@/lib/machines'
import { MachineSessionsPanel } from './MachineSessionsPanel'

const ID = 'f7kc4QaG4HRPYEjg19Pr-au-FeTljmKHkikFrAmRTzM'
const mini: Machine = { id: ID, name: 'Mac mini', relay: 'wss://relay.example', added_at: 1, status: 'online', kind: 'machine', role: 'controller', streams: 0 }
const s = (id: string, title: string, over: Record<string, unknown> = {}) =>
  ({ session_id: id, title, cwd: '/home/me/api', project: 'api', status: 'active', last_event_at: 10, activity: { health: 'working' }, ...over }) as unknown as SessionSummary

describe('Now · On other computers (ADR-067, Phase 2)', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('draws nothing with no other computer', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([])
    const all = vi.spyOn(machinesApi, 'allSessions')
    const { container } = render(<MachineSessionsPanel now={100} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(container.innerHTML).toBe('')
    expect(all).not.toHaveBeenCalled()
  })

  it('lists their sessions, the one needing you first and tagged, and an offline one by when it last answered', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([mini, { ...mini, id: 'box', name: 'Linux box' }])
    vi.spyOn(machinesApi, 'allSessions').mockResolvedValue([
      { id: ID, name: 'Mac mini', status: 'online', at: 50, sessions: [s('a', 'Works'), s('b', 'Waits', { activity: { health: 'waiting-on-you', need: { reason: 'permission' } } })] },
      { id: 'box', name: 'Linux box', status: 'offline', error: 'the computer is offline', last_ok: 40 },
    ])
    render(<MachineSessionsPanel now={100_000} />)
    const first = await screen.findByText('Waits')
    const rows = [...document.querySelectorAll('[data-machine-panel-row]')]
    expect(rows.map((r) => r.getAttribute('data-machine-panel-row'))).toEqual(['b', 'a'])
    expect(first.closest('a')?.getAttribute('href')).toBe(`#/m/${ID}/session/b`)
    expect(first.closest('a')?.querySelector('[data-need="permission"]')).toBeTruthy()
    expect(first.closest('a')?.querySelector('[data-machine-tag]')?.textContent).toBe('Mac mini')
    expect(screen.getByText(/1 needs you/)).toBeTruthy()
    const down = document.querySelector('[data-machine-panel-down="box"]')
    expect(down?.textContent).toMatch(/Linux box· offline, last answered/)
  })

  it('orders across computers: needing you oldest first, then newest', () => {
    const got = remoteRunning([
      { id: 'x', name: 'X', status: 'online', sessions: [s('x1', 'x1', { last_event_at: 5 }), s('x2', 'x2', { last_event_at: 9, activity: { health: 'waiting-on-you' } })] },
      { id: 'y', name: 'Y', status: 'online', sessions: [s('y1', 'y1', { last_event_at: 7 }), s('y2', 'y2', { last_event_at: 3, activity: { health: 'waiting-on-you' } }), s('y3', 'y3', { status: 'ended' })] },
    ])
    expect(got.map((r) => r.session.session_id)).toEqual(['y2', 'x2', 'y1', 'x1'])
  })
})
