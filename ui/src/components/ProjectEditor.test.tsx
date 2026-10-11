import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectEditor } from './ProjectEditor'
import { ProjectRepos } from './ProjectRepos'
import type { Project, RepoInfo } from '@/lib/projects'

const m = vi.hoisted(() => ({ patch: vi.fn(), scan: vi.fn(), split: vi.fn(), merge: vi.fn(), repos: vi.fn() }))
vi.mock('@/lib/projects', async (orig) => {
  const actual = await orig<typeof import('@/lib/projects')>()
  return { ...actual, projectsApi: { ...actual.projectsApi, patch: m.patch, scan: m.scan, split: m.split, merge: m.merge, repos: m.repos } }
})

const repo = (path: string, name: string, extra: Partial<RepoInfo> = {}): RepoInfo => ({ path, name, exists: true, live: 0, waiting: 0, total: 0, cost_today: 0, branch: 'main', ...extra })
const multi: Project = { id: '7', root: '/work', name: 'work', kind: 'folder', cost_today: 4, repos: [repo('/work/api', 'api', { cost_today: 3, changed: 2 }), repo('/work/web', 'web', { cost_today: 1, branch: 'feat/x' })] }
const other: Project = { id: '8', root: '/src/tools', name: 'tools', kind: 'repo' }

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  m.patch.mockResolvedValue(multi)
  m.merge.mockResolvedValue(multi)
  m.split.mockResolvedValue([])
  m.repos.mockResolvedValue([])
})

describe('the project editor', () => {
  it('renames, drops a member and adds one found by Rescan in one save', async () => {
    m.scan.mockResolvedValue({ root: '/work', repos: [{ path: '/work/api', name: 'api' }, { path: '/work/web', name: 'web' }, { path: '/work/infra', name: 'infra' }] })
    const onClose = vi.fn()
    render(<ProjectEditor project={multi} projects={[multi, other]} onClose={onClose} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Platform' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /web/ }))
    expect(screen.getByText(/1 will leave the project/)).toHaveTextContent('files stay')
    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }))
    expect(await screen.findByRole('status')).toHaveTextContent('1 repository not in the project yet')
    fireEvent.click(screen.getByRole('checkbox', { name: /infra/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(m.patch).toHaveBeenCalledWith('7', { name: 'Platform', repos: ['/work/api', '/work/infra'] })
    expect(m.merge).not.toHaveBeenCalled()
  })

  it('merges a repository project in', async () => {
    const onClose = vi.fn()
    render(<ProjectEditor project={multi} projects={[multi, other]} onClose={onClose} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /tools/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(m.patch).not.toHaveBeenCalled()
    expect(m.merge).toHaveBeenCalledWith(['7', '8'])
  })

  it('splits only after saying what a split does', async () => {
    const onClose = vi.fn()
    render(<ProjectEditor project={multi} projects={[multi]} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Split…' }))
    expect(m.split).not.toHaveBeenCalled()
    expect(screen.getByText(/No file is touched/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Split into 2' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(m.split).toHaveBeenCalledWith('7')
  })
})

describe('the repositories on the project page', () => {
  it('lists each repository with its branch, changes, share of today and open PRs', async () => {
    m.repos.mockResolvedValue([{ ...multi.repos![0], open_prs: 2 }, { ...multi.repos![1], open_prs: 0 }])
    render(<ProjectRepos project={multi} projects={[multi]} />)
    const rows = screen.getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('api')
    expect(rows[0]).toHaveTextContent('±2')
    expect(rows[0]).toHaveTextContent('75%')
    expect(rows[1]).toHaveTextContent('feat/x')
    await waitFor(() => expect(rows[0]).toHaveTextContent('2 open PRs'))
    expect(rows[1]).toHaveTextContent('no open PRs')
    expect(m.repos).toHaveBeenCalledWith('7')
  })
})
