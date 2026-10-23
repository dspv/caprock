/**
 * The Work board's arithmetic and words (.ai/04-ui.md § Work): every piece of
 * work on the machine on its way to a release, one row each (owner,
 * 2026-10-15, translated: "exactly this I want to see on the project-manager
 * page", of a status report that listed RELEASE / IN WORK / NEXT with a bar
 * per item). Pure.
 *
 * A row is a repository and branch at its furthest stage — agent → PR → CI →
 * merged — with the live sessions working on it attached. Its bar is filled
 * to the stage it is in, and a merge fills it: released is not a step but a
 * quiet word after the bar (owner, 2026-10-20, translated: the final status
 * should be merged — a grey last block read as unfinished, or closed). The
 * stage is a fact read from GitHub and Caprock's own record, never a guess
 * at how far the work is. The only estimates are those
 * with a measured basis, each saying what it is made of (rule 6, RISK-08): a
 * running turn's range from the project's past turns, a CI run against the
 * repository's median, merge → release against the median lag, the gap
 * between releases against the median gap. Never a task's completion time,
 * a pull request's merge countdown, or a clock time for the next release.
 */
import type { SessionCIStats, Work, WorkPR, WorkQueued, WorkRepo, WorkSession, WorkTask } from './api'
import type { BranchPR } from './branches'
import { asBoard, type BoardCard, type BoardFlow, type PRBoard, type ShipsBy } from './prboard'
import { basisLabel, etaRange } from './queueboard'
import { spanText } from './prstats'
import { href } from './router'

/** The bar's four steps, in order: a merge fills the bar. */
export const STEPS = ['agent', 'PR', 'CI', 'merged'] as const

/** Where a row stands: planned (nothing started), the four steps, then released (the bar full, its tag said after it). */
export type Stage = 'planned' | 'agent' | 'pr' | 'ci' | 'merged' | 'released'

/** The Kanban's columns. */
export type Lane = 'planned' | 'work' | 'review' | 'merged' | 'released'

/** The list's groups: ready and merged pull requests are the next release. */
export type Group = 'release' | 'review' | 'work' | 'planned' | 'released'

export const LANES: { key: Lane; label: string; note: string }[] = [
  { key: 'planned', label: 'Planned', note: 'Tasks not started and messages waiting for an agent’s turn to end' },
  { key: 'work', label: 'In work', note: 'Agents working with no pull request yet, and tasks in progress' },
  { key: 'review', label: 'In review', note: 'Open pull requests: a draft, CI running or red, a conflict, ready to merge' },
  { key: 'merged', label: 'Merged · waiting', note: 'Merged, in no published release yet' },
  { key: 'released', label: 'Released', note: 'Shipped in a published release, newest first' },
]

export const GROUPS: { key: Group; label: string; note: string }[] = [
  { key: 'release', label: 'Next release', note: 'Merged and waiting for a release, and pull requests ready to merge' },
  { key: 'review', label: 'In review', note: 'Open pull requests: CI running, red, a conflict, or a draft' },
  { key: 'work', label: 'In work', note: 'Agents working with no pull request yet, and tasks in progress' },
  { key: 'planned', label: 'Planned', note: 'Tasks not started and messages waiting for an agent’s turn to end' },
  { key: 'released', label: 'Released', note: 'Shipped in a published release, newest first' },
]

/** A session at its prompt this long is folded into "N idle". */
export const IDLE_MS = 30 * 60_000
/** A merge → release median needs this many merges behind it before it is said. */
export const MIN_LAG_COUNT = 3
/** A release-gap median needs this many gaps behind it before it is said. */
export const MIN_GAPS = 3
/** How many repositories' Pipeline answers the page reads: the ones with an agent running first. */
export const STATS_REPOS = 4
/** How many released rows the list keeps, folded. */
export const RELEASED_SHOWN = 10

