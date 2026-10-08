import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from './api'
import { deriveProjects, fromApiProject, NotSupportedError, projectsApi, worktreeKeyOf, type ApiProject, type Project } from './projects'
import { buildSidebar, OTHER_FOLDERS_ID } from './sidebar'

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
  const wire: ApiProject = {
    id: 7, name: 'caprock', root: '/Users/me/dev/caprock', kind: 'repo', source: 'seed', pinned: false, sort: 0, added_at: 1, exists: true,
    git: { branch: 'master', dirty: true, changed: 3, ahead: 1, behind: 0, at: 1 },
    sessions: { live: 2, waiting: 1, total: 40 }, cost_today: 4.5, last_activity: 9,
    worktrees: [
      { name: 'feat', path: '/Users/me/dev/caprock/.caprock-worktrees/feat', branch: 'feat', caprock: true, dirty: false, changed: 0 },
      { name: 'old', path: '/gone', caprock: false, dirty: false, changed: 0, missing: true },
      { name: 'bisect', path: '/w/bisect', head: '0123456789abcdef', caprock: false, dirty: false, changed: 0 },
    ],
  }

  it('reads {projects} as the daemon sends it, flattened for the sidebar', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ projects: [wire, { junk: true }] }), { status: 200 })))
    const [p] = await projectsApi.list()
    expect(p).toMatchObject({ id: '7', root: '/Users/me/dev/caprock', branch: 'master', changed: 3, ahead: 1, waiting: 1, cost_today: 4.5 })
    // A missing worktree is left out; a detached one names its commit.
    expect(p!.worktrees!.map((w) => [w.name, w.branch])).toEqual([['feat', 'feat'], ['bisect', 'detached @ 0123456']])
  })

  it('shows no branch for a folder, nor for a detached checkout', () => {
    expect(fromApiProject({ ...wire, kind: 'folder', git: null }).branch).toBeUndefined()
    expect(fromApiProject({ ...wire, git: { ...wire.git!, branch: '', detached: true } }).branch).toBeUndefined()
  })

  it('adds a folder, a new folder and a clone with the bodies the daemon reads', async () => {
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      return body.clone
        ? new Response(JSON.stringify({ op: { op_id: 'o1', state: 'running', progress: 0 }, existing: false }), { status: 202 })
        : new Response(JSON.stringify({ project: wire, created: true }), { status: 200 })
    })
    vi.stubGlobal('fetch', f)
    expect(await projectsApi.add({ path: '/a' })).toMatchObject({ project: { id: '7' }, created: true })
    await projectsApi.add({ create: { parent: '/dev', name: 'new', git_init: true } })
    expect(await projectsApi.add({ clone: { url: 'https://github.com/o/r', parent: '/dev' }, op_id: 'o1' })).toEqual({ op: { op_id: 'o1', state: 'running', progress: 0 }, existing: false })
    expect(f.mock.calls.map((c) => c[1].body)).toEqual([
      JSON.stringify({ path: '/a' }),
      JSON.stringify({ create: { parent: '/dev', name: 'new', git_init: true } }),
      JSON.stringify({ clone: { url: 'https://github.com/o/r', parent: '/dev' }, op_id: 'o1' }),
    ])
  })

  it('unlists with a JSON DELETE, as cross-site protection asks', async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', f)
    await projectsApi.unlist('7')
    expect(f).toHaveBeenCalledWith('/v1/projects/7', expect.objectContaining({ method: 'DELETE', headers: expect.objectContaining({ 'Content-Type': 'application/json' }) }))
  })

  it('says "needs a newer daemon" for an endpoint that is not there', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    await expect(projectsApi.list()).rejects.toBeInstanceOf(NotSupportedError)
    await expect(projectsApi.startShell({ cwd: '/a', cols: 80, rows: 24 })).rejects.toThrow(/Shell tabs needs a newer Caprock daemon/)
  })

  it('starts a shell and lists the running ones', async () => {
    const shell = { id: 'sh1', cwd: '/a', started_at: 1, kind: 'shell' }
    const f = vi.fn(async (_u: string, init?: RequestInit) =>
      new Response(JSON.stringify(init?.method === 'POST' ? { shell } : { shells: [shell] }), { status: 200 }))
    vi.stubGlobal('fetch', f)
    expect(await projectsApi.startShell({ project_id: 7, cols: 100, rows: 30 })).toEqual(shell)
    expect(f).toHaveBeenCalledWith('/v1/shells', expect.objectContaining({ method: 'POST', body: JSON.stringify({ project_id: 7, cols: 100, rows: 30 }) }))
    expect(await projectsApi.shells()).toEqual([shell])
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
      now: Date.parse('2026-10-05T12:00:00Z'),
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

  it('folds a turn put down more than 12h ago under the fresh ones, and does not count it', () => {
    const now = Date.parse('2026-10-08T12:00:00Z')
    const waiting = (id: string, at: string) => sess({ session_id: id, cwd: '/a', activity: { phrase: '', at, health: 'waiting-on-you' } })
    const m = buildSidebar({
      projects,
      sessions: [
        waiting('days', '2026-10-05T10:00:00Z'),
        waiting('day', '2026-10-07T10:00:00Z'),
        waiting('hour', '2026-10-08T11:00:00Z'),
        waiting('morning', '2026-10-08T08:00:00Z'),
        sess({ session_id: 'asks', cwd: '/a', activity: { phrase: '', at: '2026-10-01T00:00:00Z', health: 'working' } }),
      ],
      permissions: new Set(['asks']),
      costs: new Map(),
      openSessions: new Set(),
      now,
    })
    expect(m.inbox.map((i) => [i.session.session_id, i.stale])).toEqual([
      ['asks', false], ['morning', false], ['hour', false], ['day', true], ['days', true],
    ])
    expect(m.projects.find((n) => n.project.id === 'a')!.waiting).toBe(3)
  })

  it('puts live sessions in folders no project holds under Other folders, one row per folder', () => {
    const m = buildSidebar({
      projects,
      sessions: [
        sess({ session_id: 'd1', cwd: '/Users/me/Downloads/caprock' }),
        sess({ session_id: 'd2', cwd: '/Users/me/dev/caprock' }),
        sess({ session_id: 'gone', cwd: '/x', status: 'ended' }),
        sess({ session_id: 'in-a', cwd: '/a' }),
        sess({ session_id: 'x1', cwd: '/elsewhere/b' }),
      ],
      permissions: new Set(),
      costs: new Map(),
      openSessions: new Set(),
    })
    const other = m.projects[m.projects.length - 1]!
    expect(other.project.id).toBe(OTHER_FOLDERS_ID)
    expect(other.worktrees.map((w) => [w.branch, w.sessions.map((s) => s.session.session_id)])).toEqual([
      ['dev/caprock', ['d2']],
      ['Downloads/caprock', ['d1']],
      // Named apart from the listed project at /b.
      ['elsewhere/b', ['x1']],
    ])
  })

  it('builds 50 projects and 30 live sessions in well under a frame', () => {
    const many: Project[] = Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, root: `/w/p${i}`, name: `p${i}`, kind: 'repo' as const }))
    const sessions = Array.from({ length: 230 }, (_, i) => sess({ session_id: `s${i}`, cwd: `/w/p${i % 50}`, status: i < 30 ? 'active' : 'ended' }))
    const t0 = performance.now()
    const m = buildSidebar({ projects: many, sessions, permissions: new Set(), costs: new Map(), openSessions: new Set() })
    expect(performance.now() - t0).toBeLessThan(50)
    expect(m.projects.reduce((n, p) => n + p.live, 0)).toBe(30)
  })

  it('keeps the main checkout as a row beside a linked worktree, with nothing running in either', () => {
    const p: Project = {
      id: 'r', root: '/r', name: 'r', kind: 'repo', branch: 'feat/x', changed: 6,
      worktrees: [{ name: 'fix', path: '/r/.caprock-worktrees/fix', branch: 'fix', changed: 1 }],
    }
    const m = buildSidebar({ projects: [p], sessions: [], permissions: new Set(), costs: new Map(), openSessions: new Set() })
    expect(m.projects[0]!.worktrees.map((w) => [w.key, w.branch, w.changed])).toEqual([['main', 'feat/x', 6], ['fix', 'fix', 1]])
  })
})
