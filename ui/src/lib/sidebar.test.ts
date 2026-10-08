import { describe, expect, it } from 'vitest'
import type { SessionSummary } from './api'
import type { Project } from './projects'
import { buildSidebar, groupProjects, OTHER_FOLDERS_ID, QUIET_MS } from './sidebar'

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
  it('folds a project with nothing running and no activity for a week under Quiet, keeping the order', () => {
    const nodes = model([proj('fresh', 1), proj('old', 30), proj('older', 60), proj('edge', 6.9)])
    const g = groupProjects(nodes, { hidden: new Set(), now })
    expect(ids(g.shown)).toEqual(['fresh', 'edge'])
    expect(ids(g.quiet)).toEqual(['old', 'older'])
    expect(g.hidden).toEqual([])
    expect(QUIET_MS).toBe(7 * day)
  })

  it('keeps a quiet project listed while something runs in it, while a tab points at it, when it is in front, or pinned', () => {
    const nodes = model(
      [proj('running', 30), proj('tab', 30), proj('front', 30), proj('pinned', 30, { pinned: true }), proj('quiet', 30)],
      [
        sess({ session_id: 'r', cwd: '/running', last_event_at: now - 30 * day }),
        sess({ session_id: 't', cwd: '/tab', status: 'ended', last_event_at: now - 30 * day }),
      ],
      new Set(['t']),
    )
    const g = groupProjects(nodes, { hidden: new Set(), activeProjectId: 'front', now })
    expect(ids(g.shown).sort()).toEqual(['front', 'pinned', 'running', 'tab'])
    expect(ids(g.quiet)).toEqual(['quiet'])
  })

  it('a project just added is not quiet, however old its last session', () => {
    const nodes = model([proj('new', 90, { added_at: now - day })])
    expect(ids(groupProjects(nodes, { hidden: new Set(), now }).shown)).toEqual(['new'])
  })

  it('puts hidden projects under Hidden, quiet or not, and shows them while they are busy or in front', () => {
    const nodes = model(
      [proj('fresh', 1), proj('old', 30), proj('busy', 1), proj('front', 1)],
      [sess({ session_id: 'w', cwd: '/busy', activity: { phrase: '', at: new Date(now - 60_000).toISOString(), health: 'waiting-on-you' } })],
    )
    const g = groupProjects(nodes, { hidden: new Set(['fresh', 'old', 'busy', 'front']), activeProjectId: 'front', now })
    expect(ids(g.hidden).sort()).toEqual(['fresh', 'old'])
    expect(ids(g.shown).sort()).toEqual(['busy', 'front'])
    expect(g.quiet).toEqual([])
  })

  it('never folds Other folders', () => {
    const nodes = model([], [sess({ session_id: 'x', cwd: '/elsewhere', status: 'ended', last_event_at: 1 })], new Set(['x']))
    const g = groupProjects(nodes, { hidden: new Set([OTHER_FOLDERS_ID]), now })
    expect(ids(g.shown)).toEqual([OTHER_FOLDERS_ID])
  })
})