/** One row of the board. */
export interface WorkItem {
  key: string
  kind: 'pr' | 'session' | 'task' | 'queued'
  repo?: { root: string; name: string }
  title: string
  branch?: string
  pr?: { number: number; url: string; title?: string; created_at?: number; merged_at?: number }
  card?: BoardCard
  /** The live sessions working on it. */
  sessions: WorkSession[]
  task?: WorkTask
  queued?: WorkQueued
  stage: Stage
  /** Steps filled on the bar, 0–4: the stage's place, not a guess at progress. A merge, released or not, fills it. */
  fill: number
  /** A quiet word after the stage word: *not released* on a merge waiting for a release, where the repository cuts them. */
  note?: { text: string; title: string }
  /** The CI step is red: a failed check, a conflict, changes requested; or a failed task. */
  red: boolean
  /** The CI step is running. */
  running: boolean
  /** The stage in a word or two. */
  word: string
  lane: Lane
  group: Group
  /** A session on it waits on the person: a permission prompt or a question; or a task that needs them. */
  needsYou: boolean
  working: boolean
  /** When the work started: its first session, else the pull request's opening. */
  startedAt?: number
  /** Agent cost at API list price; undefined when none was recorded. */
  costUsd?: number
  /**
   * A session's row whose recorded pull requests are all done — the newest
   * closed without a merge, or merged — so it is no longer on one: said as
   * *PR closed* / *PR merged*, never *no PR yet*.
   */
  donePR?: { number: number; state: 'closed' | 'merged' }
}

export interface WorkBoard {
  items: WorkItem[]
  /** Sessions at their prompt for over IDLE_MS with no pull request: one "N idle" line. */
  idle: WorkItem[]
  counts: { live: number; building: number; onPRs: number; needsYou: number }
}

const OPEN_STAGES = new Set(['draft', 'open', 'fix', 'ready'])
const STAGE_RANK: Record<Stage, number> = { planned: 0, agent: 1, pr: 2, ci: 3, merged: 4, released: 5 }

function nameOf(root: string): string {
  return root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root
}

/** The stage, bar, word, lane and group of a pull request, from its board card or its own state. */
export function prStage(card: Pick<BoardCard, 'stage' | 'ci' | 'why' | 'release'> | undefined, state: 'open' | 'merged' | 'closed', draft?: boolean, ships?: ShipsBy): Pick<WorkItem, 'stage' | 'fill' | 'red' | 'running' | 'word' | 'lane' | 'group' | 'note'> {
  const s = card?.stage ?? (state === 'merged' ? 'merged' : draft ? 'draft' : 'open')
  const base = { red: false, running: false }
  switch (s) {
    case 'draft': return { ...base, stage: 'pr', fill: 2, word: 'draft', lane: 'review', group: 'review' }
    case 'open':
      if (card?.ci === 'running') return { ...base, stage: 'ci', fill: 3, running: true, word: 'CI running', lane: 'review', group: 'review' }
      return { ...base, stage: 'pr', fill: 2, word: 'PR open', lane: 'review', group: 'review' }
    case 'fix': {
      const word = card?.why === 'conflict' ? 'conflict' : card?.why === 'changes_requested' ? 'changes requested' : 'CI red'
      return { ...base, stage: 'ci', fill: 3, red: true, word, lane: 'review', group: 'review' }
    }
    case 'ready': return { ...base, stage: 'ci', fill: 3, word: card?.ci === 'none' ? 'ready · no checks' : 'ready', lane: 'review', group: 'release' }
    case 'merged': {
      const note = ships === 'release' ? { note: { text: 'not released', title: 'Merged, in no published release yet: it ships with the next one.' } } : {}
      return { ...base, stage: 'merged', fill: 4, word: 'merged', lane: 'merged', group: 'release', ...note }
    }
    case 'released': return { ...base, stage: 'released', fill: 4, word: card?.release ? `in ${card.release}` : 'released', lane: 'released', group: 'released' }
  }
}

/**
 * A row's title that is only its number ("#796": a pull request recorded with
 * no title). The number is drawn once, as the title, never "#796 #796"
 * (owner, 2026-10-24).
 */
export const titleIsNumber = (n: number | undefined, title: string | undefined) => n !== undefined && (title ?? '').trim() === `#${n}`

/**
 * The pull request a session counts toward: the newest one recorded on it
 * that is not done — `gone` (closed unmerged, or merged and off the board,
 * as GitHub says) and the ones its own command closed unmerged are skipped
 * (owner, 2026-10-24: a closed pull request drawn as "PR open" in flight).
 */
export function newestPR(prs: readonly WorkPR[], gone?: (n: number) => boolean): WorkPR | undefined {
  let best: WorkPR | undefined
  for (const p of prs) {
    if ((p.closed_at && !p.merged_at) || gone?.(p.number)) continue
    if (!best || (p.opened_at ?? 0) > (best.opened_at ?? 0) || ((p.opened_at ?? 0) === (best.opened_at ?? 0) && p.number > best.number)) best = p
  }
  return best
}

