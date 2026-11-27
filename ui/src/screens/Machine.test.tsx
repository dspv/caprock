import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MachineScreen, MachinesScreen } from './Machine'
import { clearShared } from '@/lib/refresh'
import { AppActionsContext, type SetupReport } from '@/lib/setup'
import { ApiError, type SessionSummary } from '@/lib/api'
import { MACHINE_READ_MS, machinesApi, readTimeout, type Machine } from '@/lib/machines'

const ID = 'f7kc4QaG4HRPYEjg19Pr-au-FeTljmKHkikFrAmRTzM'
const mini: Machine = { id: ID, name: 'Mac mini', relay: 'wss://relay.example', added_at: 1, status: 'online', kind: 'machine', role: 'controller', streams: 0 }
const s = (id: string, status: SessionSummary['status'], title: string) => ({ session_id: id, title, cwd: '/home/me/proj', project: 'proj', status, last_event_at: 1 } as SessionSummary)

describe('MachineScreen — another computer’s sessions (ADR-067)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    clearShared()
    localStorage.clear()
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

  // ADR-108: right after a join with a key made here, the page says so and
  // that what is left waits for clicks.
  it('says a computer just joined, and that nothing ran or was sent', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([mini])
    vi.spyOn(machinesApi, 'sessions').mockResolvedValue([])
    render(<MachineScreen id={ID} joined />)
    const note = await screen.findByText(/Mac mini joined with the key/)
    const box = note.closest('[data-machine-joined]')!
    expect(box.textContent).toContain('Nothing has run there and nothing was sent')
    expect(box.textContent).toContain('Send secrets')
    expect(box.querySelector('a')!.getAttribute('href')).toBe(`#/m/${ID}`)
    cleanup()
    render(<MachineScreen id={ID} />)
    await screen.findByText('Nothing runs on Mac mini now.')
    expect(document.querySelector('[data-machine-joined]')).toBeNull()
  })

  it('opens one session in a frame of this dashboard pointed at that computer', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([mini])
    render(<MachineScreen id={ID} session="a" />)
    const frame = (await screen.findByTitle('Mac mini: session')) as HTMLIFrameElement
    expect(frame.getAttribute('src')).toBe(`/?machine=${ID}#/session/a?tab=chat`)
  })

  it('says offline with the reason and offers to try again', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([{ ...mini, status: 'offline' }])
    vi.spyOn(machinesApi, 'sessions').mockRejectedValue(new ApiError(503, '503', { error: 'the computer is offline', status: 'offline' }))
    render(<MachineScreen id={ID} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Mac mini is offline. It is not at its relay')
    expect(alert.getAttribute('title')).toBe('the computer is offline')
    expect(alert.textContent).toContain('Try again')
  })

  // Win PC1, 2026-11-26: online, nothing running, and the page's own read
  // never answered — the page sat on grey rows for good.
  it('online with nothing running says so from the shared list, while its own read is still out', async () => {
    const win = { ...mini, name: 'Win PC1', version: '0.196.0' }
    vi.spyOn(machinesApi, 'list').mockResolvedValue([win])
    vi.spyOn(machinesApi, 'allSessions').mockResolvedValue([{ id: ID, name: 'Win PC1', status: 'online', sessions: [], at: 1, last_ok: 1 }])
    vi.spyOn(machinesApi, 'sessions').mockReturnValue(new Promise(() => {}))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 404 }))
    render(<MachineScreen id={ID} />)
    expect(await screen.findByText('Nothing runs on Win PC1 now.')).toBeTruthy()
    expect(document.querySelector('[data-machine-spec] [data-machine-state]')!.textContent).toBe('online')
    expect(document.querySelector('.skeleton-pulse')).toBeNull()
  })

  it('a read that never answers ends in an error with Try again, never an endless skeleton', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([{ ...mini, name: 'Win PC1' }])
    vi.spyOn(machinesApi, 'allSessions').mockRejectedValue(readTimeout(MACHINE_READ_MS))
    const read = vi.spyOn(machinesApi, 'sessions').mockRejectedValueOnce(readTimeout(MACHINE_READ_MS))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 404 }))
    render(<MachineScreen id={ID} />)
    const alert = await screen.findByRole('alert')
    expect(alert.getAttribute('data-machine-error')).toBe('timeout')
    expect(alert.textContent).toContain('Win PC1 is online but did not answer in time.')
    // Still online: the channel says so; a slow read is not offline.
    expect(document.querySelector('[data-machine-band]')!.getAttribute('data-machine-band')).toBe('online')
    expect(document.querySelector('[data-machine-offline-note]')).toBeNull()
    read.mockResolvedValueOnce([])
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Nothing runs on Win PC1 now.')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
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

  // The owner's pick of 2026-11-25: page B, the machine card.
  const GiB = 2 ** 30
  const readyMac: SetupReport = {
    os: 'darwin',
    items: [
      { key: 'agent', state: 'ok', label: 'Agents', detail: '' },
      { key: 'project', state: 'ok', label: 'Projects', detail: '7 projects.', optional: true },
    ],
    agents: [{ id: 'claude', label: 'Claude Code', on: true, state: 'ok', detail: '' }],
  }
  const answer = (rep: SetupReport, machine: Record<string, number>) => async (u: RequestInfo | URL) => String(u).endsWith('/v1/setup')
    ? new Response(JSON.stringify(rep), { status: 200 })
    : new Response(JSON.stringify({ machine }), { status: 200 })

  it('draws the band, memory used of total (amber at 70%), the processor from the load, and what is ready', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([{ ...mini, version: '0.196.0' }])
    vi.spyOn(machinesApi, 'sessions').mockResolvedValue([s('a', 'active', 'Running one'), s('b', 'active', 'Running two')])
    vi.spyOn(globalThis, 'fetch').mockImplementation(answer(readyMac, { cpus: 12, load1: 5.2, mem_total: 36 * GiB, mem_available: 7.9 * GiB }))
    const newAgentOn = vi.fn()
    render(<AppActionsContext.Provider value={{ newAgentOn }}><MachineScreen id={ID} /></AppActionsContext.Provider>)
    const mem = await screen.findByText('28.1 GB')
    expect(mem.parentElement!.textContent).toContain('used of 36 GB · 78%')
    expect(document.querySelector('[data-machine-meter="memory"] [data-meter-warn]')).toBeTruthy()
    expect(document.querySelector('[data-machine-meter="cpu"]')!.textContent).toBe('43%processor, 12 cores · load 5.2')
    expect(document.querySelector('[data-machine-meter="running"]')!.textContent).toBe('2agents running')
    expect(document.querySelector('[data-machine-spec]')!.textContent).toBe('online · readymacOS36 GB memory12 coresCaprock 0.196.0')
    expect(screen.getByText('Claude Code, signed in')).toBeTruthy()
    expect(screen.getByText('7 projects')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Start an agent there' }))
    expect(newAgentOn).toHaveBeenCalledWith(ID)
  })

  it('says No figure for the processor on Windows, and offers no Start button outside the app', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([{ ...mini, name: 'Win PC1' }])
    vi.spyOn(machinesApi, 'sessions').mockResolvedValue([])
    vi.spyOn(globalThis, 'fetch').mockImplementation(answer({ ...readyMac, os: 'windows' }, { cpus: 16, mem_total: 32 * GiB, mem_available: 18.9 * GiB }))
    render(<MachineScreen id={ID} />)
    await vi.waitFor(() => expect(document.querySelector('[data-machine-meter="cpu"]')?.textContent).toBe('No figureprocessor, 16 cores · Windows gives no load'))
    expect(document.querySelector('[data-machine-meter="cpu"] [role="meter"]')).toBeNull()
    expect(document.querySelector('[data-machine-meter="memory"] [data-meter-warn]')).toBeNull()
    expect(document.querySelector('[data-os-glyph="windows"]')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Start an agent there' })).toBeNull()
    expect(screen.getByText('Nothing runs on Win PC1 now.')).toBeTruthy()
  })

  it('offline, says when it was seen and what it was last time, and draws no meters', async () => {
    vi.spyOn(machinesApi, 'list').mockResolvedValue([{ ...mini, status: 'offline', version: '0.188.2', last_seen: Date.now() - 3 * 86_400_000 }])
    vi.spyOn(machinesApi, 'sessions').mockRejectedValue(new ApiError(503, '503', { error: 'the computer is offline', status: 'offline' }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 503 }))
    render(<AppActionsContext.Provider value={{ newAgentOn: vi.fn() }}><MachineScreen id={ID} /></AppActionsContext.Provider>)
    const note = await vi.waitFor(() => { const n = document.querySelector('[data-machine-offline-note]'); expect(n).toBeTruthy(); return n! })
    expect(note.textContent).toContain('Offline, seen 3d ago.')
    expect(note.textContent).toContain('Last known: Caprock 0.188.2.')
    expect(document.querySelector('[data-machine-meters]')).toBeNull()
    expect(document.querySelector('[data-machine-band]')!.getAttribute('data-machine-band')).toBe('offline')
    expect(screen.queryByRole('button', { name: 'Start an agent there' })).toBeNull()
  })
})

