/**
 * The phone's commit panel on a session's Changes tab: it finds the
 * session's worktree (never guessing one the project does not list), lets a
 * controller tap files to stage them and commit, and tells a viewer where
 * committing happens.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/lib/projects'
import type { Changes } from '@/lib/changes'
import { resolveWorktree, SessionCommit } from './SessionCommit'

const m = vi.hoisted(() => ({ role: 'controller', list: vi.fn() }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, isPairedDevice: () => true, deviceToken: () => 'tok', api: { ...actual.api, pairMe: async () => ({ role: m.role }) } }
})
vi.mock('@/lib/projects', async (orig) => {
  const actual = await orig<typeof import('@/lib/projects')>()
  return { ...actual, projectsApi: { ...actual.projectsApi, list: m.list } }
})

const project: Project = {
  id: '3', root: '/home/me/app', name: 'app', kind: 'repo',
  worktrees: [{ name: 'fix-login', path: '/home/me/app/.caprock-worktrees/fix-login', branch: 'fix-login' }],
}

const changes: Changes = {
  project_id: 3, worktree: 'fix-login', path: '/home/me/app/.caprock-worktrees/fix-login', branch: 'fix-login', ahead: 0, behind: 0,
  remote: 'origin', published: true, upstream: 'origin/fix-login', staged: [], conflicted: [], token: 't', at: 1,
  unstaged: [{ path: 'login.ts', status: 'modified', additions: 4, deletions: 2 }],
}

let posts: { url: string; body: unknown }[] = []
beforeEach(() => {
  posts = []
  m.list.mockResolvedValue([project])
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(init.body as string) })
      return new Response(JSON.stringify({ changes: { ...changes, staged: changes.unstaged, unstaged: [] } }), { status: 200 })
    }
    return new Response(JSON.stringify(changes), { status: 200 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('resolveWorktree', () => {
  it('names the linked worktree a session runs in, else the main checkout', () => {
    expect(resolveWorktree({ cwd: '/home/me/app/.caprock-worktrees/fix-login/src', repo_root: '/home/me/app' }, [project]))
      .toMatchObject({ kind: 'ok', ref: { projectId: '3', worktree: 'fix-login' } })
    expect(resolveWorktree({ cwd: '/home/me/app', repo_root: '/home/me/app' }, [project]))
      .toMatchObject({ kind: 'ok', ref: { projectId: '3', worktree: '' } })
  })

  it('does not guess a worktree the project does not list', () => {
    expect(resolveWorktree({ cwd: '/home/me/app/.caprock-worktrees/other', repo_root: '/home/me/app' }, [project]).kind).toBe('unknown-worktree')
    expect(resolveWorktree({ cwd: '/elsewhere', repo_root: '/elsewhere' }, [project]).kind).toBe('unlisted')
  })
})

describe('SessionCommit', () => {
  const session = { session_id: 's1', cwd: '/home/me/app/.caprock-worktrees/fix-login', repo_root: '/home/me/app', git_branch: 'fix-login' }

  it('stages a tapped file in the right worktree', async () => {
    m.role = 'controller'
    render(<SessionCommit session={session} />)
    fireEvent.click(await screen.findByRole('button', { name: /login\.ts/ }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]!.url).toBe('/v1/projects/3/changes/stage?worktree=fix-login')
    expect(posts[0]!.body).toEqual({ paths: ['login.ts'] })
  })

  it('shows a viewer the changes and no commit button', async () => {
    m.role = 'viewer'
    render(<SessionCommit session={session} />)
    expect(await screen.findByText('This device can read, not commit. Commit on the machine, or make this device a controller there.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Commit/ })).toBeNull()
  })
})