/** A session waits on the person. */
export const needsYouState = (s: Pick<WorkSession, 'state'>) => s.state === 'permission' || s.state === 'question'

/** Whether a session counts as idle: at its prompt, no work for IDLE_MS. */
export function isIdle(s: WorkSession, now: number): boolean {
  return s.state === 'at_prompt' && now - (s.worked_at ?? s.started_at) > IDLE_MS
}

/** Of two pull requests on one branch, the one its row shows: an open one, else the furthest along, else the newer. */
function better(a: WorkItem, b: WorkItem): WorkItem {
  const open = (x: WorkItem) => (x.card ? OPEN_STAGES.has(x.card.stage) : x.stage === 'pr' || x.stage === 'ci')
  if (open(a) !== open(b)) return open(a) ? a : b
  if (STAGE_RANK[a.stage] !== STAGE_RANK[b.stage]) return STAGE_RANK[a.stage] > STAGE_RANK[b.stage] ? a : b
  return (a.pr?.number ?? 0) >= (b.pr?.number ?? 0) ? a : b
}

/** The task's own row, when nothing it works on is listed. */
function taskStage(t: WorkTask): Pick<WorkItem, 'stage' | 'fill' | 'red' | 'running' | 'word' | 'lane' | 'group' | 'needsYou'> | undefined {
  const base = { red: false, running: false, needsYou: false }
  switch (t.status) {
    case 'inbox': return { ...base, stage: 'planned', fill: 0, word: 'planned', lane: 'planned', group: 'planned' }
    case 'assigned': return { ...base, stage: 'planned', fill: 0, word: 'assigned', lane: 'planned', group: 'planned' }
    case 'in_progress': return { ...base, stage: 'agent', fill: 1, word: 'in progress', lane: 'work', group: 'work' }
    case 'verifying': return { ...base, stage: 'agent', fill: 1, word: 'verifying', lane: 'work', group: 'work' }
    case 'needs_you': return { ...base, stage: 'agent', fill: 1, word: 'needs you', lane: 'work', group: 'work', needsYou: true }
    case 'failed': return { ...base, stage: 'agent', fill: 1, red: true, word: 'failed', lane: 'work', group: 'work' }
  }
  return undefined
}

/** A queued message's first line, as a title. */
export function queuedTitle(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 120 ? `${line.slice(0, 119)}…` : line || '(empty message)'
}

/**
 * The rows: pull requests from each repository's Pipeline answer, live
 * sessions attached to theirs (a session with none is its own row), tasks and
 * queued messages. `stats` holds the answers read, by repository root.
 */
