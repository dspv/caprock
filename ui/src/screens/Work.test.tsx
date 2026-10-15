import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NOW, statsFixture, workFixture } from '@/lib/work.fixture'

const h = vi.hoisted(() => ({ work: 0, stats: [] as string[], fail: false }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    work: async () => { h.work++; if (h.fail) throw new Error('refused'); return workFixture() },
    sessionCIStats: async (id: string) => { h.stats.push(id); return id === 's1' ? statsFixture() : { connected: true, prs: [] } },
  } }
})

import { WorkScreen, WorkView } from './Work'
import { ScreenShown } from '@/lib/refresh'
import { live } from '@/lib/live'
import { forgetDeckAnswers } from '@/lib/deckCache'
import { WORK_READ_MS } from '@/lib/useWork'

afterEach(() => { h.work = 0; h.stats = []; h.fail = false; forgetDeckAnswers(); localStorage.clear(); vi.useRealTimers() })

const stats = () => new Map([['/w/caprock', statsFixture()]])

describe('the Work page', () => {
  it('says the headline, today’s spend at list price, and the groups in order', () => {
    render(<WorkView work={workFixture()} stats={stats()} now={NOW} passed={0} />)
    expect(screen.getByText(/4 agents live/).closest('[data-work-headline]')).toHaveTextContent('4 agents live · 1 building · 2 on open PRs · 1 needs you')
    expect(screen.getByText(/today on live work/)).toHaveAttribute('title', expect.stringContaining('not a bill'))
    const lanes = [...document.querySelectorAll('[data-work-lane]')].map((e) => e.getAttribute('data-work-lane'))
    expect(lanes).toEqual(['list-release', 'list-review', 'list-work', 'list-planned', 'list-released'])
    // Released is folded until opened.
    const released = document.querySelector('[data-work-lane="list-released"]')!
    expect(released.querySelector('[data-work-row]')).toBeNull()
    fireEvent.click(within(released as HTMLElement).getByRole('button', { name: /Released/ }))
    expect(released.querySelector('[data-work-row]')).not.toBeNull()
  })

  it('draws a row’s stage, who works on it, its estimates with their basis, and its cost', () => {
    render(<WorkView work={workFixture()} stats={stats()} now={NOW} passed={0} />)
    const r = document.querySelector('[data-work-row$="feat/folder-search"]') as HTMLElement
    expect(r.querySelector('[data-work-bar]')).toHaveAttribute('data-work-bar', '3')
    expect(r.querySelector('[data-work-word]')).toHaveTextContent('CI running')
    expect(r).toHaveTextContent('Claude Code Opus 4.1')
    expect(r).toHaveTextContent('started by Caprock')
    expect(within(r).getByText('turn 1–4 min left (rough)').closest('[data-work-note]')).toHaveAttribute('title', expect.stringContaining('last 12 turns'))
    expect(r).toHaveTextContent('3 of 7 steps')
    expect(r).toHaveTextContent('CI running 6m · usually 11m')
    expect(within(r).getByText('$5.10')).toHaveAttribute('title', expect.stringContaining('API list price, not a bill'))
    // The pull request opens in the Pipeline.
    expect(within(r).getByText('folder search').closest('a')).toHaveAttribute('href', expect.stringContaining('#/pipeline?repo=%2Fw%2Fcaprock&pr=631'))
    // A session from the person's own terminal says so.
    expect(document.querySelector('[data-work-row="s:s2"]')).toHaveTextContent('your terminal')
  })

  it('opens a session through the app when it can, and a task in Tasks', () => {
    const open = vi.fn()
    render(<WorkView work={workFixture()} stats={stats()} now={NOW} passed={0} onOpenSession={open} />)
    fireEvent.click(within(document.querySelector('[data-work-row="s:s2"]') as HTMLElement).getByRole('button', { name: 'Pipeline in Dashboard' }))
    expect(open).toHaveBeenCalledWith('s2')
    expect(within(document.querySelector('[data-work-row="t:t1"]') as HTMLElement).getByText('Work: list screen').closest('a')).toHaveAttribute('href', '#/tasks')
  })

  it('folds sessions idle over 30 minutes into one line', () => {
    render(<WorkView work={workFixture()} stats={stats()} now={NOW} passed={0} />)
    const idle = document.querySelector('[data-work-idle]') as HTMLElement
    expect(idle).toHaveTextContent('1 idle')
    expect(document.querySelector('[data-work-row="s:s3"]')).toBeNull()
  })

  it('shows the same cards as Kanban columns, and remembers the view', () => {
    const { unmount } = render(<WorkView work={workFixture()} stats={stats()} now={NOW} passed={0} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Kanban' }))
    const cols = [...document.querySelectorAll('[data-work-column]')].map((e) => e.getAttribute('data-work-column'))
    expect(cols).toEqual(['planned', 'work', 'review', 'merged', 'released'])
    expect(document.querySelector('[data-work-column="merged"]')!.querySelectorAll('[data-work-card]')).toHaveLength(2)
    unmount()
    render(<WorkView work={workFixture()} stats={stats()} now={NOW} passed={0} />)
    expect(screen.getByRole('tab', { name: 'Kanban' })).toHaveAttribute('aria-selected', 'true')
  })

  it('says the next release’s cadence, what is merged and the CHANGELOG as of the last fetch', () => {
    render(<WorkView work={workFixture()} stats={stats()} now={NOW} passed={0} />)
    const strip = document.querySelector('[data-work-release-repo="caprock"]') as HTMLElement
    expect(strip.querySelector('[data-work-cadence]')).toHaveTextContent('2h 05m since v0.117.4 · usual gap 2h 40m (median of 9)')
    expect(strip).toHaveTextContent('#630')
    expect(strip.querySelector('[data-work-unreleased]')).toHaveTextContent('as of your last fetch')
    expect(strip).toHaveTextContent('and 2 more')
    // A repository not on GitHub says so plainly.
    expect(document.querySelector('[data-work-repo-notes]')).toHaveTextContent('site: Not on GitHub')
  })

  it('says plainly when there is nothing in work', () => {
    const w = workFixture()
    w.sessions = []; w.tasks = []; w.queued = []; w.repos = []
    w.totals = { live: 0, working: 0, waiting_you: 0, today_usd: 0, machine_today_usd: 0 }
    render(<WorkView work={w} stats={new Map()} now={NOW} passed={0} />)
    expect(screen.getByText('Nothing in work')).toBeInTheDocument()
  })
})

describe('the Work page’s reads', () => {
  it('asks nothing while it is hidden, once when shown, and the Pipeline answer through the repository’s session', async () => {
    const { rerender } = render(<ScreenShown.Provider value={false}><WorkScreen /></ScreenShown.Provider>)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.work).toBe(0)
    rerender(<ScreenShown.Provider value={true}><WorkScreen /></ScreenShown.Provider>)
    await waitFor(() => expect(document.querySelector('[data-work-screen]')).not.toBeNull())
    expect(h.work).toBe(1)
    await waitFor(() => expect(h.stats.sort()).toEqual(['s1', 's3']))
  })

  it('reads again on live frames, at most once a second, never while hidden', async () => {
    render(<WorkScreen />)
    await waitFor(() => expect(h.work).toBe(1))
    vi.useFakeTimers()
    act(() => {
      for (let i = 0; i < 5; i++) live.handle({ type: 'queue', data: { session_id: 's1', messages: [], waiting: '' } })
    })
    await act(async () => { vi.advanceTimersByTime(WORK_READ_MS) })
    vi.useRealTimers()
    await waitFor(() => expect(h.work).toBe(2))
  })

  it('says it when the daemon cannot be reached', async () => {
    h.fail = true
    render(<WorkScreen />)
    expect(await screen.findByText('Cannot reach the daemon')).toBeInTheDocument()
  })
})