describe('MachinesScreen — All computers', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    clearShared()
    localStorage.clear()
  })

  it('is one card each, with the same bars, and a summary line', async () => {
    const GiB = 2 ** 30
    const win = { ...mini, id: `${ID.slice(0, -1)}W`, name: 'Win PC1' }
    const off = { ...mini, id: `${ID.slice(0, -1)}O`, name: 'Office Mac mini', status: 'offline' as const, version: '0.188.2' }
    vi.spyOn(machinesApi, 'list').mockResolvedValue([mini, win, off])
    vi.spyOn(machinesApi, 'allSessions').mockResolvedValue([
      { id: ID, name: 'Mac mini', status: 'online', at: 1, sessions: [s('a', 'active', 'One'), s('b', 'active', 'Two')] },
      { id: win.id, name: 'Win PC1', status: 'online', at: 1, sessions: [] },
      { id: off.id, name: 'Office Mac mini', status: 'offline' },
    ])
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => {
      const url = String(u)
      const isWin = url.includes(encodeURIComponent(win.id))
      if (url.includes(encodeURIComponent(off.id))) return new Response('{}', { status: 503 })
      return url.endsWith('/v1/setup')
        ? new Response(JSON.stringify({ os: isWin ? 'windows' : 'darwin', items: [] }), { status: 200 })
        : new Response(JSON.stringify({ machine: isWin ? { cpus: 16, mem_total: 32 * GiB, mem_available: 19 * GiB } : { cpus: 12, load1: 5.2, mem_total: 36 * GiB, mem_available: 8 * GiB } }), { status: 200 })
    })
    render(<MachinesScreen />)
    await vi.waitFor(() => expect(document.querySelector('[data-machines-summary]')?.textContent).toBe('3 linked · 2 online · 2 agents running'))
    await vi.waitFor(() => expect(document.querySelector(`[data-machine-card="${win.id}"] [data-machine-card-cpu]`)?.textContent).toContain('no figure on Windows'))
    expect(document.querySelector(`[data-machine-card="${ID}"] [data-machine-card-cpu]`)!.textContent).toContain('43%')
    const offCard = document.querySelector(`[data-machine-card="${off.id}"]`)!
    expect(offCard.hasAttribute('data-offline')).toBe(true)
    expect(offCard.querySelector('[data-machine-card-state]')!.textContent).toMatch(/^offline · /)
    expect(offCard.getAttribute('href')).toBe(`#/m/${off.id}`)
  })
})