export function buildWork(work: Work, stats: ReadonlyMap<string, SessionCIStats | undefined>, now: number): WorkBoard {
  const items = new Map<string, WorkItem>()
  // Per repository: its rows by head branch and by number, for attaching.
  const byBranch = new Map<string, WorkItem>()
  const byNumber = new Map<string, WorkItem>()
  const repoName = new Map((work.repos ?? []).map((r) => [r.root, r.name]))
  const named = (root: string) => ({ root, name: repoName.get(root) || nameOf(root) })

  const put = (it: WorkItem) => {
    items.set(it.key, it)
    if (it.repo && it.pr) byNumber.set(`${it.repo.root}\0${it.pr.number}`, it)
    if (it.repo && it.branch) byBranch.set(`${it.repo.root}\0${it.branch}`, it)
  }

  // The pull requests GitHub lists as done with no row here: closed
  // unmerged, or merged and off the board. A session's record of one never
  // brings it back as open.
  const gone = new Map<string, 'closed' | 'merged'>()

  // 1. Pull requests, one row per repository and branch.
  for (const [root, st] of stats) {
    if (!st) continue
    const board = asBoard(st.board)
    const cards = new Map((board?.cards ?? []).map((c) => [c.number, c]))
    for (const p of st.prs ?? []) {
      if (p.state === 'closed') { gone.set(`${root}\0${p.number}`, 'closed'); continue }
      const card = cards.get(p.number)
      // A merged one the board does not hold is older than its window: done and gone.
      if (p.state === 'merged' && !card) { gone.set(`${root}\0${p.number}`, 'merged'); continue }
      const it = prItem(named(root), p, card, board?.ships_by)
      const key = it.key
      const had = items.get(key)
      if (had) { const keep = better(had, it); if (keep === had) continue }
      put(it)
    }
  }

  // 2. Sessions: onto their newest pull request, else their branch's, else a row of their own.
  for (const s of work.sessions ?? []) {
    const root = s.repo_root || ''
    let target: WorkItem | undefined
    const newest = newestPR(s.prs ?? [], (n) => gone.has(`${root}\0${n}`))
    if (newest && root) {
      target = byNumber.get(`${root}\0${newest.number}`)
      if (!target) {
        // Not in a Pipeline answer read here (none read for that repository, or past its list): the session's record.
        const pr = { number: newest.number, url: newest.url, title: newest.title, created_at: newest.opened_at, merged_at: newest.merged_at }
        target = {
          key: `${root}\0#${newest.number}`, kind: 'pr', repo: named(root), title: newest.title || `#${newest.number}`, pr,
          sessions: [], needsYou: false, working: false, startedAt: newest.opened_at,
          ...prStage(undefined, newest.merged_at ? 'merged' : 'open'),
        }
        put(target)
      }
    } else if (s.branch && !s.on_default && root) {
      target = byBranch.get(`${root}\0${s.branch}`)
    }
    if (!target) {
      // Its pull requests all done: which one, so the row says so.
      const last = !newest ? newestPR((s.prs ?? []).map((p) => ({ ...p, closed_at: undefined }))) : undefined
      const lastState = last ? (gone.get(`${root}\0${last.number}`) ?? (last.merged_at ? 'merged' : 'closed')) : undefined
      target = {
        key: `s:${s.session_id}`, kind: 'session', repo: root ? named(root) : undefined, title: sessionTitle(s), branch: s.on_default ? undefined : s.branch,
        sessions: [], stage: 'agent', fill: 1, red: false, running: false, word: 'agent', lane: 'work', group: 'work', needsYou: false, working: false,
        ...(last && lastState ? { donePR: { number: last.number, state: lastState } } : {}),
      }
      put(target)
    }
    target.sessions.push(s)
  }

  // 3. Tasks: onto their session's row or their branch's, else their own.
  if (work.hive === 'on') {
    for (const t of work.tasks ?? []) {
      if (t.status === 'done') continue
      let target = t.session_id ? [...items.values()].find((it) => it.sessions.some((s) => s.session_id === t.session_id)) : undefined
      if (!target && t.branch) target = [...items.values()].find((it) => it.branch === t.branch)
      if (target) {
        target.task ??= t
        if (target.kind === 'session') target.title = t.title
        if (t.status === 'needs_you') target.needsYou = true
        continue
      }
      const st = taskStage(t)
      if (!st) continue
      put({ key: `t:${t.id}`, kind: 'task', title: t.title, branch: t.branch, task: t, sessions: [], working: t.status === 'in_progress', costUsd: t.spent_usd > 0 ? t.spent_usd : undefined, ...st })
    }
  }

  // 4. Queued messages: planned, after their session's turn.
  const sessionsById = new Map((work.sessions ?? []).map((s) => [s.session_id, s]))
  for (const q of work.queued ?? []) {
    const s = sessionsById.get(q.session_id)
    const root = s?.repo_root
    put({
      key: `q:${q.session_id}:${q.position}`, kind: 'queued', repo: root ? named(root) : undefined, title: queuedTitle(q.text), queued: q,
      sessions: s ? [s] : [], stage: 'planned', fill: 0, red: false, running: false, word: 'queued', lane: 'planned', group: 'planned', needsYou: false, working: false,
    })
  }

  // Who, when, cost — from what is attached.
  const out: WorkItem[] = []
  const idle: WorkItem[] = []
  for (const it of items.values()) {
    if (it.kind !== 'queued') {
      if (it.sessions.some(needsYouState)) it.needsYou = true
      if (it.sessions.some((s) => s.state === 'working')) it.working = true
      const first = Math.min(...it.sessions.map((s) => s.started_at).filter((v) => v > 0), it.pr?.created_at ?? Infinity)
      if (Number.isFinite(first)) it.startedAt = first
      // A pull request on the board: its card's spend, the one source the
      // Pipeline's list and its Agents figure use too (owner, 2026-10-24:
      // $29.89 here beside "–" there). Else the sessions on the row.
      if (it.card) it.costUsd = it.card.spend.sessions > 0 ? it.card.spend.cost_usd : undefined
      else if (it.sessions.length > 0) it.costUsd = it.sessions.reduce((n, s) => n + (s.cost_usd || 0), 0)
    }
    if (it.kind === 'session' && !it.task && it.sessions.length > 0 && it.sessions.every((s) => isIdle(s, now))) idle.push(it)
    else out.push(it)
  }

  // The header's counts, of live sessions: building (no pull request yet), on open pull requests, needing the person.
  let building = 0
  let onPRs = 0
  for (const it of out) {
    if (it.kind === 'session' || it.kind === 'task') building += it.sessions.length
    else if (it.kind === 'pr' && (it.stage === 'pr' || it.stage === 'ci')) onPRs += it.sessions.length
  }
  return { items: sortItems(out), idle, counts: { live: work.totals.live, building, onPRs, needsYou: work.totals.waiting_you } }
}

