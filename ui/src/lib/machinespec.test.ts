import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentsReady, cpuPct, fetchMachineSpec, machineLine, machineState, memoryUse, meterWarn, projectsThere } from './machinespec'
import type { SetupReport } from './setup'

const GiB = 2 ** 30
const setup = (over: Partial<SetupReport> = {}): SetupReport => ({
  os: 'darwin',
  items: [
    { key: 'agent', state: 'ok', label: 'Claude Code', detail: '' },
    { key: 'signin', state: 'ok', label: 'Sign in', detail: '' },
    { key: 'project', state: 'ok', label: 'Projects', detail: '7 projects.', optional: true },
  ],
  ...over,
})

describe('machinespec — a computer’s figures, from what it already answers', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('reads memory in use as the total less what is free, with its share', () => {
    const m = memoryUse({ cpus: 12, mem_total: 36 * GiB, mem_available: 7.9 * GiB })!
    expect(m.used).toBeCloseTo(28.1, 5)
    expect([m.total, m.pct]).toEqual([36, 78])
    expect(memoryUse(undefined)).toBeUndefined()
  })

  it('reads the processor from the one-minute load over the cores, and none on Windows', () => {
    expect(cpuPct({ cpus: 12, load1: 5.2, mem_total: 1, mem_available: 1 })).toBe(43)
    expect(cpuPct({ cpus: 4, load1: 9, mem_total: 1, mem_available: 1 })).toBe(100)
    // Windows gives no load figure.
    expect(cpuPct({ cpus: 16, mem_total: 1, mem_available: 1 })).toBeUndefined()
  })

  it('turns a bar amber at 70% and over', () => {
    expect(meterWarn(69)).toBe(false)
    expect(meterWarn(70)).toBe(true)
  })

  it('words the sidebar line: OS, memory, running or idle; offline with when it was seen', () => {
    const spec = { setup: setup(), machine: { cpus: 12, mem_total: 36 * GiB, mem_available: 8 * GiB } }
    expect(machineLine({ offline: false, spec, running: 2 })).toBe('macOS · 36 GB · 2 running')
    expect(machineLine({ offline: false, spec: { setup: setup({ os: 'windows' }), machine: { cpus: 16, mem_total: 32 * GiB, mem_available: 20 * GiB } }, running: 0 })).toBe('Windows · 32 GB · idle')
    expect(machineLine({ offline: false, running: 0 })).toBe('idle')
    const now = Date.UTC(2026, 10, 25)
    expect(machineLine({ offline: true, lastSeen: now - 3 * 86_400_000, running: 0, now })).toBe('offline · seen 3d ago')
    expect(machineLine({ offline: false, state: 'waiting for Allow', running: 0 })).toBe('waiting for Allow')
  })

  it('takes what its session list said last over the list’s state', () => {
    expect(machineState({ status: 'online' }, { status: 'offline' })).toEqual({ online: false, offline: true, down: true })
    expect(machineState({ status: 'idle' }, { status: 'online' })).toEqual({ online: true, offline: false, down: false })
    expect(machineState({ status: 'pending' })).toEqual({ online: false, offline: false, down: true })
  })

  it('names the agents ready there, from a Caprock before the switches too, and counts projects', () => {
    expect(agentsReady(setup())).toEqual(['Claude Code'])
    expect(agentsReady(setup({ agents: [{ id: 'claude', label: 'Claude Code', on: true, state: 'ok', detail: '' }, { id: 'codex', label: 'Codex', on: true, state: 'missing', detail: '' }] }))).toEqual(['Claude Code'])
    expect(projectsThere(setup())).toBe(7)
  })

  it('keeps only the machine figures of the resource report, and fails when neither read answers', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => String(u).endsWith('/v1/setup')
      ? new Response(JSON.stringify(setup()), { status: 200 })
      : new Response(JSON.stringify({ at: 1, sessions: [{ pid: 1 }], machine: { cpus: 8, mem_total: 16 * GiB, mem_available: 8 * GiB } }), { status: 200 }))
    const got = await fetchMachineSpec('abc')
    expect(got.machine?.cpus).toBe(8)
    expect(Object.keys(got).sort()).toEqual(['machine', 'setup'])
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 404 }))
    await expect(fetchMachineSpec('abc')).rejects.toThrow()
  })
})
