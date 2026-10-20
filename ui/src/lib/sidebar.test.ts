import { describe, expect, it } from 'vitest'
import type { SessionSummary } from './api'
import type { Project } from './projects'
import { buildSidebar, groupProjects, OTHER_FOLDERS_ID, rowHidden, sessionTitle } from './sidebar'

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
/** Hidden by hand at `at` (the epoch by default: before anything here happened). */
const hid = (list: string[], at = 0) => new Map(list.map((id) => [id, at]))

describe('grouping the sidebar projects', () => {
  it('above eight projects, lists what is in play — running, waiting, a tab open, pinned, in front — and folds the rest under More projects', () => {
    const nodes = model(
      [proj('running', 30), proj('tab', 30), proj('file', 30), proj('front', 30), proj('pinned', 30, { pinned: true }), proj('fresh', 0), proj('old', 60), proj('quiet', 9), proj('idle', 9)],
      [
        sess({ session_id: 'r', cwd: '/running', last_event_at: now - 30 * day }),
        sess({ session_id: 't', cwd: '/tab', status: 'ended', last_event_at: now - 30 * day }),
      ],
      new Set(['t']),
    )
    // A file tab holds no session: the project counts as in play through its tab.
    const g = groupProjects(nodes, { hidden: new Map(), activeProjectId: 'front', tabbed: new Set(['file']) })
    // Pinned first, then by name.
    expect(ids(g.shown)).toEqual(['pinned', 'file', 'front', 'running', 'tab'])
    // Recent activity alone is not work in progress.
    expect(ids(g.more)).toEqual(['fresh', 'idle', 'old', 'quiet'])
    expect(g.hidden).toEqual([])
  })

  it('folds nothing with eight projects or fewer', () => {
    const nodes = model([proj('gamma', 0), proj('alpha', 60), proj('beta', 30)])
    const g = groupProjects(nodes, { hidden: new Map(), activeProjectId: 'gamma' })
    expect(ids(g.shown)).toEqual(['alpha', 'beta', 'gamma'])
    expect(g.more).toEqual([])
    const eight = model(Array.from({ length: 8 }, (_, i) => proj(`p${i}`, i)))
    expect(groupProjects(eight, { hidden: new Map() }).more).toEqual([])
    const nine = model(Array.from({ length: 9 }, (_, i) => proj(`p${i}`, i)))
    expect(groupProjects(nine, { hidden: new Map() }).more).toHaveLength(9)
  })

  it('keeps one order whatever is picked or active: pinned first, then by name, Other folders last', () => {
    const projects = [proj('gamma', 0), proj('Alpha', 60), proj('beta', 30), proj('zed', 90, { pinned: true })]
    const busy = model(projects, [
      sess({ session_id: 'g', cwd: '/gamma', last_event_at: now }),
      sess({ session_id: 'x', cwd: '/elsewhere', last_event_at: now }),
    ])
    const order = ['zed', 'Alpha', 'beta', 'gamma', OTHER_FOLDERS_ID]
    for (const front of ['gamma', 'Alpha', 'beta', undefined]) {
      expect(ids(groupProjects(busy, { hidden: new Map(), activeProjectId: front }).shown)).toEqual(order)
    }
    // Activity moving to another project moves nothing.
    const later = model(projects, [
      sess({ session_id: 'a', cwd: '/Alpha', last_event_at: now }),
      sess({ session_id: 'x', cwd: '/elsewhere', last_event_at: now }),
    ])
    expect(ids(groupProjects(later, { hidden: new Map(), activeProjectId: 'Alpha' }).shown)).toEqual(order)
  })

  it('puts hidden projects under Hidden, the one in front included, and brings one out for a turn that ended after it was hidden', () => {
    const nodes = model(
      [proj('fresh', 1), proj('old', 30), proj('busy', 1), proj('front', 1)],
      [sess({ session_id: 'w', cwd: '/busy', activity: { phrase: '', at: new Date(now - 60_000).toISOString(), health: 'waiting-on-you' } })],
    )
    const g = groupProjects(nodes, { hidden: hid(['fresh', 'old', 'busy', 'front']), activeProjectId: 'front' })
    expect(ids(g.hidden).sort()).toEqual(['fresh', 'front', 'old'])
    expect(ids(g.shown)).toEqual(['busy'])
    expect(g.more).toEqual([])
  })

  it('keeps a hidden project under Hidden while it only runs, and brings it out when it asks', () => {
    const nodes = model(
      [proj('run', 1), proj('ask', 1)],
      [
        sess({ session_id: 'r', cwd: '/run', activity: { phrase: '', at: new Date(now - 60_000).toISOString(), health: 'working' } }),
        sess({ session_id: 'a', cwd: '/ask', activity: { phrase: '', at: new Date(now - 60_000).toISOString(), health: 'waiting-on-you' } }),
      ],
    )
    const g = groupProjects(nodes, { hidden: hid(['run', 'ask']) })
    expect(ids(g.hidden)).toEqual(['run'])
    expect(ids(g.shown)).toEqual(['ask'])
  })

  // The owner's bug on 0.112.0 (2026-10-13): Hide did nothing on a project
  // whose agent had finished its turn, or on the one in front, because both
  // were forced back into view the moment they were hidden.
  it('hides a project whose turn had already ended when Hide was pressed, and one in front', () => {
    const turnEnded = now - 60_000
    const nodes = model(
      [proj('done', 1), proj('front', 1)],
      [
        sess({ session_id: 'd', cwd: '/done', activity: { phrase: '', at: new Date(turnEnded).toISOString(), health: 'waiting-on-you' } }),
        sess({ session_id: 'f', cwd: '/front', activity: { phrase: '', at: new Date(turnEnded).toISOString(), health: 'working' } }),
      ],
    )
    expect(nodes.find((n) => n.project.id === 'done')!.waiting).toBe(1)
    // Hide closes the project's tabs (Sidebar), so nothing is tabbed here.
    const g = groupProjects(nodes, { hidden: hid(['done', 'front'], now), activeProjectId: 'front' })
    expect(ids(g.hidden)).toEqual(['done', 'front'])
    expect(ids(g.shown)).toEqual([])
  })

  // The owner's bug on 2026-10-16 (translated): "the tabs in the top strip
  // don't match what's on the left" — a hidden project opened again from
  // More… had ⌘3 in the strip and no row in the sidebar.
  it('lists a hidden project while a tab shows it, and hides it again when the last tab closes', () => {
    const nodes = model(
      [proj('bloq', 1), proj('file', 1), proj('quiet', 1)],
      [sess({ session_id: 'b', cwd: '/bloq', activity: { phrase: '', at: new Date(now - 60_000).toISOString(), health: 'working' } })],
      new Set(['b']),
    )
    // A session tab, and a tab that holds no session (a file): both count.
    const g = groupProjects(nodes, { hidden: hid(['bloq', 'file', 'quiet'], now), tabbed: new Set(['bloq', 'file']) })
    expect(ids(g.shown)).toEqual(['bloq', 'file'])
    expect(ids(g.hidden)).toEqual(['quiet'])
    // The mark is kept: with no tab left it is under Hidden again.
    const closed = model([proj('bloq', 1)], [sess({ session_id: 'b', cwd: '/bloq', activity: { phrase: '', at: new Date(now - 60_000).toISOString(), health: 'working' } })])
    expect(ids(groupProjects(closed, { hidden: hid(['bloq'], now) }).hidden)).toEqual(['bloq'])
  })

  it('lists hidden Outside projects while one of its sessions has a tab', () => {
    const nodes = model([], [sess({ session_id: 'x', cwd: '/elsewhere' })], new Set(['x']))
    expect(ids(groupProjects(nodes, { hidden: hid([OTHER_FOLDERS_ID]) }).shown)).toEqual([OTHER_FOLDERS_ID])
  })

  it('brings a hidden project out for a permission prompt, whenever it was hidden', () => {
    const projects = [proj('ask', 1)]
    const sessions = [sess({ session_id: 'p', cwd: '/ask', activity: { phrase: '', at: new Date(now - 60 * 60_000).toISOString(), health: 'working' } })]
    const nodes = buildSidebar({ projects, sessions, permissions: new Set(['p']), costs: new Map(), openSessions: new Set(), now }).projects
    expect(ids(groupProjects(nodes, { hidden: hid(['ask'], now) }).shown)).toEqual(['ask'])
  })

  it('never folds Other folders into More, but hides it when asked (owner, 2026-10-11)', () => {
    const nodes = model([], [sess({ session_id: 'x', cwd: '/elsewhere', status: 'ended', last_event_at: 1 })], new Set(['x']))
    expect(ids(groupProjects(nodes, { hidden: new Map() }).shown)).toEqual([OTHER_FOLDERS_ID])
    // With its tab closed (hiding closes it): under Hidden.
    const closed = model([], [sess({ session_id: 'x', cwd: '/elsewhere' })])
    const g = groupProjects(closed, { hidden: hid([OTHER_FOLDERS_ID]) })
    expect(ids(g.shown)).toEqual([])
    expect(ids(g.hidden)).toEqual([OTHER_FOLDERS_ID])
  })
})

