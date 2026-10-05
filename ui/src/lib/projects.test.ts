import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from './api'
import { deriveProjects, NotSupportedError, projectsApi, worktreeKeyOf, type Project } from './projects'
import { buildSidebar } from './sidebar'

function sess(p: Partial<SessionSummary>): SessionSummary {
  return {
    session_id: 's', cwd: '/r', project: 'r', model: '', started_at: 0, last_event_at: 0, status: 'active',
    transcript_path: '', has_hooks: true, has_transcript: true, git_branch: 'main', version: '', owned: true,
    stats: { session_id: 's', turns: 0, tool_calls: 0, files_touched: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: 0 },
    activity: { phrase: '', at: '', health: 'working' },
    savings: { billed_with: 0, billed_without: 0, saved: 0, hit_rate: 0, cut_pct: 0 },
    ...p,
  } as SessionSummary
}

afterEach(() => vi.unstubAllGlobals())

describe('the projects client', () => {
  it('reads a bare array or {projects}', async () => {
    const p = { id: '1', root: '/a', name: 'a', kind: 'repo' }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ projects: [p] }), { status: 200 })))
    expect(await projectsApi.list()).toEqual([p])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([p, { junk: true }]), { status: 200 })))
    expect(await projectsApi.list()).toEqual([p])
  })

  it('says "needs a newer daemon" for an endpoint that is not there', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    await expect(projectsApi.list()).rejects.toBeInstanceOf(NotSupportedError)
    await expect(projectsApi.startShell({ cwd: '/a', cols: 80, rows: 24 })).rejects.toThrow(/Shell tabs needs a newer Caprock daemon/)
  })

  it('sends a shell request and returns the session it started', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ session_id: 'sh1' }), { status: 201 }))
    vi.stubGlobal('fetch', f)
    expect(await projectsApi.startShell({ project_id: 'p', cols: 100, rows: 30 })).toEqual({ session_id: 'sh1', cwd: undefined })
    expect(f).toHaveBeenCalledWith('/v1/shells', expect.objectContaining({ method: 'POST', body: JSON.stringify({ project_id: 'p', cols: 100, rows: 30 }) }))
  })
})

describe('projects derived from sessions', () => {
  it('groups by repository, keeps added folders, hides archived ones, and tells same names apart', () => {
    const list = deriveProjects(
      [
        sess({ session_id: '1', cwd: '/a/app/src', repo_root: '/a/app', project: 'app' }),
        sess({ session_id: '2', cwd: '/a/app', repo_root: '/a/app', project: 'app' }),
        sess({ session_id: '3', cwd: '/b/proj', project: 'proj' }),
        sess({ session_id: '4', cwd: '/c/proj', project: 'proj' }),
        sess({ session_id: '5', cwd: '/gone', project: 'gone' }),
        sess({ session_id: '6', cwd: '/a/app', repo_root: '/a/app', kind: 'shell' }),
      ],
      [{ root: '/new/thing', name: 'thing' }, { root: '/gone', name: 'gone', archived: true }],
    )
    expect(list.map((p) => p.name).sort()).toEqual(['app', 'b/proj', 'c/proj', 'thing'])
    expect(list.find((p) => p.root === '/a/app')?.kind).toBe('repo')
  })

  it('files a session under the worktree whose folder holds it', () => {
    const p: Project = { id: 'p', root: '/r', name: 'r', kind: 'repo', worktrees: [{ name: 'main', path: '/r', branch: 'main' }, { name: 'feat', path: '/r/.caprock-worktrees/feat', branch: 'feat' }] }
    expect(worktreeKeyOf({ cwd: '/r/.caprock-worktrees/feat/pkg' }, p)).toBe('feat')
    expect(worktreeKeyOf({ cwd: '/r/pkg' }, p)).toBe('main')
    expect(worktreeKeyOf({ cwd: '/r/.claude/worktrees/x' }, { ...p, worktrees: [] })).toBe('x')
  })
})

describe('the sidebar model', () => {
  const projects: Project[] = [
    { id: 'a', root: '/a', name: 'a', kind: 'repo', branch: 'main' },
    { id: 'b', root: '/b', name: 'b', kind: 'repo', pinned: true },
  ]
  it('puts permission prompts first in the inbox, counts per project, and pins first', () => {
    const m = buildSidebar({
      projects,
      sessions: [
        sess({ session_id: 'w1', cwd: '/a', activity: { phrase: '', at: '2026-10-05T10:00:00Z', health: 'waiting-on-you' } }),
        sess({ session_id: 'p1', cwd: '/a/x', activity: { phrase: '', at: '2026-10-05T11:00:00Z', health: 'working' } }),
        sess({ session_id: 'l1', cwd: '/b', activity: { phrase: '', at: '', health: 'looping' } }),
        sess({ session_id: 'e1', cwd: '/b', status: 'ended' }),
        sess({ session_id: 'e2', cwd: '/b', status: 'ended' }),
      ],
      permissions: new Set(['p1']),
      costs: new Map([['/a', 1.5]]),
      openSessions: new Set(['e2']),
    })
    expect(m.inbox.map((i) => [i.session.session_id, i.reason])).toEqual([['p1', 'permission'], ['w1', 'waiting']])
    expect(m.projects.map((n) => n.project.id)).toEqual(['b', 'a'])
    const a = m.projects.find((n) => n.project.id === 'a')!
    expect([a.waiting, a.live, a.costToday]).toEqual([2, 2, 1.5])
    const b = m.projects.find((n) => n.project.id === 'b')!
    // An ended session shows only while a tab still points at it.
    expect(b.worktrees.flatMap((w) => w.sessions.map((s) => s.session.session_id))).toEqual(['l1', 'e2'])
    expect(b.looping).toBe(1)
  })

  it('builds 50 projects and 30 live sessions in well under a frame', () => {
    const many: Project[] = Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, root: `/w/p${i}`, name: `p${i}`, kind: 'repo' as const }))
    const sessions = Array.from({ length: 230 }, (_, i) => sess({ session_id: `s${i}`, cwd: `/w/p${i % 50}`, status: i < 30 ? 'active' : 'ended' }))
    const t0 = performance.now()
    const m = buildSidebar({ projects: many, sessions, permissions: new Set(), costs: new Map(), openSessions: new Set() })
    expect(performance.now() - t0).toBeLessThan(50)
    expect(m.projects.reduce((n, p) => n + p.live, 0)).toBe(30)
  })
})
