import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CockpitCI, checkSummary } from './CockpitCI'
import { forgetDeckAnswers, writeDeck } from '@/lib/deckCache'

const now = Date.now()
const live = (n: number, checks: object, p: object = {}) => ({ number: n, url: `https://github.com/a/b/pull/${n}`, title: `PR ${n}`, state: 'open', draft: false,
  review: '', reviews: [], branch: `feat/${n}`, base: 'main', mergeable: null, checks, ...p })
const row = (n: number, l: object) => ({ session_id: 's1', number: n, url: `https://github.com/a/b/pull/${n}`, title: `PR ${n}`, last_at: now, live: l })
const RUNNING = { state: 'pending', passed: 2, failed: 0, pending: 1, items: [
  { name: 'lint', state: 'pass', started_at: now - 240_000, completed_at: now - 200_000 },
  { name: 'go (ubuntu-latest)', state: 'pass', started_at: now - 240_000, completed_at: now - 60_000 },
  { name: 'go (windows-latest)', state: 'pending', status: 'in_progress', started_at: now - 240_000 },
] }
const PASSED = { state: 'pass', passed: 1, failed: 0, pending: 0, items: [{ name: 'lint', state: 'pass' }] }

afterEach(() => { forgetDeckAnswers(); localStorage.clear(); vi.unstubAllGlobals() })

describe('the cockpit’s CI block', () => {
  it('counts a PR’s checks and the time since the first started', () => {
    expect(checkSummary(RUNNING.items as never, now)).toMatchObject({ total: 3, pass: 2, running: 1, ms: 240_000 })
  })

  it('draws only what the deck was told, asks nothing, and redraws when the deck is told more', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { container } = render(<CockpitCI sessionId="s1" />)
    expect(container).toBeEmptyDOMElement()
    act(() => { writeDeck('prs:s1', { connected: true, prs: [row(9, live(9, RUNNING)), row(8, live(8, PASSED, { state: 'merged' }))] }) })
    expect(document.querySelector('[data-cockpit-ci="dots"]')).not.toBeNull()
    expect(document.querySelector('[data-cockpit-ci-pr="9"] [data-tone="running"]')).not.toBeNull()
    expect(document.querySelector('[data-cockpit-ci-pr="8"]')).not.toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('switches between circles, a ring and the jobs by OS, kept per viewer, and opens the tab on a click', () => {
    writeDeck('prs:s1', { connected: true, prs: [row(9, live(9, RUNNING))] })
    const onOpen = vi.fn()
    const first = render(<CockpitCI sessionId="s1" onOpen={onOpen} />)
    fireEvent.click(document.querySelector('[data-cockpit-ci-view="ring"]')!)
    expect(document.querySelector('[data-cockpit-ci-ring]')).toHaveTextContent('2/3 · 4m 00s')
    expect(document.querySelector('[data-cockpit-ci-ring]')).toHaveTextContent('1 running')
    fireEvent.click(document.querySelector('[data-cockpit-ci-open]')!)
    expect(onOpen).toHaveBeenCalledTimes(1)
    fireEvent.click(document.querySelector('[data-cockpit-ci-view="grid"]')!)
    // No CI of #9 kept yet: it says where its jobs come from.
    expect(screen.getByText(/#9’s jobs show once its row is opened in the deck/)).toBeInTheDocument()
    first.unmount()
    act(() => {
      writeDeck('ci:s1:9', { connected: true, pr: { number: 9, url: '', repo: 'a/b' }, ci: { repo: 'a/b', head_sha: 's', state: 'running', runner_ms: 0, by_os: [], at: now, runs: [{ id: 1, name: 'ci', status: 'in_progress', jobs: [
        { id: 1, run_id: 1, name: 'go (ubuntu-latest)', os: 'linux', labels: [], status: 'completed', conclusion: 'success', steps: [] },
        { id: 2, run_id: 1, name: 'go (windows-latest)', os: 'windows', labels: [], status: 'in_progress', steps: [] },
      ] }] } })
    })
    render(<CockpitCI sessionId="s1" onOpen={onOpen} />)
    expect(document.querySelector('[data-cockpit-ci="grid"]')).not.toBeNull()
    const grid = document.querySelector('[data-cockpit-ci-grid]')!
    expect(grid).toHaveTextContent('Linux')
    expect(grid).toHaveTextContent('Windows')
    expect(grid.querySelector('[data-tone="running"]')).not.toBeNull()
  })
})
