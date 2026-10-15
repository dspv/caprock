import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/lib/api'

const h = vi.hoisted(() => ({ sessions: [] as unknown[], stats: [] as string[], listed: 0 }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    sessions: async () => { h.listed++; return h.sessions },
    sessionCIStats: async (id: string) => { h.stats.push(id); return { connected: true, repo: `ada/${id}`, prs: [] } },
    sessionPRs: async () => ({ connected: true, prs: [] }),
  } }
})

import { PipelineScreen } from './Pipeline'
import { PipelineHostContext } from '@/lib/pipelineHost'
import { pickPipeline, pipelineRepos } from '@/lib/pipeline'
import { parseHash, href } from '@/lib/router'
import { forgetDeckAnswers } from '@/lib/deckCache'

const agent = (id: string, root: string, at: number, p: Partial<SessionSummary> = {}) =>
  ({ session_id: id, cwd: root, repo_root: root, project: root.split('/').pop(), status: 'active', owned: true, last_event_at: at, ...p }) as unknown as SessionSummary

afterEach(() => { h.sessions = []; h.stats = []; h.listed = 0; forgetDeckAnswers(); localStorage.clear(); location.hash = '' })

describe('the Pipeline’s repository', () => {
  const list = [
    agent('a1', '/w/app', 10), agent('a2', '/w/app', 30), agent('s1', '/w/site', 50, { status: 'ended' }),
    agent('sh', '/w/tools', 90, { kind: 'shell' }), agent('c1', '/w/cli', 20),
  ]

  it('lists every repository an agent worked in, those with one running first, each read through its newest session', () => {
    const repos = pipelineRepos(list)
    expect(repos.map((r) => [r.name, r.session.session_id, r.live])).toEqual([['app', 'a2', 2], ['cli', 'c1', 1], ['site', 's1', 0]])
  })

  it('shows the repository named, else the agent’s it was opened from, else the one shown last, else the first', () => {
    expect(pickPipeline(list, { repo: '/w/site' }, '').session?.session_id).toBe('s1')
    // Opened from an agent: that agent is asked, so This session is its.
    expect(pickPipeline(list, { of: 'a1' }, '').session?.session_id).toBe('a1')
    expect(pickPipeline(list, {}, '/w/cli').repo?.name).toBe('cli')
    expect(pickPipeline(list, {}, '').repo?.name).toBe('app')
    // A repository nobody worked in shows nothing, rather than another one.
    expect(pickPipeline(list, { repo: '/w/gone' }, '').repo).toBeUndefined()
  })

  it('has its own address on the dashboard', () => {
    expect(parseHash('#/pipeline')).toEqual({ name: 'pipeline' })
    const r = { name: 'pipeline' as const, repo: '/w/my app', of: 'a1' }
    expect(parseHash(href(r))).toEqual(r)
  })
})

describe('the Pipeline page', () => {
  it('reads the sessions itself in a browser, shows the repository picked, and switches on a pill', async () => {
    h.sessions = [agent('a2', '/w/app', 30), agent('c1', '/w/cli', 20, { status: 'ended' })]
    render(<PipelineScreen />)
    await waitFor(() => expect(h.stats).toEqual(['a2']))
    const app = screen.getByRole('tab', { name: /app/ })
    expect(app).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: 'Pipeline' })).toBeInTheDocument()
    expect(localStorage.getItem('caprock.pipeline.repo')).toBe('/w/app')
    fireEvent.click(screen.getByRole('tab', { name: 'cli' }))
    expect(parseHash(location.hash)).toEqual({ name: 'pipeline', repo: '/w/cli' })
    expect(localStorage.getItem('caprock.pipeline.repo')).toBe('/w/cli')
  })

  it('takes the app’s sessions and asks for none, and offers Back when the app has somewhere to go', async () => {
    const back = vi.fn()
    render(
      <PipelineHostContext.Provider value={{ sessions: [agent('a2', '/w/app', 30)], onBack: back }}>
        <PipelineScreen of="a2" />
      </PipelineHostContext.Provider>,
    )
    await waitFor(() => expect(h.stats).toEqual(['a2']))
    expect(h.listed).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: /^Back to where you were/ }))
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('says how to start when no agent has worked in a repository', async () => {
    h.sessions = [agent('sh', '/w/tools', 1, { kind: 'shell' })]
    render(<PipelineScreen />)
    expect(await screen.findByText('No repository yet')).toBeInTheDocument()
    expect(h.stats).toEqual([])
  })
})
