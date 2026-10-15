import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NOW, statsFixture, workFixture } from '@/lib/work.fixture'
import type { Work } from '@/lib/api'

const h = vi.hoisted(() => ({ work: 0, data: undefined as Work | undefined }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    work: async () => { h.work++; return h.data! },
  } }
})

import { CockpitRelease, ReleasePlan } from './ReleasePlan'
import { WorkView } from '@/screens/Work'
import { forgetDeckAnswers, writeDeck } from '@/lib/deckCache'
import { planForRepo, type ReleasePlanData } from '@/lib/releaseplan'
import { live } from '@/lib/live'

afterEach(() => { h.work = 0; h.data = undefined; forgetDeckAnswers(); localStorage.clear() })

function withKinds(): Work {
  const w = workFixture()
  w.repos[0]!.unreleased = { ref: 'origin/master', items: ['a', 'b'], count: 2, kinds: { Added: 1, Fixed: 1 } }
  return w
}

const plan = (): ReleasePlanData => {
  const stats = statsFixture()
  stats.prs!.find((p) => p.number === 631)!.labels = [{ name: 'landing: CI red' }]
  return planForRepo(withKinds(), '/w/caprock', stats, NOW)
}

describe('the release plan', () => {
  it('heads with the next version, its rule on hover, then rows with ten blocks and the stage word', () => {
    render(<ReleasePlan plan={plan()} />)
    const v = screen.getByRole('heading', { name: '0.118.0' })
    expect(v.title).toMatch(/^Next version, by the pending changes: a feature \(an Added entry\) makes a minor release/)
    expect(document.querySelector('[data-release-since]')).toHaveTextContent('1 merged since v0.117.4 · 2h 05m ago · usual gap 2h 40m (median of 9)')
    const rows = [...document.querySelectorAll<HTMLElement>('[data-release-row]')]
    expect(rows.map((r) => r.getAttribute('data-release-row'))).toEqual(['630', '631', '633', expect.stringMatching(/^s:/)])
    for (const r of rows) expect(r.querySelectorAll('[data-block]')).toHaveLength(10)
    const merged = rows[0]!
    expect(merged.querySelectorAll('[data-block="on"]')).toHaveLength(8)
    expect(within(merged).getByText('merged')).toBeInTheDocument()
    // The landing label is the word, and its step is red.
    const red = rows[1]!
    expect(red.querySelector('[data-release-word]')).toHaveTextContent('landing: CI red')
    expect(red.querySelectorAll('[data-block="red"]')).toHaveLength(2)
    expect(rows[3]!.querySelector('[data-release-word]')).toHaveTextContent('agent')
    expect(rows[3]!.querySelectorAll('[data-block="on"]')).toHaveLength(2)
    // A pull request row goes to its detail on the Pipeline.
    expect(within(merged).getByRole('link')).toHaveAttribute('href', expect.stringContaining('pipeline'))
  })

  it('opens a row in place when the page asks to', () => {
    const onOpen = vi.fn()
    render(<ReleasePlan plan={plan()} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: /#630/ }))
    expect(onOpen).toHaveBeenCalledWith(630)
  })

  it('says Next release without a number when the entries say no kind', () => {
    render(<ReleasePlan plan={planForRepo(workFixture(), '/w/caprock', statsFixture(), NOW)} />)
    expect(screen.getByRole('heading', { name: 'Next release' }).title).toMatch(/No number/)
  })
})

describe('where it is drawn', () => {
  it('is the Work page’s third view, Release, beside List and Kanban, remembered', () => {
    render(<WorkView work={withKinds()} stats={new Map([['/w/caprock', statsFixture()]])} now={NOW} passed={0} />)
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['List', 'Kanban', 'Release'])
    fireEvent.click(screen.getByRole('tab', { name: 'Release' }))
    expect(localStorage.getItem('caprock.work.view')).toBe('release')
    const plans = [...document.querySelectorAll('[data-release-plan]')].map((e) => e.getAttribute('data-release-plan'))
    expect(plans).toEqual(['caprock', 'site'])
    expect(screen.getByRole('heading', { name: '0.118.0' })).toBeInTheDocument()
    // The strip the other views carry is the plan's heading here.
    expect(document.querySelector('[data-work-next-release]')).toBeNull()
  })

  it('is the right panel’s Release section: the kept Pipeline answer and one Work read, again on GitHub news only', async () => {
    h.data = withKinds()
    writeDeck('stats:/w/caprock', statsFixture())
    render(<CockpitRelease sessionId="s1" repoRoot="/w/caprock" />)
    const region = await screen.findByRole('region', { name: 'Release' })
    expect(await within(region).findByRole('heading', { name: '0.118.0' })).toBeInTheDocument()
    expect(region.querySelectorAll('[data-release-row]').length).toBeGreaterThan(0)
    expect(h.work).toBe(1)
    vi.useFakeTimers()
    try {
      // A turn of the agent beside it reads nothing again; GitHub news does.
      act(() => { live.handle({ type: 'session', data: {} } as never) })
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      expect(h.work).toBe(1)
      act(() => { live.handle({ type: 'github', data: {} } as never) })
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      expect(h.work).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('draws nothing in the right panel for a session outside a repository', () => {
    const { container } = render(<CockpitRelease sessionId="s1" />)
    expect(container).toBeEmptyDOMElement()
    expect(h.work).toBe(0)
  })
})
