/**
 * The resource meter's faces read one report (lib/resources.ts). The owner
 * asked (translated): "can we measure the computer's CPU/memory load in
 * particular sessions, or Caprock's own consumption?"
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Profiler } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { CaprockItself, HotMark, Processes, SessionLoad } from './ResourceMeter'
import { fmtCPU, fmtMem, resetResourcesForTest, type ResourceReport } from '@/lib/resources'

const GB = 2 ** 30
const MB = 2 ** 20

function report(over: Partial<ResourceReport> = {}): ResourceReport {
  return {
    at: Date.now(),
    sessions: [{
      session_id: 's1', pid: 10, cpu_pct: 182.4, mem_bytes: 1.25 * GB, procs: 7, warm: true,
      top: [
        { pid: 11, name: 'node vite', cpu_pct: 150, mem_bytes: 1.1 * GB },
        { pid: 10, name: 'claude', cpu_pct: 30, mem_bytes: 120 * MB },
      ],
      hot: true, over_since: Date.now() - 3 * 60_000,
    }, {
      session_id: 's2', pid: 20, cpu_pct: 4, mem_bytes: 200 * MB, procs: 1, warm: true,
      top: [{ pid: 20, name: 'claude', cpu_pct: 4, mem_bytes: 200 * MB }], hot: false,
    }],
    caprock: {
      daemon: { pid: 1, name: 'caprock', cpu_pct: 1.5, mem_bytes: 210 * MB },
      app: { pid: 2, name: 'caprock-app', cpu_pct: 2, mem_bytes: 48 * MB },
      hosts: { count: 5, mem_bytes: 20 * MB, cpu_pct: 0, orphans: 3, reapable: 2, list: [] },
    },
    thresholds: { cpu_pct: 100, mem_bytes: 2 * GB, after_s: 60, interval_s: 5 },
    ...over,
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
  act(() => resetResourcesForTest(report()))
})
afterEach(() => {
  act(() => resetResourcesForTest())
  vi.unstubAllGlobals()
})

describe('formatting', () => {
  it('sums cores as percent and memory in binary units', () => {
    expect(fmtCPU(182.4)).toBe('182%')
    expect(fmtCPU(4.25)).toBe('4.3%')
    expect(fmtCPU(50, false)).toBe('—')
    expect(fmtMem(1.25 * GB)).toBe('1.3 GB')
    expect(fmtMem(210 * MB)).toBe('210 MB')
    expect(fmtMem(12 * GB)).toBe('12 GB')
  })
})

describe('the session faces', () => {
  it('puts the front session\'s CPU and memory on the status bar, with its busiest processes in the tooltip', () => {
    const { container } = render(<SessionLoad sessionId="s1" />)
    const el = container.querySelector('[data-session-load]')!
    expect(el.textContent).toContain('182%')
    expect(el.textContent).toContain('1.3 GB')
    expect(el.getAttribute('title')).toContain('node vite · 150% · 1.1 GB')
    // In words: the session's, and RAM — not Caprock's.
    expect(el.textContent).toMatch(/agent cpu .* ram /)
    expect(el.getAttribute('title')).toContain('not Caprock')
  })

  it('shows nothing for a session the meter has not measured', () => {
    const { container } = render(<SessionLoad sessionId="nope" />)
    expect(container.textContent).toBe('')
  })

  it('redraws a mark only when what it says changes, not on every sample', () => {
    const commits = { quiet: 0, hot: 0 }
    const count = (id: string) => () => { commits[id as 'quiet' | 'hot']++ }
    const { container } = render(
      <>
        <Profiler id="quiet" onRender={count('quiet')}><HotMark sessionId="s2" /></Profiler>
        <Profiler id="hot" onRender={count('hot')}><HotMark sessionId="s1" /></Profiler>
      </>,
    )
    const title = () => container.querySelector('[data-hot-mark]')!.getAttribute('title')
    const before = title()
    const mounted = { ...commits }
    // A new sample with the same figures: neither mark draws again.
    act(() => resetResourcesForTest(report()))
    expect(commits).toEqual(mounted)
    expect(title()).toBe(before)
    // The hot one's figures moved: it, and only it, draws again.
    const busier = report()
    busier.sessions[0] = { ...busier.sessions[0]!, cpu_pct: 250 }
    act(() => resetResourcesForTest(busier))
    expect(commits.quiet).toBe(mounted.quiet)
    expect(commits.hot).toBe(mounted.hot + 1)
    expect(title()).toMatch(/250% CPU/)
  })

  it('marks a hot session and says why, and leaves a quiet one unmarked', () => {
    const { container: hot } = render(<HotMark sessionId="s1" />)
    const mark = hot.querySelector('[data-hot-mark]')!
    expect(mark.getAttribute('title')).toMatch(/^Hot: its processes have used 182% CPU for 3 min — mostly node vite$/)
    const { container: calm } = render(<HotMark sessionId="s2" />)
    expect(calm.querySelector('[data-hot-mark]')).toBeNull()
  })

  it('lists the busiest processes in the inspector', () => {
    render(<Processes sessionId="s1" />)
    expect(screen.getByText('node vite')).toBeInTheDocument()
    expect(screen.getByText('Processes · 7')).toBeInTheDocument()
    expect(screen.getByText('Hot for 3 min')).toBeInTheDocument()
  })
})

describe('Caprock itself', () => {
  it('adds up the daemon, the app and the holders, and offers to stop the reapable orphans', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/v1/resources/reap')) {
        return Promise.resolve(new Response(JSON.stringify({ reaped: [{ pid: 7, state: 'dead', reap: true }, { pid: 8, state: 'unreachable-idle', reap: true }], kept: [{ pid: 9, state: 'unreachable-busy', reap: false }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      return new Promise(() => {})
    })
    vi.stubGlobal('fetch', fetchMock)
    const { container } = render(<CaprockItself owner />)
    const text = container.querySelector('[data-caprock-itself]')!.textContent!
    expect(text).toContain('278 MB') // 210 + 48 + 20
    expect(text).toContain('3 orphans')
    expect(text).toContain('1 of them runs an agent or a command')
    fireEvent.click(screen.getByRole('button', { name: 'Stop 2 orphans' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Stopped 2 · 1 left running: something still runs in them.')
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/v1/resources/reap'), expect.objectContaining({ method: 'POST' }))
  })

  it('never offers the button on a paired device', () => {
    render(<CaprockItself owner={false} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
