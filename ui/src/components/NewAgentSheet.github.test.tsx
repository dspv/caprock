/**
 * New agent → From GitHub: an open issue prefills a new copy's name and the
 * first message; a pull request also starts the copy at its head
 * (`worktree_pr`). Shown only for a project on GitHub with GitHub connected,
 * unless asked for (⌘K → New agent from issue…), when the picker says how to
 * connect.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/lib/projects'
import type { GitHubItems } from '@/lib/fromGitHub'

const spawn = vi.fn(async (_req: unknown) => ({ session_id: 'new-1', cwd: '/w/app' }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      status: async () => ({ version: 'v0.0.0', claude_available: true, claude_bypass_accepted: true }),
      agentCatalog: async () => ({ licensed: false, home: '/h', agents: [{ id: 'claude', label: 'Claude Code', installed: true, ready: true, models: [], observed: true, prompt: true }] }),
      settings: async () => ({}),
      saveSettings: async (s: unknown) => s,
      spawn: (req: unknown) => spawn(req),
      subscriptions: async () => { throw new Error('not offered') },
      recentDirs: async () => [],
      localRepos: async () => ({ root: '/w', home: '/h', scanned_at: 0, repos: [] }),
    },
  }
})
vi.mock('@/lib/projects', async (orig) => {
  const actual = await orig<typeof import('@/lib/projects')>()
  return { ...actual, projectsApi: { ...actual.projectsApi, branches: async () => [{ name: 'main', main: true, default: true, local: true, remote: 'origin', committed_ms: 1 }] } }
})
const gh = vi.hoisted(() => ({ connected: true, items: vi.fn() }))
vi.mock('@/lib/github', async (orig) => {
  const actual = await orig<typeof import('@/lib/github')>()
  return {
    ...actual,
    useGitHubStatus: () => ({ status: { connected: gh.connected }, reload: () => {}, set: () => {} }),
    githubApi: { ...actual.githubApi, items: (id: string, q?: string) => gh.items(id, q) },
  }
})

import { NewAgentSheet } from './NewAgentSheet'

const LIST: GitHubItems = {
  connected: true,
  repo: { owner: 'ada', name: 'app', full_name: 'ada/app', html_url: 'https://github.com/ada/app' },
  items: [
    { number: 12, title: 'Login fails on Safari', url: 'https://github.com/ada/app/issues/12', author: 'grace', labels: [{ name: 'bug' }], pr: false, body: 'It fails.', comments: 1 },
    { number: 13, title: 'Fix the login', url: 'https://github.com/ada/app/pull/13', author: 'linus', labels: [], pr: true, body: 'Fixes #12.', comments: 0 },
  ],
  more: false,
  at: 1,
}

const onGitHub = [{ id: '1', root: '/w/app', name: 'app', kind: 'repo', remote_url: 'git@github.com:ada/app.git' }] as Project[]

beforeEach(() => {
  spawn.mockReset().mockResolvedValue({ session_id: 'new-1', cwd: '/w/app' })
  gh.connected = true
  gh.items.mockReset().mockResolvedValue(LIST)
  localStorage.clear()
})

describe('New agent from GitHub', () => {
  it('starts an issue in a new copy named after it, its text as the first message', async () => {
    render(<NewAgentSheet projects={onGitHub} projectId="1" onClose={vi.fn()} onStarted={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'From a GitHub issue or pull request…' }))
    const search = await screen.findByLabelText('Search open issues and pull requests')
    fireEvent.change(search, { target: { value: 'safari' } })
    expect(screen.queryByText('Fix the login')).toBeNull()
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(await screen.findByLabelText('Started from GitHub')).toHaveTextContent('Issue #12')
    expect(screen.getByLabelText<HTMLSelectElement>('Where').value).toBe('__new__')
    expect(screen.getByDisplayValue('issue-12-login-fails-on-safari')).toBeTruthy()
    expect(screen.getByPlaceholderText('What should it do?')).toHaveValue('Work on issue #12: Login fails on Safari\nhttps://github.com/ada/app/issues/12\n\nIt fails.')
    // The remembered way to start is not changed by a pick.
    expect(localStorage.getItem('caprock.newAgent.where')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Start/ }))
    await waitFor(() => expect(spawn).toHaveBeenCalled())
    const req = spawn.mock.calls[0]![0] as Record<string, unknown>
    expect(req).toMatchObject({ worktree: 'issue-12-login-fails-on-safari', worktree_base: 'main' })
    expect(req.worktree_pr).toBeUndefined()
    expect(String(req.prompt)).toContain('https://github.com/ada/app/issues/12')
  })

  it('starts a pull request at its head, with nothing to pick for a base', async () => {
    render(<NewAgentSheet projects={onGitHub} projectId="1" onClose={vi.fn()} onStarted={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'From a GitHub issue or pull request…' }))
    fireEvent.click(await screen.findByText('Fix the login'))
    expect(await screen.findByLabelText('Started from GitHub')).toHaveTextContent('Pull request #13')
    expect(screen.queryByLabelText('Start from branch')).toBeNull()
    // Edited before Start: what is typed is what goes.
    fireEvent.change(screen.getByPlaceholderText('What should it do?'), { target: { value: 'Review #13 only.' } })
    fireEvent.click(screen.getByRole('button', { name: /^Start/ }))
    await waitFor(() => expect(spawn).toHaveBeenCalled())
    const req = spawn.mock.calls[0]![0] as Record<string, unknown>
    expect(req).toMatchObject({ worktree: 'pr-13-fix-the-login', worktree_pr: 13, prompt: 'Review #13 only.' })
    expect(req.worktree_base).toBeUndefined()
    expect(req.worktree_pull).toBeUndefined()
  })

  it('is a short link at the end of the Where label row, its full words its name', async () => {
    render(<NewAgentSheet projects={onGitHub} projectId="1" onClose={vi.fn()} onStarted={vi.fn()} />)
    const link = await screen.findByRole('button', { name: 'From a GitHub issue or pull request…' })
    expect(link).toHaveTextContent('From an issue or PR…')
    const where = screen.getByRole('combobox', { name: 'Where' })
    expect(where.closest('label')!.contains(link)).toBe(false)
    expect(where.closest('label')!.parentElement!.contains(link)).toBe(true)
  })

  it('is not offered for a project off GitHub, nor while GitHub is not connected', async () => {
    const { unmount } = render(<NewAgentSheet projects={[{ ...onGitHub[0]!, remote_url: 'https://gitlab.com/a/b.git' }]} projectId="1" onClose={vi.fn()} onStarted={vi.fn()} />)
    await screen.findByLabelText('Model')
    expect(screen.queryByRole('button', { name: 'From a GitHub issue or pull request…' })).toBeNull()
    unmount()
    gh.connected = false
    render(<NewAgentSheet projects={onGitHub} projectId="1" onClose={vi.fn()} onStarted={vi.fn()} />)
    await screen.findByLabelText('Model')
    expect(screen.queryByRole('button', { name: 'From a GitHub issue or pull request…' })).toBeNull()
    expect(gh.items).not.toHaveBeenCalled()
  })

  it('says how to connect when asked for from the palette while not connected', async () => {
    gh.items.mockResolvedValue({ ...LIST, connected: false, items: [] })
    render(<NewAgentSheet projects={onGitHub} projectId="1" fromGitHub onClose={vi.fn()} onStarted={vi.fn()} />)
    expect(await screen.findByText(/Connect GitHub in Settings → GitHub to start from an issue/)).toBeTruthy()
  })
})
