/**
 * The phone's Releases section: the release plan at phone size, rows that
 * open their pull request on GitHub with every bar in one column, a chip for
 * the repository, and reads only on opening, on release news and on Refresh —
 * never on a timer.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { forgetDeckAnswers } from '@/lib/deckCache'
import { live } from '@/lib/live'
import { statsFixture, workFixture } from '@/lib/work.fixture'
import type { PlanRow, ReleasePlanData } from '@/lib/releaseplan'
import { pickRepo, PhoneReleases, RELEASE_REPO_KEY, releasesSummary } from './PhoneReleases'

function withKinds() {
  const w = workFixture()
  w.repos[0]!.remote = 'dspv/caprock'
  w.repos[0]!.unreleased = { ref: 'origin/master', items: ['a', 'b'], count: 2, kinds: { Added: 1, Fixed: 1 } }
  return w
}

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  forgetDeckAnswers()
})
afterEach(() => { vi.useRealTimers() })

describe('PhoneReleases', () => {
  it('draws the next version and a row per piece of work, each a link to its pull request on GitHub', async () => {
    vi.spyOn(api, 'work').mockResolvedValue(withKinds())
    const stats = vi.spyOn(api, 'sessionCIStats').mockResolvedValue(statsFixture())
    render(<PhoneReleases pull={0} />)
    expect(await screen.findByRole('heading', { name: '0.118.0' })).toBeTruthy()
    await waitFor(() => expect(document.querySelector('[data-release-row="631"]')).toBeTruthy())
    expect(stats).toHaveBeenCalledWith('s1')
    const link = document.querySelector<HTMLAnchorElement>('[data-release-row="631"] a')!
    expect(link.href).toBe('https://github.com/dspv/caprock/pull/631')
    expect(link.target).toBe('_blank')
    // A segment per step, the bar on its own line under the title.
    for (const bar of document.querySelectorAll('[data-release-phone] [data-release-bar]')) {
      expect(bar.querySelectorAll('[data-step]')).toHaveLength(4)
      expect(bar.parentElement?.previousElementSibling?.textContent).toMatch(/\S/)
    }
    // The read line follows the stats answer, which can land after the rows.
    expect(await screen.findByText(/^Pull requests from GitHub, read /)).toBeTruthy()
  })

  it('reads again on Refresh and on release news, never on a timer', async () => {
    vi.spyOn(api, 'work').mockResolvedValue(withKinds())
    const stats = vi.spyOn(api, 'sessionCIStats').mockResolvedValue(statsFixture())
    render(<PhoneReleases pull={0} />)
    await waitFor(() => expect(stats).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(stats).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(api.work).toHaveBeenCalledTimes(2))
    vi.useFakeTimers()
    // An Inbox save is not release news.
    act(() => { live.handle({ type: 'inbox', data: { id: 1, deleted: false } }) })
    await act(async () => { vi.advanceTimersByTime(120_000) })
    expect(stats).toHaveBeenCalledTimes(2)
    act(() => { live.handle({ type: 'github', data: {} } as never) })
    await act(async () => { vi.advanceTimersByTime(1_500) })
    expect(stats).toHaveBeenCalledTimes(3)
  })

  it('switches repository with the chip and remembers it', async () => {
    const w = withKinds()
    vi.spyOn(api, 'work').mockResolvedValue(w)
    const stats = vi.spyOn(api, 'sessionCIStats').mockResolvedValue(statsFixture())
    render(<PhoneReleases pull={0} />)
    const chip = await screen.findByLabelText('Repository')
    fireEvent.change(chip, { target: { value: '/w/site' } })
    await waitFor(() => expect(stats).toHaveBeenLastCalledWith('s3'))
    expect(localStorage.getItem(RELEASE_REPO_KEY)).toBe('/w/site')
  })

  it('picks the repository last chosen, else the first on GitHub', () => {
    const repos = withKinds().repos
    expect(pickRepo(repos, '/w/site')?.root).toBe('/w/site')
    expect(pickRepo(repos, '/gone')?.root).toBe('/w/caprock')
    expect(pickRepo([], '')).toBeUndefined()
  })

  // Owner, 2026-10-21: folded by default on the phone home, to one line.
  it('folds to one line, the repository and the next release, and unfolds on its header', async () => {
    vi.spyOn(api, 'work').mockResolvedValue(withKinds())
    vi.spyOn(api, 'sessionCIStats').mockResolvedValue(statsFixture())
    const onToggle = vi.fn()
    const { rerender } = render(<PhoneReleases pull={0} folded onToggle={onToggle} />)
    const head = await screen.findByRole('button', { name: 'Releases' })
    expect(head.getAttribute('aria-expanded')).toBe('false')
    const line = document.querySelector('[data-phone-releases] [data-fold-summary]')!
    await waitFor(() => expect(line.textContent).toMatch(/^caprock · .*0\.118\.0: /))
    expect(document.querySelector('[data-release-row]')).toBeNull()
    // The chip is the open section's, not the folded line's.
    expect(screen.queryByLabelText('Repository')).toBeNull()
    fireEvent.click(head)
    expect(onToggle).toHaveBeenCalledTimes(1)
    rerender(<PhoneReleases pull={0} folded={false} onToggle={onToggle} />)
    await waitFor(() => expect(document.querySelector('[data-release-row="631"]')).toBeTruthy())
    expect(screen.getByLabelText('Repository')).toBeTruthy()
  })

  it('says a pull request whose CI failed first, in red', () => {
    const row = (section: PlanRow['section'], extra: Partial<PlanRow> = {}) => ({ key: `${section}${extra.number ?? ''}`, section, red: false, ...extra }) as PlanRow
    const plan = { root: '/w/caprock', name: 'caprock', next: { version: '0.143.0', title: '' }, later: [],
      rows: [row('merged'), row('merged'), row('pr', { number: 783 }), row('pr', { number: 784, red: true })] } as ReleasePlanData
    expect(releasesSummary(plan)).toEqual([{ text: 'PR #784 CI failed', red: true }, { text: '0.143.0: 2 merged, 2 PRs' }])
    expect(releasesSummary({ ...plan, rows: [] })).toEqual([{ text: '0.143.0: nothing merged' }])
    expect(releasesSummary(undefined)).toEqual([{ text: 'Reading your releases…' }])
  })

  it('draws nothing when the daemon refuses the board', async () => {
    vi.spyOn(api, 'work').mockRejectedValue(new Error('403'))
    const { container } = render(<PhoneReleases pull={0} />)
    await waitFor(() => expect(api.work).toHaveBeenCalled())
    await waitFor(() => expect(container.querySelector('[data-phone-releases]')).toBeNull())
  })
})
