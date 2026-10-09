import { describe, expect, it } from 'vitest'
import type { SessionSummary } from './api'
import type { Project } from './projects'
import { buildSidebar, groupProjects, OTHER_FOLDERS_ID } from './sidebar'

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

const now = Date.parse('2026-10-08T12:00:00Z')
const day = 24 * 60 * 60 * 1000
const proj = (id: string, lastDaysAgo: number, extra: Partial<Project> = {}): Project =>
  ({ id, root: `/${id}`, name: id, kind: 'repo', last_activity: now - lastDaysAgo * day, ...extra })

function model(projects: Project[], sessions: SessionSummary[] = [], openSessions: Set<string> = new Set()) {
  return buildSidebar({ projects, sessions, permissions: new Set(), costs: new Map(), openSessions, now }).projects
}
const ids = (ns: { project: { id: string } }[]) => ns.map((n) => n.project.id)

describe('grouping the sidebar projects', () => {
  it('lists what is in play — running, waiting, a tab open, pinned, in front — and folds the rest under More projects, in order', () => {
    const nodes = model(
      [proj('running', 30), proj('tab', 30), proj('file', 30), proj('front', 30), proj('pinned', 30, { pinned: true }), proj('fresh', 0), proj('old', 60)],
      [
        sess({ session_id: 'r', cwd: '/running', last_event_at: now - 30 * day }),
        sess({ session_id: 't', cwd: '/tab', status: 'ended', last_event_at: now - 30 * day }),
      ],
      new Set(['t']),
    )
    // A file tab holds no session: the project counts as in play through its tab.
    const g = groupProjects(nodes, { hidden: new Set(), activeProjectId: 'front', tabbed: new Set(['file']) })
    expect(ids(g.shown).sort()).toEqual(['file', 'front', 'pinned', 'running', 'tab'])
    // Recent activity alone is not work in progress.
    expect(ids(g.more)).toEqual(['fresh', 'old'])
    expect(g.hidden).toEqual([])
  })

  it('puts hidden projects under Hidden, and shows them while they are busy or in front', () => {
    const nodes = model(
      [proj('fresh', 1), proj('old', 30), proj('busy', 1), proj('front', 1)],
      [sess({ session_id: 'w', cwd: '/busy', activity: { phrase: '', at: new Date(now - 60_000).toISOString(), health: 'waiting-on-you' } })],
    )
    const g = groupProjects(nodes, { hidden: new Set(['fresh', 'old', 'busy', 'front']), activeProjectId: 'front' })
    expect(ids(g.hidden).sort()).toEqual(['fresh', 'old'])
    expect(ids(g.shown).sort()).toEqual(['busy', 'front'])
    expect(g.more).toEqual([])
  })

  it('never folds Other folders', () => {
    const nodes = model([], [sess({ session_id: 'x', cwd: '/elsewhere', status: 'ended', last_event_at: 1 })], new Set(['x']))
    const g = groupProjects(nodes, { hidden: new Set([OTHER_FOLDERS_ID]) })
    expect(ids(g.shown)).toEqual([OTHER_FOLDERS_ID])
  })
})
