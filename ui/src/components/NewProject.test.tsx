/**
 * Start work from the phone (WP-15): clone with progress that survives a
 * reload, a new project, a worktree, then an agent started there that lands
 * on its chat. A viewer phone is told where control is granted instead.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { live } from '@/lib/live'
import { PENDING_CLONE_KEY } from '@/lib/startwork'
import { NewProjectScreen } from './NewProject'

const m = vi.hoisted(() => ({
  add: vi.fn(),
  ops: vi.fn(async () => [] as unknown[]),
  list: vi.fn(async () => [] as unknown[]),
  createWorktree: vi.fn(),
  spawn: vi.fn(async () => ({ session_id: 's-new', cwd: '/x' })),
  pairMe: vi.fn(async () => ({ role: 'controller' })),
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      status: async () => ({ claude_available: true }),
      browse: async () => ({ dir: '/Users/me', parent: '', root: '/Users/me', entries: [] }),
      recentDirs: async () => [],
      agentModels: async () => ({ agent: 'codex', models: [] }),
      spawn: m.spawn,
      pairMe: m.pairMe,
    },
  }
})

vi.mock('@/lib/projects', async (orig) => {
  const actual = await orig<typeof import('@/lib/projects')>()
  return { ...actual, newOpId: () => 'op-test', projectsApi: { ...actual.projectsApi, add: m.add, ops: m.ops, list: m.list, createWorktree: m.createWorktree } }
})

beforeEach(() => {
  localStorage.clear()
  location.hash = '#/start'
  for (const f of Object.values(m)) f.mockClear()
})
afterEach(cleanup)

const typeURL = (v: string) => fireEvent.change(screen.getByPlaceholderText('https://github.com/you/repo'), { target: { value: v } })

describe('Start work', () => {
  it('clones under home with live progress, then starts an agent that opens on its chat', async () => {
    m.add.mockResolvedValue({ op: { op_id: 'op-test', state: 'running', progress: 0 }, existing: false })
    render(<NewProjectScreen mode="clone" />)
    await screen.findByDisplayValue('/Users/me')
    typeURL('https://github.com/octocat/Hello-World')
    expect(screen.getByText('→ /Users/me/Hello-World')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    await waitFor(() => expect(m.add).toHaveBeenCalledWith({ clone: { url: 'https://github.com/octocat/Hello-World', parent: '/Users/me' }, op_id: 'op-test' }))
    // Kept before it is sent: a reload finds it.
    expect(JSON.parse(localStorage.getItem(PENDING_CLONE_KEY)!).op_id).toBe('op-test')
    act(() => live.handle({ type: 'op', data: { op_id: 'op-test', state: 'running', phase: 'Receiving objects', progress: 62 } }))
    expect(await screen.findByText('Receiving objects')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('62')
    act(() => live.handle({ type: 'op', data: { op_id: 'op-test', state: 'done', progress: 100, dest: '/Users/me/Hello-World', project_id: 3 } }))
    fireEvent.click(await screen.findByRole('button', { name: 'Start an agent here' }))
    expect(await screen.findByDisplayValue('/Users/me/Hello-World')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }))
    await waitFor(() => expect(m.spawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/Users/me/Hello-World' })))
    await waitFor(() => expect(location.hash).toBe('#/session/s-new?tab=chat'))
  })

  it('picks a clone back up after the page was reloaded mid-clone, without starting another', async () => {
    localStorage.setItem(PENDING_CLONE_KEY, JSON.stringify({ op_id: 'op-old', url: 'https://github.com/octocat/Hello-World', parent: '/Users/me', started_at: Date.now() }))
    m.ops.mockResolvedValueOnce([{ op_id: 'op-old', state: 'running', phase: 'Resolving deltas', progress: 90 }])
    render(<NewProjectScreen />)
    expect(await screen.findByText('Resolving deltas')).toBeTruthy()
    expect(m.add).not.toHaveBeenCalled()
  })

  it('refuses an address that is not https:// or git@ before sending it', async () => {
    render(<NewProjectScreen mode="clone" />)
    await screen.findByDisplayValue('/Users/me')
    typeURL('file:///Users/me/repo.git')
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('https://')
    expect(m.add).not.toHaveBeenCalled()
  })

  it("shows the daemon's refusal and offers to try again", async () => {
    const { ApiError } = await import('@/lib/api')
    m.add.mockRejectedValue(new ApiError(400, '400', { error: '/Users/me/Hello-World already exists; add it instead, or clone under another name' }))
    render(<NewProjectScreen mode="clone" />)
    await screen.findByDisplayValue('/Users/me')
    typeURL('https://github.com/octocat/Hello-World')
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('creates a new project with git init', async () => {
    m.add.mockResolvedValue({ project: { id: '9', root: '/Users/me/fresh', name: 'fresh', kind: 'repo' }, created: true })
    render(<NewProjectScreen mode="new" />)
    await screen.findByDisplayValue('/Users/me')
    fireEvent.change(screen.getByPlaceholderText('my-new-project'), { target: { value: 'fresh' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(m.add).toHaveBeenCalledWith({ create: { parent: '/Users/me', name: 'fresh', git_init: true } }))
    expect(await screen.findByText('/Users/me/fresh')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Make a worktree in it' })).toBeTruthy()
  })

  it('makes a worktree on a new branch', async () => {
    m.list.mockResolvedValue([{ id: '3', root: '/Users/me/app', name: 'app', kind: 'repo', default_branch: 'main' }])
    m.createWorktree.mockResolvedValue({ path: '/Users/me/app/.caprock-worktrees/phone-x', branch: 'phone-x' })
    render(<NewProjectScreen mode="worktree" />)
    fireEvent.change(await screen.findByPlaceholderText('feature-x'), { target: { value: 'phone-x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Make the worktree' }))
    await waitFor(() => expect(m.createWorktree).toHaveBeenCalledWith('3', { branch: 'phone-x', create: true, base: undefined }))
    expect(await screen.findByText('/Users/me/app/.caprock-worktrees/phone-x')).toBeTruthy()
  })

  it('tells a viewer phone where control is granted, and offers nothing to press', async () => {
    localStorage.setItem('caprock.device.token', 'tok')
    m.pairMe.mockResolvedValue({ role: 'viewer' })
    render(<NewProjectScreen mode="clone" />)
    expect(await screen.findByText(/can read Caprock, not start work/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Clone' })).toBeNull()
  })
})
