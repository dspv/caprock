/**
 * A failure on the way to GitHub is said in a few words with the age of what
 * is shown, and GitHub's status page (through the daemon) says whose fault
 * it is; the status-bar dot is opt-in and shows only during an incident.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Freshness } from './Freshness'
import { GitHubStatusDot } from './GitHubOutage'
import { ApiError } from '@/lib/api'
import { githubApi } from '@/lib/github'
import { isReachFailure, outageText, setWatching, type StatusPage } from '@/lib/githubOutage'
import * as nudges from '@/lib/nudges'

const REASON = 'Reading the pull requests: could not reach GitHub (api.github.com): context deadline exceeded. Check the connection; Caprock tries again later.'
const OK: StatusPage = { indicator: 'none', description: 'All Systems Operational', components: [{ name: 'Actions', status: 'operational' }], incidents: [], at: 1 }
const DOWN: StatusPage = {
  indicator: 'minor', description: 'Partially Degraded Service',
  components: [{ name: 'API Requests', status: 'partial_outage' }],
  incidents: [{ name: 'Elevated API error rates', status: 'investigating', url: 'https://stspg.io/abc' }], at: 1,
}

beforeEach(() => { vi.restoreAllMocks(); setWatching(false) })
afterEach(() => { setWatching(false) })

describe('isReachFailure', () => {
  it('is the network and GitHub’s 5xx, not a refused token or a limit', () => {
    expect(isReachFailure(REASON)).toBe(true)
    expect(isReachFailure('GitHub had a problem (503); try again in a minute.')).toBe(true)
    expect(isReachFailure('GitHub answered 502')).toBe(true)
    expect(isReachFailure('dial tcp: i/o timeout')).toBe(true)
    expect(isReachFailure('GitHub refused the token (401). Connect again in Settings → GitHub.')).toBe(false)
    expect(isReachFailure('GitHub refused (403: API rate limit exceeded).')).toBe(false)
    expect(isReachFailure(undefined)).toBe(false)
  })
})

describe('outageText', () => {
  it('names the outage and links the incident, or says it is likely the connection', () => {
    expect(outageText(DOWN)).toEqual({ kind: 'outage', text: 'GitHub reports: Partial outage — Elevated API error rates', url: 'https://stspg.io/abc' })
    expect(outageText(OK)).toMatchObject({ kind: 'clear', text: 'GitHub reports all systems operational — likely your connection.' })
    expect(outageText({ ...OK, indicator: '', error: 'could not reach githubstatus.com' }).kind).toBe('unknown')
  })
})

describe('Freshness on a GitHub failure', () => {
  const at = Date.now() - 6 * 60_000

  it('says it could not reach GitHub, how old the data is, and what GitHub Status reports', async () => {
    let answer!: (s: StatusPage) => void
    const ask = vi.spyOn(githubApi, 'statusPage').mockReturnValue(new Promise((r) => { answer = r }))
    const open = vi.spyOn(nudges, 'openExternal').mockImplementation(() => {})
    const retry = vi.fn()
    render(<Freshness github at={at} loading={false} failed reason={REASON} onRetry={retry} />)
    const line = document.querySelector('[data-deck-fresh="failed"]')!
    expect(line).toHaveTextContent('Couldn’t reach GitHub. Showing data from 6 min ago.')
    expect(line).not.toHaveTextContent('deadline exceeded')
    expect(line.getAttribute('title')).toContain('context deadline exceeded')
    expect(line.getAttribute('title')).toContain('Showing what was read at')
    expect(screen.getByText('Checking GitHub Status…')).toBeInTheDocument()
    expect(ask).toHaveBeenCalledTimes(1)
    await act(async () => { answer(DOWN) })
    expect(line).toHaveTextContent('GitHub reports: Partial outage — Elevated API error rates')
    fireEvent.click(screen.getByText('Open githubstatus.com ↗'))
    expect(open).toHaveBeenCalledWith('https://stspg.io/abc')
    fireEvent.click(screen.getByText('Retry'))
    expect(retry).toHaveBeenCalled()
  })

  it('says it is likely the connection when GitHub reports nothing wrong', async () => {
    vi.spyOn(githubApi, 'statusPage').mockResolvedValue(OK)
    render(<Freshness github at={at} loading={false} failed reason={REASON} />)
    expect(await screen.findByText('GitHub reports all systems operational — likely your connection.')).toBeInTheDocument()
  })

  it('asks nothing for a failure that is not on the way to GitHub, or a caller that is not GitHub’s', async () => {
    const ask = vi.spyOn(githubApi, 'statusPage').mockResolvedValue(OK)
    const { unmount } = render(<Freshness github at={at} loading={false} failed reason="GitHub refused the token (401)." />)
    expect(document.querySelector('[data-deck-fresh="failed"]')).toHaveTextContent('Couldn’t refresh: GitHub refused the token (401). Showing data from 6 min ago.')
    unmount()
    render(<Freshness at={at} loading={false} failed reason={REASON} />)
    expect(document.querySelector('[data-gh-status]')).toBeNull()
    expect(ask).not.toHaveBeenCalled()
  })

  it('says nothing more while GitHub is not connected', async () => {
    vi.spyOn(githubApi, 'statusPage').mockRejectedValue(new ApiError(409, '409 Conflict', { kind: 'not_connected' }))
    render(<Freshness github at={at} loading={false} failed reason={REASON} />)
    await waitFor(() => expect(document.querySelector('[data-gh-status]')).toBeNull())
    expect(document.querySelector('[data-deck-fresh="failed"]')).toHaveTextContent('Couldn’t reach GitHub.')
  })
})

describe('Watch GitHub Status', () => {
  it('is off by default; ticked, the dot shows only while GitHub reports an incident', async () => {
    const ask = vi.spyOn(githubApi, 'statusPage').mockResolvedValue(DOWN)
    const { container } = render(<GitHubStatusDot />)
    expect(container.textContent).toBe('')
    expect(ask).not.toHaveBeenCalled()
    render(<Freshness github at={Date.now()} loading={false} failed reason={REASON} />)
    fireEvent.click(await screen.findByLabelText('Watch GitHub Status'))
    await waitFor(() => expect(container.querySelector('[data-gh-status-dot]')).toBeInTheDocument())
    expect(container.querySelector('[data-gh-status-dot]')!.getAttribute('title')).toContain('Partial outage')
    ask.mockResolvedValue(OK)
    act(() => { setWatching(false) })
    expect(container.querySelector('[data-gh-status-dot]')).toBeNull()
  })

  it('draws no dot while everything is operational', async () => {
    vi.spyOn(githubApi, 'statusPage').mockResolvedValue(OK)
    setWatching(true)
    const { container } = render(<GitHubStatusDot />)
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
    expect(container.textContent).toBe('')
  })
})
