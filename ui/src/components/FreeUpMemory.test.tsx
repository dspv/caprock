/**
 * Free up memory (owner, 2026-10-25): one button for what can be freed and
 * is safe to, the same component in Caprock resources and in the memory
 * popover, with a confirmation in two groups whose total follows the ticks.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { api, type SessionSummary } from '@/lib/api'
import type { Footprint, Orphan } from '@/lib/footprint'
import type { MachineMemory, MemoryAgent, MemoryReport } from '@/lib/memory'
import { confirmLabel, freeUpLabel, freeUpPlan, heldLine, resultNote } from '@/lib/freeup'
import { resetResourcesForTest } from '@/lib/resources'
import { FreeUpMemory, SETTLE_MS } from './FreeUpMemory'
import { MemoryPopover } from './MemoryBar'
import { FootprintPanel } from './FootprintPanel'

const GB = 2 ** 30
const MB = 2 ** 20
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const doctor = (): Footprint => JSON.parse(readFileSync(join(repo, 'testdata', 'footprint', 'doctor.json'), 'utf8')) as Footprint

const machine: MachineMemory = { label: 'Mac', total: 16 * GB, used: 14 * GB, level: 'tight', agents: 5 * GB, agent_count: 4, caprock: GB, other: 8 * GB }

function agent(id: string, over: Partial<MemoryAgent> = {}): MemoryAgent {
  return { session_id: id, pid: 100, mem_bytes: 500 * MB, procs: 2, owned: true, state: 'idle', idle_since: 0, endable: true, ...over }
}

function memReport(f: Footprint): MemoryReport {
  return {
    at: f.at, memory: machine,
    agents: [
      agent('s1', { mem_bytes: GB, idle_since: f.at - 3 * 3_600_000 }),
      agent('s2', { mem_bytes: 512 * MB, idle_since: f.at - 40 * 60_000 }),
      agent('s3', { endable: false, idle_since: f.at - 5 * 60_000, why_not: 'idle under 15 min' }),
      agent('s4', { endable: false, state: 'working', why_not: 'working' }),
      agent('s5', { owned: false, endable: false }),
    ],
    idle_end: { count: 2, mem_bytes: 1.5 * GB, session_ids: ['s1', 's2'] },
  }
}

const sessions = [{ session_id: 's1', name: 'docs pass' }, { session_id: 's2', name: 'fix the login' }, { session_id: 's3', name: 'pricing page' }] as unknown as SessionSummary[]

beforeEach(() => { act(() => resetResourcesForTest()) })
afterEach(() => {
  act(() => resetResourcesForTest())
  vi.restoreAllMocks()
})

describe('the plan', () => {
  it('groups the safe leftovers and the endable agents, and totals them', () => {
    const f = doctor()
    const plan = freeUpPlan(f, memReport(f), sessions)
    // The terminal something still runs in is not safe: it stays on its row.
    expect(plan.leftovers.map((x) => x.key)).toEqual(['o:48120', 'o:48160', 'o:48133'])
    expect(plan.agents.map((x) => [x.key, x.name])).toEqual([['a:s1', 'docs pass'], ['a:s2', 'fix the login']])
    // Kept: the idle one Caprock started, with why; not the working one, not one started elsewhere.
    expect(plan.kept).toEqual([{ session_id: 's3', name: 'pricing page', why: 'idle 5 min: offered after 15 min' }])
    const leftBytes = plan.leftovers.reduce((s, x) => s + x.mem_bytes, 0)
    expect(plan.mem_bytes).toBe(leftBytes + 1.5 * GB)
  })

  it('never offers what the daemon holds', () => {
    const f = doctor()
    const held: Orphan = { pid: 51000, started_at: f.at - 1, kind: 'caprock_daemon', label: 'caprock up', data_dir: '/private/tmp/x/scratchpad/prev', mem_bytes: 300 * MB, why: '', hold: 'its agent is still running' }
    f.orphans!.list = [held, ...f.orphans!.list!]
    const plan = freeUpPlan(f, undefined)
    expect(plan.leftovers.some((x) => x.key === 'o:51000')).toBe(false)
    expect(plan.held).toEqual([held])
    expect(heldLine(plan.held)).toBe('1 test copy of Caprock kept: its agent is still running.')
  })

  it('offers nothing from a footprint without the scan', () => {
    const f = doctor()
    f.orphans = { ...f.orphans!, scanned: false, list: [] }
    expect(freeUpPlan(f, undefined).leftovers).toEqual([])
  })

  it('says what it frees, and what was done', () => {
    expect(freeUpLabel(0)).toBe('Free up memory')
    expect(freeUpLabel(2.4 * GB)).toBe('Free up memory · ~2.4 GB')
    expect(confirmLabel(0, 0)).toBe('Free up')
    expect(confirmLabel(4, 2.1 * GB)).toBe('Free up 4 · ~2.1 GB')
    const f = doctor()
    const plan = freeUpPlan(f, memReport(f), sessions)
    const picked = [...plan.leftovers.slice(0, 1), ...plan.agents]
    const note = resultNote(picked,
      { stopped: [plan.leftovers[0]!.orphan!], running: [], failed: [] },
      { ended: ['s1'], skipped: [{ session_id: 's2', why: 'running in the background: npm' }] })
    expect(note).toBe(`Freed about ${(1 + (plan.leftovers[0]!.mem_bytes / GB)).toFixed(1)} GB: stopped 1 leftover and ended 1 idle agent. 1 was left alone: still running npm in the background.`)
  })
})

describe('the confirmation', () => {
  async function shown() {
    const f = doctor()
    vi.spyOn(api, 'footprint').mockResolvedValue(f)
    const r = render(<FreeUpMemory memory={memReport(f)} sessions={sessions} />)
    const btn = await waitFor(() => {
      const b = r.container.querySelector<HTMLButtonElement>('[data-free-up]')
      if (!b) throw new Error('not yet')
      return b
    })
    return { ...r, btn, f }
  }

  it('opens inline in two groups, everything offered ticked, and the totals follow the ticks', async () => {
    const { container, btn } = await shown()
    fireEvent.click(btn)
    const groups = [...container.querySelectorAll('[data-free-up-group]')].map((g) => g.getAttribute('data-free-up-group'))
    expect(groups).toEqual(['leftovers', 'agents'])
    const yes = () => container.querySelector('[data-free-up-yes]')!.textContent
    expect(yes()).toMatch(/^Free up 5 · ~/)
    const agents = () => container.querySelector('[data-free-up-group="agents"] [data-free-up-group-total]')!.textContent
    expect(agents()).toBe('1.5 GB')
    fireEvent.click(container.querySelector('[data-free-up-pick="a:s1"]')!)
    expect(agents()).toBe('512 MB')
    expect(container.querySelector('[data-free-up-group="agents"]')!.textContent).toContain('1 of 2')
    expect(yes()).toMatch(/^Free up 4 · ~/)
    // Untick everything: nothing to send.
    for (const k of ['a:s2', 'o:48120', 'o:48160', 'o:48133']) fireEvent.click(container.querySelector(`[data-free-up-pick="${k}"]`)!)
    expect(container.querySelector<HTMLButtonElement>('[data-free-up-yes]')!.disabled).toBe(true)
  })

  it('keeps each line on one line: a long name truncates, the state and the size stay right-aligned', async () => {
    // Owner, 2026-11-20: "Ops job telegram: … · idle 22 min" wrapped, "idle 22 min" on a line of its own.
    const long = 'Ops job telegram: Bad Gateway 502 from the relay, retried every minute since the morning'
    const named = sessions.map((s) => (s.session_id === 's2' ? { ...s, name: long } : s))
    const f = doctor()
    vi.spyOn(api, 'footprint').mockResolvedValue(f)
    const r = render(<FreeUpMemory memory={memReport(f)} sessions={named} />)
    fireEvent.click(await waitFor(() => r.container.querySelector<HTMLButtonElement>('[data-free-up]') ?? Promise.reject(new Error('not yet'))))
    const line = r.container.querySelector('[data-free-up-pick="a:s2"]')!.closest('[data-free-up-line]')!
    expect(line.className).toContain('flex')
    expect(line.className).not.toContain('flex-wrap')
    expect(line.getAttribute('title')).toBe(`${long} · idle 40 min`)
    const name = line.querySelector('[data-free-up-name]')!
    expect(name.textContent).toBe(long)
    expect(name.className.split(' ')).toEqual(expect.arrayContaining(['truncate', 'min-w-0', 'flex-1']))
    // The state and the size are siblings of the name on the same flex line, never squeezed.
    const detail = line.querySelector('[data-free-up-detail]')!
    const size = line.querySelector('[data-free-up-size]')!
    expect(detail.textContent).toBe('idle 40 min')
    expect([...line.children].map((c) => c.getAttribute('data-free-up-name') !== null ? 'name' : c.getAttribute('data-free-up-detail') !== null ? 'detail' : c.getAttribute('data-free-up-size') !== null ? 'size' : 'pick'))
      .toEqual(['pick', 'name', 'detail', 'size'])
    for (const el of [detail, size]) expect(el.className.split(' ')).toEqual(expect.arrayContaining(['shrink-0', 'text-right']))
  })

  it('sends the ticked leftovers with skip_held and the ticked agents with the tab in front', async () => {
    const f = doctor()
    vi.spyOn(api, 'footprint').mockResolvedValue(f)
    const stop = vi.spyOn(api, 'stopOrphans').mockResolvedValue({ stopped: [], running: [], failed: [] })
    const end = vi.spyOn(api, 'endIdleAgents').mockResolvedValue({ ended: [] })
    const r = render(<FreeUpMemory memory={memReport(f)} front="s9" sessions={sessions} />)
    fireEvent.click(await waitFor(() => r.container.querySelector<HTMLButtonElement>('[data-free-up]') ?? Promise.reject(new Error('not yet'))))
    fireEvent.click(r.container.querySelector('[data-free-up-pick="o:48160"]')!)
    await act(async () => { fireEvent.click(r.container.querySelector('[data-free-up-yes]')!) })
    expect(stop).toHaveBeenCalledWith([{ pid: 48120, started_at: expect.any(Number) }, { pid: 48133, started_at: expect.any(Number) }], false, true)
    expect(end).toHaveBeenCalledWith(['s1', 's2'], 's9')
  })

  it('takes what it freed out of the offer at once, and reads the figures again when the processes have gone', async () => {
    // Owner, 2026-11-22: the button still offered the agent it had just ended,
    // because the list read right after still had its process.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const f = doctor()
      f.orphans = { ...f.orphans!, list: [] }
      vi.spyOn(api, 'footprint').mockResolvedValue(f)
      vi.spyOn(api, 'endIdleAgents').mockResolvedValue({ ended: ['s1'] })
      const done = vi.fn()
      const r = render(<FreeUpMemory memory={memReport(f)} sessions={sessions} onDone={done} />)
      fireEvent.click(await waitFor(() => r.container.querySelector<HTMLButtonElement>('[data-free-up]') ?? Promise.reject(new Error('not yet'))))
      fireEvent.click(r.container.querySelector('[data-free-up-pick="a:s2"]')!)
      await act(async () => { fireEvent.click(r.container.querySelector('[data-free-up-yes]')!) })
      // The screen's list still names s1; the offer no longer does.
      expect(r.container.querySelector('[data-free-up]')!.textContent).toBe('Free up memory · ~512 MB')
      expect(r.container.querySelector('[data-free-up-settling]')!.textContent).toBe('Updating the figures…')
      expect(done).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(SETTLE_MS) })
      expect(done).toHaveBeenCalledTimes(2)
      expect(r.container.querySelector('[data-free-up-settling]')).toBeNull()
      expect(r.container.querySelector('[data-free-up-note]')!.textContent).toBe('Freed about 1.0 GB: ended 1 idle agent.')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('both entry points', () => {
  it('show the same component with the same list', async () => {
    const f = doctor()
    const mem = memReport(f)
    vi.spyOn(api, 'footprint').mockResolvedValue(f)
    vi.spyOn(api, 'systemMemory').mockResolvedValue(mem)
    const confirmOf = async (c: HTMLElement) => {
      const b = await waitFor(() => c.querySelector<HTMLButtonElement>('[data-free-up]') ?? Promise.reject(new Error('not yet')))
      fireEvent.click(b)
      return c.querySelector('[data-free-up-confirm]')!
    }
    const a = render(<MemoryPopover m={machine} owner sessions={sessions} onClose={() => {}} />)
    const fromMemory = await confirmOf(a.container)
    const b = render(<FootprintPanel f={f} owner sessions={sessions} />)
    const fromResources = await confirmOf(b.container)
    expect(fromMemory.innerHTML).toBe(fromResources.innerHTML)
    expect(fromMemory.querySelectorAll('[data-free-up-pick]')).toHaveLength(5)
  })
})
