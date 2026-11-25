import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentsReady, cpuPct, fetchMachineSpec, machineLine, machineState, memoryUse, meterWarn, projectsThere, stateStatus } from './machinespec'
import { MACHINE_READ_MS } from './machines'
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

  it('takes online or offline from the channel, never from a read that failed (Win PC1, 2026-11-26)', () => {
    // The owner's case: the channel online, its sessions read empty — online.
    expect(machineState({ status: 'online' }, { status: 'online' })).toEqual({ online: true, offline: false, down: false })
    // A read that ran out of time, or failed, on an online channel: still online.
    expect(machineState({ status: 'online' }, { status: 'offline' })).toEqual({ online: true, offline: false, down: false })
    expect(machineState({ status: 'online' }, { status: 'timeout' })).toEqual({ online: true, offline: false, down: false })
    expect(machineState({ status: 'online' }, { status: 'error' })).toEqual({ online: true, offline: false, down: false })
    // A read that answered counts for a channel not opened yet; offline is the channel's word.
    expect(machineState({ status: 'idle' }, { status: 'online' })).toEqual({ online: true, offline: false, down: false })
    expect(machineState({ status: 'offline' }, { status: 'online' })).toEqual({ online: false, offline: true, down: true })
    // Offline when the channel says so, or a read does and the channel is not up.
    expect(machineState({ status: 'offline' })).toEqual({ online: false, offline: true, down: true })
    expect(machineState({ status: 'idle' }, { status: 'offline' })).toEqual({ online: false, offline: true, down: true })
    // A state that needs its owner, said by either.
    expect(machineState({ status: 'pending' })).toEqual({ online: false, offline: false, down: true })
    expect(machineState({ status: 'online' }, { status: 'revoked' })).toEqual({ online: false, offline: false, down: true })
  })

  it('words a view by the same state: a read that needs its owner first, else online or offline', () => {
    const word = (m: string, r?: string) => stateStatus({ status: m as never }, r ? { status: r } : undefined, machineState({ status: m as never }, r ? { status: r } : undefined))
    expect(word('online', 'offline')).toBe('online')
    expect(word('idle', 'online')).toBe('online')
    expect(word('online', 'revoked')).toBe('revoked')
    expect(word('idle')).toBe('idle')
    expect(word('offline')).toBe('offline')
  })

  it('gives up on a figure read that never answers, rather than holding the view for good', async () => {
    vi.useFakeTimers()
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation((_u, init) => new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }))
      const got = fetchMachineSpec('abc')
      const settled = expect(got).rejects.toThrow('no answer')
      await vi.advanceTimersByTimeAsync(MACHINE_READ_MS + 10)
      await settled
    } finally {
      vi.useRealTimers()
    }
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
