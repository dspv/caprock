/**
 * The Pipeline page's Default branch panel: the session deck's Main view
 * until the deck was removed (owner, 2026-10-20).
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { forgetDeckAnswers } from '@/lib/deckCache'
import { PipelineMain } from './PipelineMain'

const now = Date.now()
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
const job = (id: number, name: string, conclusion: string) => ({ id, run_id: 1, name, status: 'completed', conclusion, started_at: now - 120_000, completed_at: now - 60_000, duration_ms: 60_000, labels: ['ubuntu-latest'], os: 'linux', html_url: `https://github.com/a/b/actions/runs/1/job/${id}`, steps: [{ number: 1, name: 'go test', status: 'completed', conclusion }] })
const MAIN = {
  connected: true, repo: 'a/b', branch: 'main',
  ci: { repo: 'a/b', head_sha: 'abc', branch: 'main', state: 'fail', runner_ms: 120_000, by_os: [], at: now,
    runs: [{ id: 1, name: 'CI', status: 'completed', conclusion: 'failure', started_at: now - 120_000, updated_at: now - 60_000, html_url: 'https://github.com/a/b/actions/runs/1', jobs: [job(11, 'lint', 'success'), job(12, 'test', 'failure')] }] },
}
const USAGE = { account: 'a', org: false, year: 2026, month: 10, available: true, minutes: 1234, gross_usd: 3, discount_usd: 0, net_usd: 3, by_sku: [], at: now }

afterEach(() => { forgetDeckAnswers(); localStorage.clear(); vi.unstubAllGlobals() })

describe('the Pipeline’s default branch panel', () => {
  it('lists each workflow on the default branch, what Actions billed, and a failed job’s log with Investigate', async () => {
    const posts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { posts.push(url); return json({ sent: true }) }
      if (url.endsWith('/ci/main')) return json(MAIN)
      if (url.includes('/github/actions-usage')) return json(USAGE)
      if (url.includes('/ci/jobs/12/log')) return json({ job_id: 12, lines: ['ok', '##[error]boom'], error_line: 1 })
      return new Response('', { status: 404 })
    }))
    const onToast = vi.fn()
    const s = { session_id: 's1', owned: true, status: 'active', title: 'Agent', cwd: '/w', repo_root: '/w' }
    render(<PipelineMain sessionId="s1" s={s as never} visible now={now} why="" onToast={onToast} />)
    expect(await screen.findByText('CI')).toBeInTheDocument()
    expect(document.querySelector('[data-pipeline-main-run="1"]')).toBeTruthy()
    await waitFor(() => expect(document.querySelector('[data-pipeline-usage="available"]')).toHaveTextContent('Actions this month: 1,234 min · $3.00'))
    expect(document.querySelector('[data-pipeline-main-failure="12"]')).toHaveTextContent('test › go test')
    await waitFor(() => expect(document.querySelector('[data-pipeline-main-log]')).toHaveTextContent('##[error]boom'))
    await act(async () => { fireEvent.click(document.querySelector('[data-pipeline-main-investigate]')!) })
    await waitFor(() => expect(posts).toEqual(['/v1/agents/s1/queue']))
    expect(onToast).toHaveBeenCalledWith('Sent to Agent')
  })

  it('draws nothing while GitHub is not connected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ connected: false, repo: 'a/b' })))
    const { container } = render(<PipelineMain sessionId="s1" s={{ session_id: 's1' } as never} visible now={now} why="" />)
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(container).toBeEmptyDOMElement()
  })
})
