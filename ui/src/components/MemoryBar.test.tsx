/**
 * The machine's memory on the status strip (owner-approved mockup,
 * 2026-10-22): green, amber and red; the popover that says who holds it; and
 * the one button that ends the idle agents Caprock started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryBar } from './MemoryBar'
import { Processes } from './ResourceMeter'
import { api, type SessionSummary } from '@/lib/api'
import { resetResourcesForTest, type ResourceReport } from '@/lib/resources'
import type { MachineMemory, MemoryReport } from '@/lib/memory'
import { agentStateText, endIdleLabel, fmtUsedOf } from '@/lib/memory'

const GB = 2 ** 30
const MB = 2 ** 20
const T = 1_791_400_000_000

function mem(level: MachineMemory['level'], over: Partial<MachineMemory> = {}): MachineMemory {
  return {
    label: 'Mac', total: 16 * GB, used: 9.1 * GB, level, pressure: level === 'critical' ? 'critical' : level === 'tight' ? 'warn' : 'normal',
    agents: 6.2 * GB, agent_count: 7, caprock: 400 * MB, other: 2.5 * GB, ...over,
  }
}

function frame(m: MachineMemory): ResourceReport {
  return {
    at: T, sessions: [],
    caprock: { daemon: { pid: 1, name: 'caprock', cpu_pct: 0, mem_bytes: 0 }, hosts: { count: 0, mem_bytes: 0, cpu_pct: 0, orphans: 0, reapable: 0, list: [] } },
    thresholds: { cpu_pct: 100, mem_bytes: 2 * GB, after_s: 60, interval_s: 5 },
    memory: m,
  }
}

function report(m: MachineMemory, over: Partial<MemoryReport> = {}): MemoryReport {
  return {
    at: T, memory: m,
    agents: [
      { session_id: 'a1', pid: 11, mem_bytes: 1.8 * GB, procs: 9, owned: true, state: 'working', endable: false },
      { session_id: 'a2', pid: 12, mem_bytes: 1.2 * GB, procs: 3, owned: true, state: 'idle', idle_since: T - 42 * 60_000, endable: true },
      { session_id: 'a3', pid: 13, mem_bytes: 900 * MB, procs: 2, owned: false, state: 'idle', idle_since: T - 3 * 3_600_000, endable: false },
      { session_id: 'a4', pid: 14, mem_bytes: 800 * MB, procs: 2, owned: true, state: 'waiting', endable: false },
      { session_id: 'a5', pid: 15, mem_bytes: 700 * MB, procs: 2, owned: true, state: 'idle', idle_since: T - 5 * 60_000, endable: true },
      { session_id: 'a6', pid: 16, mem_bytes: 500 * MB, procs: 1, owned: true, state: 'idle', idle_since: T - 9 * 60_000, endable: true },
      { session_id: 'a7', pid: 17, mem_bytes: 300 * MB, procs: 1, owned: true, state: 'working', endable: false },
    ],
    apps: [{ name: 'Google Chrome', mem_bytes: 3 * GB, procs: 40 }, { name: 'Slack', mem_bytes: 700 * MB, procs: 6 }],
    idle_end: { count: 3, mem_bytes: 2.4 * GB, session_ids: ['a2', 'a5', 'a6'] },
    ...over,
  }
}

const sessions = [
  { session_id: 'a1', name: 'fix the login' },
  { session_id: 'a2', name: 'docs pass' },
  { session_id: 'a3', name: 'their terminal' },
] as unknown as SessionSummary[]

const bar = () => document.querySelector<HTMLButtonElement>('[data-memory-bar]')
const popover = () => document.querySelector('[data-memory-popover]')

async function open() {
  await act(async () => { fireEvent.click(bar()!) })
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => { act(() => resetResourcesForTest()) })
afterEach(() => {
  act(() => resetResourcesForTest())
  vi.restoreAllMocks()
})

describe('the strip item', () => {
  it('is absent before the first report', () => {
    render(<MemoryBar owner />)
    expect(bar()).toBeNull()
  })

  it('normal: the machine, used of total, a green bar', () => {
    act(() => resetResourcesForTest(frame(mem('normal'))))
    render(<MemoryBar owner />)
    expect(bar()!.dataset.memoryBar).toBe('normal')
    expect(bar()!.textContent).toContain('This Mac 9.1/16 GB')
    expect(bar()!.textContent).not.toContain('agents')
    expect(document.querySelector('[data-memory-minibar] span')!.className).toContain('bg-ok')
  })

  it('names the OS off a Mac', () => {
    act(() => resetResourcesForTest(frame(mem('normal', { label: 'Linux' }))))
    render(<MemoryBar owner />)
    expect(bar()!.textContent).toContain('Linux 9.1/16 GB')
  })

  it('tight: amber, with what the agents hold', () => {
    act(() => resetResourcesForTest(frame(mem('tight', { used: 14 * GB }))))
    render(<MemoryBar owner />)
    expect(bar()!.dataset.memoryBar).toBe('tight')
    expect(bar()!.className).toContain('text-warn')
    expect(bar()!.textContent).toContain('agents 6.2 GB')
    expect(document.querySelector('[data-memory-minibar] span')!.className).toContain('bg-warn')
  })

  it('critical: red, "Memory low" and a way in', () => {
    act(() => resetResourcesForTest(frame(mem('critical', { used: 15.6 * GB }))))
    render(<MemoryBar owner />)
    expect(bar()!.dataset.memoryBar).toBe('critical')
    expect(bar()!.className).toContain('text-danger')
    expect(bar()!.textContent).toContain('Memory low')
    expect(bar()!.textContent).toContain('›')
    expect(bar()!.title).toContain('critical memory pressure')
  })
})

describe('the popover', () => {
  it('says who holds the memory, lists the agents and the other apps, and offers the idle ones', async () => {
    const m = mem('critical', { used: 15.6 * GB, swap_used: 3.4 * GB })
    act(() => resetResourcesForTest(frame(m)))
    vi.spyOn(api, 'systemMemory').mockResolvedValue(report(m))
    render(<MemoryBar owner sessions={sessions} />)
    await open()
    expect(popover()).not.toBeNull()
    expect(screen.getByText('Your Mac is out of memory')).toBeTruthy()
    expect(popover()!.textContent).toContain('swapping 3.4 GB')
    expect(document.querySelectorAll('[data-memory-stack] [data-part]')).toHaveLength(3)
    // Five agents, then "2 more".
    expect(document.querySelectorAll('[data-memory-agent]')).toHaveLength(5)
    expect(document.querySelector('[data-memory-more]')!.textContent).toBe('2 more')
    const row = (id: string) => document.querySelector(`[data-memory-agent="${id}"]`)!.textContent!
    expect(row('a1')).toContain('fix the login')
    expect(row('a1')).toContain('working')
    expect(row('a2')).toContain('idle 42 min')
    expect(row('a3')).toContain('elsewhere')
    expect(row('a4')).toContain('waiting on you')
    expect(document.querySelectorAll('[data-memory-app]')).toHaveLength(2)
    expect(popover()!.textContent).toContain('Google Chrome')
    const btn = document.querySelector<HTMLButtonElement>('[data-end-idle]')!
    expect(btn.textContent).toBe('End 3 idle agents · frees about 2.4 GB')
    expect(popover()!.textContent).toContain('Ending keeps their conversations; Continue picks them up later.')
    expect(popover()!.textContent).toContain('never ended from here')
  })

  it('ends exactly the agents the daemon offered, on the click', async () => {
    const m = mem('critical')
    act(() => resetResourcesForTest(frame(m)))
    vi.spyOn(api, 'systemMemory').mockResolvedValue(report(m))
    const ended = vi.spyOn(api, 'endIdleAgents').mockResolvedValue({ ended: ['a2', 'a5', 'a6'] })
    render(<MemoryBar owner sessions={sessions} />)
    await open()
    expect(ended).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(document.querySelector('[data-end-idle]')!) })
    expect(ended).toHaveBeenCalledWith(['a2', 'a5', 'a6'])
    expect(document.querySelector('[data-memory-note]')!.textContent).toBe('Ended 3 agents.')
  })

  it('has no button when no agent is idle', async () => {
    const m = mem('critical')
    act(() => resetResourcesForTest(frame(m)))
    vi.spyOn(api, 'systemMemory').mockResolvedValue(report(m, { idle_end: { count: 0, mem_bytes: 0, session_ids: [] } }))
    render(<MemoryBar owner sessions={sessions} />)
    await open()
    expect(popover()).not.toBeNull()
    expect(document.querySelector('[data-end-idle]')).toBeNull()
  })

  it('has no button on a paired device', async () => {
    const m = mem('critical')
    act(() => resetResourcesForTest(frame(m)))
    vi.spyOn(api, 'systemMemory').mockResolvedValue(report(m, { apps: undefined }))
    render(<MemoryBar owner={false} sessions={sessions} />)
    await open()
    expect(document.querySelector('[data-end-idle]')).toBeNull()
    expect(document.querySelectorAll('[data-memory-app]')).toHaveLength(0)
  })

  // The owner's popover, 2026-10-22: colima at 8.2 GB under "Other apps and
  // the system" at 7.6 GB. The daemon now sends the group as what its apps
  // hold when that is more; the VM is named as one, the parts' sum past
  // what is in use is explained, and the bar never shows more than used.
  it('never lists an app bigger than its group, and says why the parts pass what is in use', async () => {
    const m = mem('tight', { used: 14 * GB, swap_used: 7.6 * GB, agents: 5.9 * GB, caprock: 0.5 * GB, other: 9.8 * GB })
    act(() => resetResourcesForTest(frame(m)))
    vi.spyOn(api, 'systemMemory').mockResolvedValue(report(m, {
      apps: [{ name: 'colima', mem_bytes: 8.2 * GB, procs: 5, vm: true }, { name: 'Google Chrome', mem_bytes: 1.1 * GB, procs: 30 }],
    }))
    render(<MemoryBar owner sessions={sessions} />)
    await open()
    const other = [...popover()!.querySelectorAll('section[aria-label="Who holds it"] .num')].map((e) => e.textContent)
    expect(other[2]).toBe('9.8 GB')
    const vm = document.querySelector('[data-memory-app="vm"]')!
    expect(vm.textContent).toContain('colima · virtual machine')
    expect(vm.getAttribute('title')).toContain('compressed or moved to swap')
    expect(document.querySelector('[data-memory-beyond]')!.textContent).toContain('more than the 14 GB in use')
    const widths = [...document.querySelectorAll<HTMLElement>('[data-memory-stack] [data-part]')].map((e) => parseFloat(e.style.width))
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo((14 / 16) * 100, 5)
  })

  it('has no such note when the parts fit in what is in use', async () => {
    const m = mem('normal')
    act(() => resetResourcesForTest(frame(m)))
    vi.spyOn(api, 'systemMemory').mockResolvedValue(report(m))
    render(<MemoryBar owner sessions={sessions} />)
    await open()
    expect(document.querySelector('[data-memory-beyond]')).toBeNull()
    expect(document.querySelector('[data-memory-app="vm"]')).toBeNull()
  })

  it('closes on Escape', async () => {
    const m = mem('tight')
    act(() => resetResourcesForTest(frame(m)))
    vi.spyOn(api, 'systemMemory').mockResolvedValue(report(m))
    render(<MemoryBar owner />)
    await open()
    expect(screen.getByText('Your Mac is running low on memory')).toBeTruthy()
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(popover()).toBeNull()
  })
})

describe('a heavy agent', () => {
  const heavy = (m: MachineMemory) => report(m, {
    agents: [
      { session_id: 'a1', pid: 11, mem_bytes: 3.4 * GB, procs: 4, owned: true, state: 'idle', idle_since: T - 60_000, endable: true, max_proc_bytes: 3.1 * GB, heavy: 'big', restartable: true },
      { session_id: 'a3', pid: 13, mem_bytes: 2 * GB, procs: 2, owned: false, state: 'idle', endable: false, max_proc_bytes: 1.9 * GB, heavy: 'growing' },
      { session_id: 'a2', pid: 12, mem_bytes: 3.3 * GB, procs: 2, owned: true, state: 'working', endable: false, max_proc_bytes: 3.2 * GB, heavy: 'big', restartable: false },
    ],
  })

  it('is flagged, with Restart it fresh only for the ones Caprock started', async () => {
    const m = mem('critical')
    act(() => resetResourcesForTest(frame(m)))
    vi.spyOn(api, 'systemMemory').mockResolvedValue(heavy(m))
    render(<MemoryBar owner sessions={[{ session_id: 'a1', name: 'big one', agent: 'claude', cwd: '/w/a' }] as unknown as SessionSummary[]} />)
    await open()
    expect(document.querySelectorAll('[data-memory-heavy]')).toHaveLength(3)
    expect(document.querySelector('[data-memory-heavy="big"]')!.textContent).toContain('3.1 GB in one process')
    expect(document.querySelector('[data-memory-heavy="growing"]')!.textContent).toContain('growing for hours')
    expect(popover()!.textContent).toContain('Long Claude Code sessions grow in memory; restarting frees it without losing the conversation.')
    // Started elsewhere: shown, no button.
    expect(document.querySelector('[data-restart-fresh="a3"]')).toBeNull()
    // Working: the button waits for its turn to end.
    expect(document.querySelector<HTMLButtonElement>('[data-restart-fresh="a2"]')!.disabled).toBe(true)
  })

  it('ends it the daemon way, then continues the conversation', async () => {
    const m = mem('critical')
    act(() => resetResourcesForTest(frame(m)))
    vi.spyOn(api, 'systemMemory').mockResolvedValue(heavy(m))
    const end = vi.spyOn(api, 'restartEnd').mockResolvedValue({ ended: true, cwd: '/w/a', agent: 'claude' })
    const spawn = vi.spyOn(api, 'spawn').mockResolvedValue({ session_id: 'a1', cwd: '/w/a' })
    const opened = vi.fn()
    render(<MemoryBar owner sessions={sessions} onOpenSession={opened} />)
    await open()
    await act(async () => { fireEvent.click(document.querySelector('[data-restart-fresh="a1"]')!) })
    expect(end).toHaveBeenCalledWith('a1')
    expect(spawn).toHaveBeenCalledWith({ cwd: '/w/a', resume: 'a1', fork: false })
    expect(opened).toHaveBeenCalledWith('a1')
    expect(document.querySelector('[data-memory-note]')!.textContent).toContain('Restarted')
  })

  it('does not continue what the daemon would not end', async () => {
    const m = mem('critical')
    act(() => resetResourcesForTest(frame(m)))
    vi.spyOn(api, 'systemMemory').mockResolvedValue(heavy(m))
    vi.spyOn(api, 'restartEnd').mockResolvedValue({ ended: false, why: 'working' })
    const spawn = vi.spyOn(api, 'spawn')
    render(<MemoryBar owner sessions={sessions} />)
    await open()
    await act(async () => { fireEvent.click(document.querySelector('[data-restart-fresh="a1"]')!) })
    expect(spawn).not.toHaveBeenCalled()
    expect(document.querySelector('[data-memory-note]')!.textContent).toContain('once its turn ends')
  })
})

describe('the inspector', () => {
  const withHeavy = (): ResourceReport => ({
    ...frame(mem('normal')),
    sessions: [{ session_id: 's1', pid: 5, cpu_pct: 1, mem_bytes: 3.5 * GB, procs: 2, warm: true, hot: false, max_proc_bytes: 3.2 * GB, heavy: 'big',
      top: [{ pid: 5, name: 'claude', cpu_pct: 1, mem_bytes: 3.2 * GB }] }],
  })

  it('flags the heavy agent and offers Restart it fresh when Caprock started it', () => {
    act(() => resetResourcesForTest(withHeavy()))
    render(<Processes sessionId="s1" session={{ session_id: 's1', owned: true, status: 'active', agent: 'codex', cwd: '/w' } as unknown as SessionSummary} />)
    expect(document.querySelector('[data-heavy="big"]')!.textContent).toContain('3.2 GB in one process')
    expect(document.querySelector('[data-heavy]')!.textContent).toContain('Long Codex sessions grow in memory')
    expect(document.querySelector('[data-restart-fresh="s1"]')).not.toBeNull()
  })

  it('only shows it for one started elsewhere', () => {
    act(() => resetResourcesForTest(withHeavy()))
    render(<Processes sessionId="s1" session={{ session_id: 's1', owned: false, status: 'active' } as unknown as SessionSummary} />)
    expect(document.querySelector('[data-heavy="big"]')).not.toBeNull()
    expect(document.querySelector('[data-restart-fresh]')).toBeNull()
  })
})

describe('the words', () => {
  it('formats used of total and the button', () => {
    expect(fmtUsedOf(9.1 * GB, 16 * GB)).toBe('9.1/16 GB')
    expect(fmtUsedOf(3.25 * GB, 7.5 * GB)).toBe('3.3/7.5 GB')
    expect(endIdleLabel(1, 512 * MB)).toBe('End 1 idle agent · frees about 512 MB')
  })
  it('says how long an agent has been idle', () => {
    const a = { session_id: 'x', pid: 1, mem_bytes: 0, procs: 1, owned: true, endable: true } as const
    expect(agentStateText({ ...a, state: 'idle', idle_since: T - 90 * 60_000 }, T)).toBe('idle 2 h')
    expect(agentStateText({ ...a, state: 'idle' }, T)).toBe('idle')
    expect(agentStateText({ ...a, state: 'waiting' }, T)).toBe('waiting on you')
  })
})
