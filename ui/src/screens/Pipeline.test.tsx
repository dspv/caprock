import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RepoRemote, SessionSummary } from '@/lib/api'

const h = vi.hoisted(() => ({ sessions: [] as unknown[], stats: [] as string[], listed: 0, remotes: {} as Record<string, { root?: string; repo?: string; guarded?: boolean }>, asked: [] as string[][] }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    sessions: async () => { h.listed++; return h.sessions },
    sessionCIStats: async (id: string) => { h.stats.push(id); return { connected: true, repo: `ada/${id}`, prs: [] } },
    sessionPRs: async () => ({ connected: true, prs: [] }),
    // Unknown folders answer as git repositories on GitHub named after them.
    repoRemotes: async (dirs: string[]) => {
      h.asked.push([...dirs])
      return { repos: dirs.map((dir) => ({ dir, ...(h.remotes[dir] ?? { root: dir, repo: `ada/${dir.split('/').pop()}` }) })) }
    },
  } }
})

import { PipelineScreen } from './Pipeline'
import { PipelineHostContext } from '@/lib/pipelineHost'
import { pickPipeline, pipelineRepos } from '@/lib/pipeline'
import { parseHash, href } from '@/lib/router'
import { forgetDeckAnswers } from '@/lib/deckCache'

const agent = (id: string, root: string, at: number, p: Partial<SessionSummary> = {}) =>
  ({ session_id: id, cwd: root, repo_root: root, project: root.split('/').pop(), status: 'active', owned: true, last_event_at: at, ...p }) as unknown as SessionSummary

afterEach(() => { h.sessions = []; h.stats = []; h.listed = 0; h.remotes = {}; h.asked = []; forgetDeckAnswers(); localStorage.clear(); location.hash = '' })

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

  // Owner, 2026-10-15 (translated): two "caprock" entries, the second "This
  // folder is not a git repository with a remote".
  it('lists only git repositories on GitHub, one entry per GitHub repository, and tells same-named ones apart', () => {
    const sessions = [
      agent('m1', '/u/dev/caprock', 90),
      // A copy in Downloads: not a git repository, so no repo_root.
      agent('d1', '/u/Downloads/caprock', 80, { repo_root: undefined }),
      agent('p1', '/u/paste', 70, { repo_root: undefined }),
      agent('o1', '/u/old/caprock', 60), // a second clone of the same repository
      agent('f1', '/u/fork/caprock', 50), // someone else's fork: another repository, same folder name
      agent('l1', '/u/dev/localonly', 40), // no remote
      agent('g1', '/u/dev/onlab', 30), // on GitLab
      agent('r1', '/u/dev/rateguard', 20, { status: 'ended' }),
    ]
    // Before the daemon answers: every git repository, never a plain folder.
    // Three folders called caprock read as their parent and name.
    expect(pipelineRepos(sessions).map((r) => r.name)).toEqual(['dev/caprock', 'old/caprock', 'fork/caprock', 'localonly', 'onlab', 'rateguard'])
    const remotes = new Map<string, RepoRemote>(Object.entries({
      '/u/dev/caprock': { dir: '/u/dev/caprock', root: '/u/dev/caprock', repo: 'dspv/caprock' },
      '/u/old/caprock': { dir: '/u/old/caprock', root: '/u/old/caprock', repo: 'dspv/caprock' },
      '/u/fork/caprock': { dir: '/u/fork/caprock', root: '/u/fork/caprock', repo: 'someone/caprock' },
      '/u/dev/localonly': { dir: '/u/dev/localonly', root: '/u/dev/localonly' },
      '/u/dev/onlab': { dir: '/u/dev/onlab', root: '/u/dev/onlab' },
      '/u/dev/rateguard': { dir: '/u/dev/rateguard', root: '/u/dev/rateguard', repo: 'donmiro/rateguard' },
    }))
    const repos = pipelineRepos(sessions, remotes)
    expect(repos.map((r) => [r.name, r.root, r.live])).toEqual([
      ['dspv/caprock', '/u/dev/caprock', 2],
      ['someone/caprock', '/u/fork/caprock', 1],
      ['rateguard', '/u/dev/rateguard', 0],
    ])
    expect(repos[0]!.roots).toEqual(['/u/dev/caprock', '/u/old/caprock'])
    // The folded clone, remembered or named, still finds its entry; a dropped folder does not.
    expect(pickPipeline(sessions, {}, '/u/old/caprock', remotes).repo?.root).toBe('/u/dev/caprock')
    expect(pickPipeline(sessions, { of: 'o1' }, '', remotes).session?.session_id).toBe('o1')
    expect(pickPipeline(sessions, {}, '/u/dev/localonly', remotes).repo?.root).toBe('/u/dev/caprock')
    expect(pickPipeline(sessions, { of: 'd1' }, '', remotes).repo).toBeUndefined()
    // A folder macOS guards is never read: kept, as git said it is a repository.
    const guarded = new Map(remotes).set('/u/dev/localonly', { dir: '/u/dev/localonly', guarded: true })
    expect(pipelineRepos(sessions, guarded).map((r) => r.root)).toContain('/u/dev/localonly')
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

  it('asks the daemon which folders are on GitHub, and the pills and the list beside them show only those', async () => {
    const roots = ['/w/caprock', '/w/a', '/w/b', '/w/c', '/w/d', '/w/e', '/w/nogit', '/x/caprock', '/w/local']
    h.sessions = roots.map((r, i) => agent(`s${i}`, r, 100 - i, r === '/w/nogit' ? { repo_root: undefined } : {}))
    h.remotes = {
      '/x/caprock': { root: '/x/caprock', repo: 'other/caprock' },
      '/w/caprock': { root: '/w/caprock', repo: 'ada/caprock' },
      '/w/local': { root: '/w/local' },
    }
    render(<PipelineScreen />)
    await waitFor(() => expect(screen.getByRole('tab', { name: /ada\/caprock$/ })).toBeInTheDocument())
    expect(h.asked.at(-1)).toEqual(roots.filter((r) => r !== '/w/nogit').sort())
    expect(screen.queryByRole('tab', { name: /(^| )caprock$/ })).toBeNull()
    const pills = screen.getAllByRole('tab').filter((t) => t.hasAttribute('data-pipeline-repo')).map((t) => t.textContent)
    const more = screen.getByRole('combobox', { name: 'Another repository' })
    const listed = [...more.querySelectorAll('option')].slice(1).map((o) => o.textContent)
    expect([...pills, ...listed].sort()).toEqual(['a', 'ada/caprock', 'b', 'c', 'd', 'e', 'other/caprock'].sort())
    expect(more.querySelector('option')?.textContent).toBe(`${listed.length} more…`)
  })

  it('says how to start when no agent has worked in a repository', async () => {
    h.sessions = [agent('sh', '/w/tools', 1, { kind: 'shell' })]
    render(<PipelineScreen />)
    expect(await screen.findByText('No repository yet')).toBeInTheDocument()
    expect(h.stats).toEqual([])
  })
})
