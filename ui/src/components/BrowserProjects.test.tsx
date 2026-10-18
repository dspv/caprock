import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type SessionSummary } from '@/lib/api'
import { projectsApi, type Project } from '@/lib/projects'
import { BrowserProjects, browserProjects } from './BrowserProjects'

const saved: Project[] = [
  { id: '1', name: 'alpha', root: '/work/alpha', kind: 'repo' },
  { id: '2', name: 'empty', root: '/work/empty', kind: 'folder' },
]
const session = (id: string, root = '/work/alpha', extra: Partial<SessionSummary> = {}): SessionSummary => ({
  session_id: id, cwd: root, repo_root: root, project: root.split('/').pop()!,
  title: `Session ${id}`, status: 'active', owned: false, last_event_at: 1,
  ...extra,
} as SessionSummary)

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(projectsApi, 'list').mockResolvedValue(saved)
  vi.spyOn(api, 'sessionsWithTotal').mockResolvedValue({ items: [session('live')], total: 1 })
  vi.spyOn(api, 'sessionsInDir').mockResolvedValue([session('recent', '/work/alpha', { status: 'ended' })])
})

describe('browser projects', () => {
  it('shows saved projects without sessions and reads history only on expansion', async () => {
    render(<BrowserProjects />)
    const region = screen.getByRole('region', { name: 'Projects' })
    const alpha = await within(region).findByRole('button', { name: /alpha.*1 live/ })
    expect(within(region).getByRole('button', { name: /empty.*Sessions/ })).toBeInTheDocument()
    expect(api.sessionsInDir).not.toHaveBeenCalled()
    // All live sessions, without the phone home's 60-session history cap.
    expect(api.sessionsWithTotal).toHaveBeenCalledWith(true, '', 0, 'exclude')
    fireEvent.click(alpha)
    expect(await screen.findByRole('link', { name: /Session recent/ })).toHaveAttribute('href', '#/session/recent?tab=chat')
    expect(screen.getByRole('link', { name: /Session live/ })).toHaveAttribute('href', '#/session/live?tab=chat')
    expect(alpha).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(alpha)
    expect(screen.queryByRole('link', { name: /Session live/ })).not.toBeInTheDocument()
  })

  it('includes observed projects and respects archived, nested and multi-repo projects', () => {
    const parent: Project = { id: '3', name: 'parent', root: '/work', kind: 'folder' }
    const multi: Project = { id: '4', name: 'suite', root: '/suite', kind: 'folder', repos: [{ name: 'api', path: '/members/api', exists: true, live: 0, waiting: 0, total: 0, cost_today: 0 }] }
    const archived: Project = { id: '5', name: 'old', root: '/old', kind: 'repo', archived_at: 1 }
    const result = browserProjects([...saved, parent, multi, archived], [session('a'), session('member', '/members/api'), session('old', '/old'), session('new', '/elsewhere')])
    expect(result.map((p) => p.root)).toEqual(['/work/alpha', '/elsewhere', '/work/empty', '/work', '/suite'])
  })

  it('assigns a nested live session to its closest project only', async () => {
    vi.mocked(projectsApi.list).mockResolvedValue([...saved, { id: '3', name: 'parent', root: '/work', kind: 'folder' }])
    render(<BrowserProjects />)
    expect(await screen.findByRole('button', { name: /alpha.*1 live/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /parent.*Sessions/ })).toBeInTheDocument()
  })

  it('reads member repositories, deduplicates sessions and keeps chats on Chats', async () => {
    vi.mocked(projectsApi.list).mockResolvedValue([{ id: '4', name: 'suite', root: '/suite', kind: 'folder', repos: [{ name: 'api', path: '/members/api', exists: true, live: 0, waiting: 0, total: 0, cost_today: 0 }] }])
    vi.mocked(api.sessionsWithTotal).mockResolvedValue({ items: [], total: 0 })
    vi.mocked(api.sessionsInDir).mockResolvedValue([session('member', '/members/api'), session('chat', '/members/api', { chat: true })])
    render(<BrowserProjects />)
    fireEvent.click(await screen.findByRole('button', { name: /suite/ }))
    expect(await screen.findByRole('link', { name: /Session member/ })).toBeInTheDocument()
    expect(screen.getAllByRole('link')).toHaveLength(1)
    expect(api.sessionsInDir).toHaveBeenCalledWith('/suite')
    expect(api.sessionsInDir).toHaveBeenCalledWith('/members/api')
  })

  it('distinguishes an unavailable project list from an empty one and retries', async () => {
    vi.mocked(projectsApi.list).mockRejectedValueOnce(new Error('offline'))
    vi.mocked(api.sessionsWithTotal).mockResolvedValue({ items: [], total: 0 })
    render(<BrowserProjects />)
    expect(await screen.findByText('Your projects are unavailable.')).toBeInTheDocument()
    expect(screen.queryByText(/No projects yet/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: /alpha/ })).toBeInTheDocument()
  })

  it('does not turn an inaccessible session history into an empty project', async () => {
    vi.mocked(api.sessionsWithTotal).mockResolvedValue({ items: [], total: 0 })
    vi.mocked(api.sessionsInDir).mockRejectedValue(new Error('offline'))
    render(<BrowserProjects />)
    fireEvent.click(await screen.findByRole('button', { name: /alpha/ }))
    expect(await screen.findByText('Sessions are unavailable.')).toBeInTheDocument()
    expect(screen.queryByText('No sessions in this project yet.')).not.toBeInTheDocument()
  })
})
