import { describe, expect, it } from 'vitest'
import { addLabel, addRequests, defaultPicked, editedRepos, foundNote, mergeCandidates, worthAsking } from './multirepo'
import { matchLength, memberOf, worktreeKeyOf, type Project, type RepoInfo } from './projects'
import { buildSidebar } from './sidebar'
import type { SessionSummary } from './api'

const repo = (path: string, name: string): RepoInfo => ({ path, name, exists: true, live: 0, waiting: 0, total: 0, cost_today: 0, branch: 'main' })

describe('the add sheet question', () => {
  it('asks only for a folder outside a repository that holds two or more', () => {
    expect(worthAsking(null)).toBe(false)
    expect(worthAsking({ root: '/w', repos: [{ path: '/w/a', name: 'a' }] })).toBe(false)
    expect(worthAsking({ root: '/w/a/src', repo_root: '/w/a', repos: [] })).toBe(false)
    expect(worthAsking({ root: '/w', repos: [{ path: '/w/a', name: 'a' }, { path: '/w/b', name: 'b' }] })).toBe(true)
  })

  it('ticks every repository except one already in a multi-repo project', () => {
    expect(defaultPicked([{ path: '/w/a', name: 'a' }, { path: '/w/b', name: 'b', member_of: 3 }, { path: '/w/c', name: 'c', project_id: 2 }])).toEqual(['/w/a', '/w/c'])
    expect(foundNote({ path: '/w/b', name: 'b', member_of: 3 })).toBe('in another project')
    expect(foundNote({ path: '/w/c', name: 'c', project_id: 2, project_name: 'cee' })).toBe('listed as cee')
  })

  it('turns the choice into requests', () => {
    expect(addRequests('one', '/w', ['/w/a', '/w/b'])).toEqual([{ path: '/w', repos: ['/w/a', '/w/b'] }])
    expect(addRequests('separate', '/w', ['/w/a', '/w/b'])).toEqual([{ path: '/w/a' }, { path: '/w/b' }])
    expect(addRequests('one', '/w', ['/w/a'])).toMatch(/two repositories or more/)
    expect(addRequests('separate', '/w', [])).toMatch(/Tick/)
    expect(addLabel('one', 3)).toBe('Add 1 project')
    expect(addLabel('separate', 3)).toBe('Add 3 projects')
  })
})

describe('the editor', () => {
  it('keeps the ticked members and adds the ticked found ones', () => {
    const found = [{ path: '/w/c', name: 'c' }, { path: '/w/d', name: 'd' }]
    expect(editedRepos(['/w/a', '/w/b'], found, new Set(['/w/a', '/w/d']))).toEqual(['/w/a', '/w/d'])
  })

  it('offers repository projects to merge in, never itself or another multi-repo project', () => {
    const multi: Project = { id: '1', root: '/w', name: 'w', kind: 'folder', repos: [repo('/w/a', 'a')] }
    const all: Project[] = [
      multi,
      { id: '2', root: '/x', name: 'x', kind: 'repo' },
      { id: '3', root: '/y', name: 'y', kind: 'folder' },
      { id: '4', root: '/z', name: 'z', kind: 'folder', repos: [repo('/z/q', 'q')] },
    ]
    expect(mergeCandidates(multi, all).map((p) => p.id)).toEqual(['2'])
  })
})

describe('a session in a multi-repo project', () => {
  const multi: Project = { id: '1', root: '/w', name: 'w', kind: 'folder', repos: [repo('/w/api', 'api'), { ...repo('/elsewhere/web', 'web'), branch: 'feat/x', changed: 2 }] }
  const plain: Project = { id: '2', root: '/elsewhere', name: 'elsewhere', kind: 'folder' }
  const sess = (id: string, cwd: string, repo_root = ''): SessionSummary => ({
    session_id: id, cwd, repo_root, status: 'active', last_event_at: 1, kind: 'agent', owned: true,
  }) as unknown as SessionSummary

  it('belongs to the project whose member holds it, even outside its folder', () => {
    expect(matchLength(sess('a', '/elsewhere/web/src', '/elsewhere/web'), multi)).toBeGreaterThan(matchLength(sess('a', '/elsewhere/web/src', '/elsewhere/web'), plain))
    expect(memberOf('/w/api/x', multi)?.name).toBe('api')
    expect(worktreeKeyOf(sess('a', '/w/api/x'), multi)).toBe('repo:/w/api')
    expect(worktreeKeyOf(sess('a', '/w'), multi)).toBe('main')
  })

  it('is listed under its member repository with that repository’s branch', () => {
    const model = buildSidebar({
      projects: [multi, plain],
      sessions: [sess('s1', '/elsewhere/web/src', '/elsewhere/web'), sess('s2', '/w/api')],
      permissions: new Set(), costs: new Map(), openSessions: new Set(),
    })
    const node = model.projects.find((n) => n.project.id === '1')!
    const web = node.worktrees.find((w) => w.key === 'repo:/elsewhere/web')
    expect(web?.branch).toBe('feat/x')
    expect(web?.changed).toBe(2)
    expect(web?.repo).toBe('web')
    expect(node.worktrees.some((w) => w.sessions.some((x) => x.session.session_id === 's2'))).toBe(true)
    expect(model.projects.find((n) => n.project.id === '2')?.live ?? 0).toBe(0)
  })
})