describe('a session row: what waits, and hiding it', () => {
  const at = (msAgo: number) => new Date(now - msAgo).toISOString()
  const build = (permissions: string[] = []) => buildSidebar({
    projects: [proj('r', 0)],
    sessions: [
      sess({ session_id: 'turn', cwd: '/r', activity: { phrase: '', at: at(60_000), health: 'waiting-on-you' } }),
      sess({ session_id: 'old', cwd: '/r', activity: { phrase: '', at: at(2 * day), health: 'waiting-on-you' } }),
      sess({ session_id: 'ask', cwd: '/r', activity: { phrase: '', at: at(2 * day), health: 'working' } }),
      sess({ session_id: 'busy', cwd: '/r' }),
    ],
    permissions: new Set(permissions),
    costs: new Map(),
    openSessions: new Set(),
    now,
  })
  const rows = (m: ReturnType<typeof build>) => new Map(m.projects[0]!.worktrees.flatMap((w) => w.sessions).map((x) => [x.session.session_id, x]))

  it('marks a session waiting now, says when it began, and tells a permission prompt apart', () => {
    const r = rows(build(['ask']))
    expect(r.get('turn')).toMatchObject({ waiting: true, asks: false, waitingSince: now - 60_000 })
    expect(r.get('old')).toMatchObject({ waiting: false, waitingSince: undefined })
    expect(r.get('ask')).toMatchObject({ waiting: true, asks: true })
    expect(r.get('busy')).toMatchObject({ waiting: false })
  })

  it('keeps a hidden row hidden until it next waits; one that asks always shows', () => {
    const r = rows(build(['ask']))
    expect(rowHidden(r.get('busy')!, new Map())).toBe(false)
    expect(rowHidden(r.get('busy')!, new Map([['busy', now]]))).toBe(true)
    // Waiting since before it was hidden: stays hidden. Since after: back.
    expect(rowHidden(r.get('turn')!, new Map([['turn', now - 1000]]))).toBe(true)
    expect(rowHidden(r.get('turn')!, new Map([['turn', now - 10 * 60_000]]))).toBe(false)
    expect(rowHidden(r.get('ask')!, new Map([['ask', now]]))).toBe(false)
  })

  it('never hides a row with a tab open: every tab in the strip has a row (owner, 2026-10-16)', () => {
    const busy = rows(build()).get('busy')!
    expect(rowHidden({ ...busy, open: true }, new Map([['busy', now]]))).toBe(false)
    expect(rowHidden({ ...busy, open: false }, new Map([['busy', now]]))).toBe(true)
  })
})