function prItem(repo: { root: string; name: string }, p: BranchPR, card: BoardCard | undefined, ships?: ShipsBy): WorkItem {
  const st = prStage(card, p.state, p.draft, ships)
  return {
    key: p.head ? `${repo.root}\0${p.head}` : `${repo.root}\0#${p.number}`, kind: 'pr', repo, title: p.title || `#${p.number}`, branch: p.head,
    pr: { number: p.number, url: p.url, title: p.title, created_at: p.created_at, merged_at: p.merged_at }, card,
    sessions: [], needsYou: false, working: false, startedAt: p.created_at, ...st,
  }
}

/** A session's row title: its name, else what it is about, else its project. */
export function sessionTitle(s: Pick<WorkSession, 'name' | 'description' | 'project' | 'session_id'>): string {
  return s.name || s.description || (s.project ? `${s.project} · ${s.session_id.slice(0, 8)}` : s.session_id.slice(0, 8))
}

/** Needs-you first, then working, then the rest; inside, by group's own order. */
export function sortItems(items: WorkItem[]): WorkItem[] {
  const releasedAt = (it: WorkItem) => it.card?.stage_at ?? it.pr?.merged_at ?? 0
  return [...items].sort((a, b) => {
    if (a.needsYou !== b.needsYou) return a.needsYou ? -1 : 1
    if (a.working !== b.working) return a.working ? -1 : 1
    if (a.group === 'released' && b.group === 'released') return releasedAt(b) - releasedAt(a)
    if (STAGE_RANK[a.stage] !== STAGE_RANK[b.stage]) return STAGE_RANK[b.stage] - STAGE_RANK[a.stage]
    // Planned: what is queued for an agent comes before tasks not started.
    if (!!a.queued !== !!b.queued) return a.queued ? -1 : 1
    if (a.queued && b.queued) return a.queued.position - b.queued.position
    const at = (it: WorkItem) => (it.stage === 'merged' ? it.pr?.merged_at : it.startedAt) ?? Number.MAX_SAFE_INTEGER
    return at(a) - at(b)
  })
}

/** The rows of one list group, in order. */
export function groupOf(items: readonly WorkItem[], g: Group): WorkItem[] {
  return items.filter((it) => it.group === g)
}

/** The cards of one Kanban column, in order. */
export function laneOf(items: readonly WorkItem[], l: Lane): WorkItem[] {
  return items.filter((it) => it.lane === l)
}

/** The repositories whose Pipeline answers are read: those with an agent running first, at most STATS_REPOS. */
export function statsRepos(repos: readonly WorkRepo[]): WorkRepo[] {
  return [...repos].filter((r) => r.via_session).sort((a, b) => (b.live > 0 ? 1 : 0) - (a.live > 0 ? 1 : 0) || b.live - a.live).slice(0, STATS_REPOS)
}

// ---------------------------------------------------------------- estimates, each with its basis

export interface Said {
  text: string
  /** What it is made of: the hover. */
  title: string
}

/** A running turn's range from the project's past turns; nothing without a basis, or once it ran past the range. */
export function turnLeft(s: Pick<WorkSession, 'state' | 'turn_left' | 'estimate' | 'project'>, passed: number): Said | undefined {
  if (s.state !== 'working' || !s.turn_left || !s.estimate) return undefined
  if (s.turn_left.hi_ms - passed <= 0) return undefined
  const r = etaRange(s.turn_left, passed)
  return { text: r === 'under a minute' ? 'turn under a minute left (rough)' : `turn ${r} left (rough)`, title: basisLabel(s.estimate, s.project) }
}

