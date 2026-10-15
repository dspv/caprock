/**
 * The status bar's resource popover (owner, 2026-10-15, translated: "I want
 * a popover here that shows graphs of resource consumption").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { SessionLoad, OPEN_DELAY_MS } from './ResourceMeter'
import { api, type SessionSummary } from '@/lib/api'
import { resetResourcesForTest, type ResourceReport } from '@/lib/resources'
import { resetHistoryForTest, type ResourceHistory } from '@/lib/resourceHistory'

const MB = 2 ** 20
const T = 1_791_400_000_000

function report(): ResourceReport {
  return {
    at: T,
    sessions: [
      { session_id: 'front', pid: 10, cpu_pct: 8.1, mem_bytes: 413 * MB, procs: 2, warm: true, top: [{ pid: 10, name: 'claude', cpu_pct: 8, mem_bytes: 400 * MB }], hot: false },
      { session_id: 'busy', pid: 20, cpu_pct: 182, mem_bytes: 1200 * MB, procs: 7, warm: true, top: [{ pid: 21, name: 'node vite', cpu_pct: 150, mem_bytes: MB }], hot: true },
      { session_id: 'idle', pid: 30, cpu_pct: 0.4, mem_bytes: 90 * MB, procs: 1, warm: true, top: [], hot: false },
    ],
    caprock: {
      daemon: { pid: 1, name: 'caprock', cpu_pct: 1, mem_bytes: 200 * MB },
      hosts: { count: 3, mem_bytes: 30 * MB, cpu_pct: 0, orphans: 0, reapable: 0, list: [] },
    },
    thresholds: { cpu_pct: 100, mem_bytes: 2 ** 31, after_s: 60, interval_s: 5 },
  }
}

function history(): ResourceHistory {
  const at = [T - 10_000, T - 5_000, T]
  return {
    interval_s: 5, capacity: 720, at,
    caprock: { cpu: [1, 2, 1], mem: [230 * MB, 230 * MB, 230 * MB] },
    all: { cpu: [40, 190, 190.5], mem: [1500 * MB, 1700 * MB, 1703 * MB] },
    sessions: { front: { cpu: [30, 8, 8.1], mem: [410 * MB, 412 * MB, 413 * MB] } },
  }
}

const sessions = [
  { session_id: 'front', name: 'front work' },
  { session_id: 'busy', name: 'the build' },
  { session_id: 'idle', name: 'quiet one' },
] as unknown as SessionSummary[]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.spyOn(api, 'resourceHistory').mockResolvedValue(history())
  act(() => { resetResourcesForTest(report()); resetHistoryForTest() })
})
afterEach(() => {
  act(() => { resetResourcesForTest(); resetHistoryForTest() })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const popover = () => document.querySelector('[data-resource-popover]')

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

describe('the resource popover', () => {
  it('opens after the pointer rests on the figures, and closes once it leaves', async () => {
    render(<SessionLoad sessionId="front" sessions={sessions} />)
    const btn = document.querySelector('[data-session-load]')!
    fireEvent.mouseEnter(btn)
    expect(popover()).toBeNull()
    act(() => { vi.advanceTimersByTime(OPEN_DELAY_MS) })
    expect(popover()).not.toBeNull()
    await settle()
    expect(api.resourceHistory).toHaveBeenCalledWith(0)
    fireEvent.mouseLeave(btn)
    act(() => { vi.advanceTimersByTime(500) })
    expect(popover()).toBeNull()
  })

  it('draws the charts and the figures: now, peak and average for this agent, every session and Caprock', async () => {
    render(<SessionLoad sessionId="front" sessions={sessions} />)
    fireEvent.focus(document.querySelector('[data-session-load]')!)
    await settle()
    expect(document.querySelector('[data-resource-chart="cpu"] [data-line="front"]')!.getAttribute('d')).toMatch(/^M/)
    expect(document.querySelector('[data-resource-chart="mem"] [data-line="caprock"]')).not.toBeNull()
    const row = document.querySelector('[data-resource-block="cpu"] [data-resource-row="front"]')!
    expect(row.textContent).toContain('This agent')
    // now 8.1%, peak 30%, average (30 + 8 + 8.1) / 3 = 15.4%
    expect(row.textContent).toContain('8.1%')
    expect(row.textContent).toContain('30%')
    expect(row.textContent).toContain('15%')
    // History shorter than the window says where it starts.
    expect(document.querySelector('[data-history-note]')!.textContent).toMatch(/only while one of its windows is open/)
  })

  it('lists who uses the most now, busiest first, and a row brings that session forward', async () => {
    const open = vi.fn()
    render(<SessionLoad sessionId="front" sessions={sessions} onOpenSession={open} />)
    fireEvent.click(document.querySelector('[data-session-load]')!)
    await settle()
    const rows = [...document.querySelectorAll('[data-consumer]')]
    expect(rows.map((r) => r.getAttribute('data-consumer'))).toEqual(['busy', 'front', 'idle'])
    expect(rows[0]!.textContent).toContain('the build')
    expect(rows[1]!.textContent).toContain('in front')
    fireEvent.click(rows[0]!)
    expect(open).toHaveBeenCalledWith('busy')
    expect(popover()).toBeNull()
  })

  it('a click keeps it open when the pointer leaves; Escape closes it and gives the focus back', async () => {
    render(<SessionLoad sessionId="front" sessions={sessions} />)
    const btn = document.querySelector<HTMLButtonElement>('[data-session-load]')!
    fireEvent.click(btn)
    fireEvent.mouseLeave(btn)
    act(() => { vi.advanceTimersByTime(500) })
    expect(popover()).not.toBeNull()
    await settle()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(popover()).toBeNull()
    expect(document.activeElement).toBe(btn)
  })

  it('switches between 15 minutes and an hour', async () => {
    render(<SessionLoad sessionId="front" sessions={sessions} />)
    fireEvent.click(document.querySelector('[data-session-load]')!)
    await settle()
    const hour = screen.getByRole('button', { name: '1 hour' })
    expect(hour.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(hour)
    expect(hour.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('img', { name: /CPU over the last 1 hour/ })).toBeTruthy()
  })
})