// Owner, 2026-10-20: a quick chat whose tab was lost stayed under "Running, no
// tab" for as long as its process ran - every chat "waits on you" once it has
// answered. Now it is listed while it works or asks, and for CHAT_LINGER_MS after.
describe('a quick chat with no tab', () => {
  const chat = (p: Partial<SessionSummary>) => sess({ session_id: 'c', cwd: '/data/chats/2026-10-19-094012', git_branch: '', ...p })
  const listed = (s: SessionSummary, permissions = new Set<string>(), open = new Set<string>()) =>
    buildSidebar({ projects: [], sessions: [s], permissions, costs: new Map(), openSessions: open, now })
      .projects.flatMap((n) => n.worktrees.flatMap((w) => w.sessions)).length > 0
  const at = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString()

  it('is listed while it works', () => {
    expect(listed(chat({ activity: { phrase: 'responding', at: at(60), health: 'working' } }))).toBe(true)
  })

  it('is listed while it asks: a permission prompt or a question', () => {
    expect(listed(chat({ activity: { phrase: 'waiting for approval', at: at(60), health: 'waiting-on-you', tool: 'Bash' } }))).toBe(true)
    expect(listed(chat({ activity: { phrase: 'waiting for your answer', at: at(60), health: 'waiting-on-you' } }))).toBe(true)
    expect(listed(chat({ activity: { phrase: 'waiting for you', at: at(60), health: 'waiting-on-you' } }), new Set(['c']))).toBe(true)
  })

  it('is listed for ten minutes after its answer, then only on the Chats screen', () => {
    const answered = (mins: number) => chat({ activity: { phrase: 'waiting for you', at: at(mins), health: 'waiting-on-you' } })
    expect(listed(answered(3))).toBe(true)
    expect(listed(answered(11))).toBe(false)
    expect(listed(chat({ activity: { phrase: '', at: at(30), health: 'idle' }, last_event_at: now - 30 * 60_000 }))).toBe(false)
  })

  it('is listed, idle or not, while a tab shows it; never once ended', () => {
    expect(listed(chat({ activity: { phrase: 'waiting for you', at: at(600), health: 'waiting-on-you' } }), new Set(), new Set(['c']))).toBe(true)
    expect(listed(chat({ status: 'ended', activity: { phrase: '', at: at(1), health: 'ended' } }))).toBe(false)
  })

  it('is called by what it is about once it has a title, else "Quick chat · model"', () => {
    expect(sessionTitle(chat({ model_display: 'Opus 5.5' }))).toBe('Quick chat · Opus 5.5')
    expect(sessionTitle(chat({ model_display: 'Opus 5.5', title: 'Monads, explained' }))).toBe('Monads, explained')
    expect(sessionTitle(chat({ model_display: 'Opus 5.5', title: 'Monads', name: 'Mine' }))).toBe('Mine')
  })
})