/** A running CI against the repository's median of successful runs; nothing without the median (fewer than two runs). */
export function ciVsUsual(card: Pick<BoardCard, 'ci' | 'stage_at'> | undefined, flow: Pick<BoardFlow, 'ci_median_ms' | 'days'> | undefined, now: number): Said | undefined {
  if (card?.ci !== 'running' || !flow?.ci_median_ms) return undefined
  const ran = card.stage_at ? ` ${spanText(Math.max(0, now - card.stage_at))}` : ''
  return {
    text: `CI running${ran} · usually ${spanText(flow.ci_median_ms)}`,
    title: `Usually: the median of this repository’s successful CI runs over the last ${flow.days} days (two or more runs). The running time counts from its first check’s start.`,
  }
}

/** Merged → released against the median lag; nothing under MIN_LAG_COUNT merges. */
export function releaseLag(stage: Stage, flow: Pick<BoardFlow, 'release_lag_median_ms' | 'release_lag_count'> | undefined): Said | undefined {
  if (stage !== 'merged' || !flow?.release_lag_median_ms || flow.release_lag_count < MIN_LAG_COUNT) return undefined
  return {
    text: `usually released in ~${spanText(flow.release_lag_median_ms)}`,
    title: `An estimate: the median time from merge to release of the last ${flow.release_lag_count} merged pull requests here, each matched to the first release published after it. Not a promise of when this one ships.`,
  }
}

/** The agent's own task list as "3 of 7 steps"; nothing when it keeps none. */
export function todoSteps(s: Pick<WorkSession, 'todo'>): (Said & { done: number; total: number }) | undefined {
  const t = s.todo
  if (!t || t.total <= 0) return undefined
  return { text: `${t.done} of ${t.total} steps`, title: `The agent’s own task list${t.active ? `; now: ${t.active}` : ''}. Its steps, not a share of the work.`, done: t.done, total: t.total }
}

/** "2h 05m", "45m", "3d 4h": a gap between releases. */
export function gapText(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

/** The release strip's cadence: "2h 05m since v0.117.4 · usual gap 2h 40m (median of 9)". The usual gap only with MIN_GAPS behind it. */
export function cadence(repo: Pick<WorkRepo, 'tags'>, flow: Pick<BoardFlow, 'release_gap_median_ms' | 'release_gap_count'> | undefined, now: number): Said | undefined {
  const last = repo.tags?.last
  let median = repo.tags?.gap_median_ms
  let n = repo.tags?.gaps ?? 0
  if (!median || n < MIN_GAPS) { median = flow?.release_gap_median_ms; n = flow?.release_gap_count ?? 0 }
  const usual = median && n >= MIN_GAPS ? `usual gap ${gapText(median)} (median of ${n})` : ''
  const since = last ? `${gapText(now - last.at)} since ${last.name}` : ''
  if (!since && !usual) return undefined
  return {
    text: [since, usual].filter(Boolean).join(' · '),
    title: usual ? `The usual gap is the median time between this repository’s last ${n + 1} tags. When the next one comes is not said: that is the person’s call.` : 'Too few releases here to say a usual gap.',
  }
}

/** A repository's GitHub state, in plain words; nothing when it reads. */
export function repoState(repo: Pick<WorkRepo, 'remote'>, st: SessionCIStats | undefined): string | undefined {
  if (!repo.remote || st?.reason === 'not_github') return 'Not on GitHub: no pull requests, CI or releases to show. Its agents are listed.'
  if (st?.reason === 'no_repo') return 'Not a git repository: its agents are listed.'
  if (st && st.connected === false) return 'GitHub is not connected: pull requests, CI and releases show once it is (Settings → GitHub).'
  return undefined
}

/** The board of one repository's Pipeline answer, read defensively. */
export function boardOf(st: SessionCIStats | undefined): PRBoard | undefined {
  return asBoard(st?.board)
}

/** Where a pull request row goes: the Pipeline's detail for it. */
export function pipelineHref(root: string, pr: number): string {
  return href({ name: 'pipeline', repo: root, pr })
}

/** The header line: "3 agents live · 1 building · 2 on open PRs · 1 needs you". */
export function headline(c: WorkBoard['counts']): string {
  const parts = [`${c.live} agent${c.live === 1 ? '' : 's'} live`, `${c.building} building`, `${c.onPRs} on open PRs`]
  parts.push(c.needsYou === 1 ? '1 needs you' : `${c.needsYou} need you`)
  return parts.join(' · ')
}

/** Who works on a row, in words: "started by Caprock" or "your terminal". */
export function origin(s: Pick<WorkSession, 'owned'>): string {
  return s.owned ? 'started by Caprock' : 'your terminal'
}
