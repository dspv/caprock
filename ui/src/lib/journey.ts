/**
 * A pull request's way to a merge, in three steps — Open → CI → Merged — as
 * the Pipeline page's rows and the cockpit's progress bars
 * both draw it (owner, 2026-10-14, translated: "PR rows with their statuses,
 * so I understand how things travel, what gets released"; "PRs as progress
 * bars toward release"). One function, so the two never disagree. Pure.
 *
 * The stage is the daemon's (internal/api/prboard.go, `BoardCard.stage`);
 * a pull request with no card (closed unmerged, or merged before the
 * board's window) is told from its own state.
 *
 * Merged is the last step everywhere, so a merge fills the bar (owner,
 * 2026-10-20, translated: the final status should be merged — a grey
 * Released step read as unfinished, or closed). Whether a merge is released
 * is a quiet word after the steps (`releaseNote`): *in v0.132.0* once it
 * shipped; *not released* while it waits, where the repository cuts
 * releases (`board.ships_by` release); nothing where it ships on merge or
 * nothing read says. A pull request closed unmerged stays distinct: its
 * Merged step reads *Closed*, the CI step before it never filled.
 */
import type { BoardCard, PRBoard, PRSpend, ShipsBy, Stage } from './prboard'
import type { BranchPR } from './branches'
import type { TabPR } from './prstats'

export type StepKey = 'open' | 'ci' | 'merged'
/** done: passed; current: where it is now; todo: still ahead; closed: it stopped here. */
export type StepState = 'done' | 'current' | 'todo' | 'closed'
export type StepTone = 'ok' | 'fail' | 'pending' | 'muted' | 'merged' | 'accent' | 'faint'

export interface JourneyStep {
  key: StepKey
  /** The step's word on its pill: "Open", "CI red", "Merged", "v0.117.1". */
  text: string
  state: StepState
  tone: StepTone
  /** What a hover says. */
  title: string
  /** Nothing read says where the step is: drawn neutral with a "?". */
  unknown?: boolean
}

/** The quiet word after a merged pull request's steps: the release it shipped in, or that it is in none yet. */
export interface ReleaseNote {
  text: string
  title: string
  /** It shipped: *in v0.132.0*. */
  released: boolean
}

/** What a row's steps need of its repository: how it ships, and the releases around it. */
export interface ShipsContext {
  /** `board.ships_by`; absent: not known. */
  ships?: ShipsBy
  /** The newest published release's tag, "v0.132.0". */
  lastRelease?: string
  /** The next version when predicted (lib/releaseplan nextVersion), "0.133.0". */
  next?: string
}

/** The context the board gives: how it ships, and its newest published release. */
export function shipsOf(board: PRBoard | undefined, next?: string): ShipsContext {
  let last: { tag: string; at: number } | undefined
  for (const r of board?.releases ?? []) {
    if (r.published_at && (!last || r.published_at > last.at)) last = { tag: r.tag, at: r.published_at }
  }
  return { ships: board?.ships_by, lastRelease: last?.tag, next }
}

/** The step names in order: merged is the last, however the repository ships. */
export const STEP_KEYS: readonly StepKey[] = ['open', 'ci', 'merged']

/**
 * A pill as components/Journey JourneyPills draws it, of any step line: a
 * pull request's four steps, or a release's stages (lib/releasestatus).
 * `unknown`: nothing read says where the step is; drawn neutral with a "?".
 */
export interface JourneyPillStep {
  key: string
  text: string
  state: StepState
  tone: StepTone
  title: string
  unknown?: boolean
}

export const STEP_NAME: Record<StepKey, string> = { open: 'Open', ci: 'CI', merged: 'Merged' }

/** What a row knows: its card, if the board has one, and its own state. */
export interface JourneyInput {
  card?: Pick<BoardCard, 'stage' | 'ci' | 'why' | 'release' | 'stage_at' | 'failed'>
  state: 'open' | 'closed' | 'merged'
  draft?: boolean
  merged_at?: number
}

/** The stage a row is in, its card's or its own. */
export function stageOf(p: JourneyInput): Stage | 'closed' {
  if (p.card) return p.card.stage
  if (p.state === 'merged') return 'merged'
  if (p.state === 'closed') return 'closed'
  return p.draft ? 'draft' : 'open'
}

/** What a red pull request's CI pill says on hover: the failed checks by name, when the daemon named them. */
export function failedTitle(failed: readonly string[] | undefined): string {
  if (!failed?.length) return 'A check on its head commit failed'
  return `${failed.length === 1 ? 'Failed' : 'Failed checks'}: ${failed.join(', ')}`
}

function ciStep(card: JourneyInput['card'], stage: Stage | 'closed'): Pick<JourneyStep, 'text' | 'tone' | 'title'> {
  if (card?.why === 'conflict') return { text: 'Conflict', tone: 'fail', title: 'GitHub says it conflicts with its base branch' }
  if (card?.why === 'changes_requested') return { text: 'Changes requested', tone: 'fail', title: 'A reviewer asked for changes' }
  switch (card?.ci) {
    case 'running': return { text: 'CI running', tone: 'pending', title: 'Its head commit’s checks are running' }
    case 'fail': return { text: 'CI red', tone: 'fail', title: failedTitle(card.failed) }
    case 'pass': return { text: 'CI green', tone: 'ok', title: 'Every check on its head commit passed' }
    case 'none': return { text: 'No checks', tone: 'muted', title: 'No check ran on its head commit' }
  }
  if (stage === 'ready') return { text: 'CI green', tone: 'ok', title: 'Its checks passed' }
  return { text: 'CI', tone: 'faint', title: 'Its checks were not read: only the newest open pull requests’ are' }
}

/** The steps of one pull request: Open → CI → Merged, a merge (released or not) the last and the bar full. */
export function journey(p: JourneyInput): JourneyStep[] {
  const stage = stageOf(p)
  const ci = ciStep(p.card, stage)
  const step = (key: StepKey, state: StepState, tone: StepTone, text: string, title: string): JourneyStep => ({ key, state, tone, text, title })
  switch (stage) {
    case 'draft':
      return [
        step('open', 'current', 'muted', 'Draft', 'Opened as a draft: not ready for review'),
        step('ci', p.card?.ci ? 'current' : 'todo', p.card?.ci ? ci.tone : 'faint', p.card?.ci ? ci.text : 'CI', ci.title),
        step('merged', 'todo', 'faint', 'Merged', 'Not merged yet'),
      ]
    case 'open': case 'fix': case 'ready':
      return [
        step('open', 'done', 'muted', 'Open', 'Opened'),
        step('ci', 'current', ci.tone, ci.text, stage === 'ready' ? `${ci.title}: waiting for a review or a merge` : ci.title),
        step('merged', 'todo', 'faint', 'Merged', 'Not merged yet'),
      ]
    case 'merged': case 'released':
      return [
        step('open', 'done', 'muted', 'Open', 'Opened'),
        step('ci', 'done', 'ok', 'CI', 'Merged, so its checks were let through'),
        step('merged', 'current', 'merged', 'Merged', 'Merged: the last step'),
      ]
    case 'closed':
      return [
        step('open', 'done', 'muted', 'Open', 'Opened'),
        step('ci', 'todo', 'faint', 'CI', 'Closed before it was merged'),
        step('merged', 'closed', 'muted', 'Closed', 'Closed without a merge: it will not ship'),
      ]
  }
}

/**
 * What a merged pull request says after its steps about a release: *in
 * v0.132.0* once a published release holds it; *not released* while it
 * waits, where the repository cuts releases, the next version on hover when
 * predicted; nothing where work ships when it merges, where nothing read
 * says how it ships, or before a merge.
 */
export function releaseNote(p: JourneyInput, ctx: ShipsContext = {}): ReleaseNote | undefined {
  const stage = stageOf(p)
  if (stage === 'released') {
    const tag = p.card?.release
    return { text: tag ? `in ${tag}` : 'released', title: tag ? `Shipped in ${tag}: the first release published after the merge (matched by time)` : 'In a published release', released: true }
  }
  if (stage !== 'merged' || ctx.ships !== 'release') return undefined
  const next = ctx.next ? ` (v${ctx.next}, predicted from the changelog entries)` : ctx.lastRelease ? `, after ${ctx.lastRelease}` : ''
  return { text: 'not released', title: `Merged, in no published release yet: it ships with the next release${next}.`, released: false }
}

/**
 * The order rows are listed in: in flight first — needing a fix, CI running,
 * ready, draft — then merged and not released, then released, then closed.
 * Inside a group, waiting ones longest-waiting first, merges newest first.
 */
export const GROUP_ORDER: (Stage | 'closed')[] = ['fix', 'open', 'ready', 'draft', 'merged', 'released', 'closed']

export function journeyOrder<T extends JourneyInput & { created_at?: number }>(rows: T[]): T[] {
  const rank = (r: T) => GROUP_ORDER.indexOf(stageOf(r))
  const at = (r: T) => r.card?.stage_at ?? r.merged_at ?? r.created_at ?? 0
  return [...rows].sort((a, b) => {
    const d = rank(a) - rank(b)
    if (d !== 0) return d
    const s = stageOf(a)
    return s === 'merged' || s === 'released' || s === 'closed' ? at(b) - at(a) : at(a) - at(b)
  })
}

/** How far along it is, 1–3, for the cockpit's bar. */
export function progressOf(steps: JourneyStep[]): number {
  const i = steps.findIndex((s) => s.state === 'current' || s.state === 'closed')
  return i < 0 ? steps.filter((s) => s.state === 'done').length : i + 1
}

/** One row of the Pipeline: a listed pull request with its board card and labels. */
export interface PipelineRow extends TabPR {
  card?: BoardCard
  /** Its recorded agent work: its card's, else (closed unmerged in the window) its `board.closed` entry's — the one source the list, the figure and the release plan share. */
  spend?: PRSpend
  labels?: { name: string; color?: string }[]
  author?: string
  author_avatar?: string
}

/** The rows with their cards, labels and authors, in journey order. */
export function pipelineRows(rows: TabPR[], board: PRBoard | undefined, repo: BranchPR[]): PipelineRow[] {
  const cards = new Map((board?.cards ?? []).map((c) => [c.number, c]))
  const closed = new Map((board?.closed ?? []).map((c) => [c.number, c]))
  const listed = new Map(repo.map((p) => [p.number, p]))
  return journeyOrder(rows.map((r) => {
    const b = listed.get(r.number)
    const card = cards.get(r.number)
    return { ...r, card, spend: card?.spend ?? closed.get(r.number)?.spend, labels: b?.labels, author: b?.author, author_avatar: b?.author_avatar }
  }))
}

/** What the cockpit's PRs view lists (owner, 2026-10-16, translated: "on the right it sometimes shows too many PRs"). */
export interface Flight {
  /** In flight, in journey order: open, and merged since the newest release. */
  rows: PipelineRow[]
  /** With nothing in flight, the newest merges (at most three), as context. */
  recent: PipelineRow[]
  /** The newest published release, when the board lists one. */
  release?: { tag: string; published_at: number }
  /** How merged work ships here (`board.ships_by`). */
  ships?: ShipsBy
}

const OPEN_STAGES = new Set<Stage | 'closed'>(['draft', 'open', 'fix', 'ready'])

/**
 * What is in flight: the open pull requests, and the ones merged since the
 * newest release (still heading to one). Released and closed-unmerged ones
 * are dropped. A repository that publishes no release (a site that pushes
 * straight to its default branch, like caprock-web) has nothing heading to
 * one, so only its open pull requests are in flight; nor has one that ships
 * on merge (`ships_by` merge), whatever old release it once published. Pure.
 */
export function inFlight(rows: PipelineRow[], board: PRBoard | undefined): Flight {
  let release: Flight['release']
  for (const r of board?.releases ?? []) {
    if (r.published_at && (!release || r.published_at > release.published_at)) release = { tag: r.tag, published_at: r.published_at }
  }
  const flying = rows.filter((r) => {
    const s = stageOf(r)
    if (OPEN_STAGES.has(s)) return true
    // Where work ships on merge, a merge is done, however old the last release.
    return s === 'merged' && board?.ships_by !== 'merge' && !!release && (r.merged_at ?? 0) > release.published_at
  })
  const recent = flying.length > 0 ? [] : rows.filter((r) => r.state === 'merged' && !!r.merged_at)
    .sort((a, b) => (b.merged_at ?? 0) - (a.merged_at ?? 0)).slice(0, 3)
  return { rows: flying, recent, release, ships: board?.ships_by }
}

/** The in-flight pull request the Ring and By OS views draw: the newest open one, else the newest merge. */
export function flightLead(f: Flight): PipelineRow | undefined {
  const open = f.rows.filter((r) => OPEN_STAGES.has(stageOf(r)))
  const pool = open.length > 0 ? open : f.rows
  const at = (r: PipelineRow) => (open.length > 0 ? r.created_at : r.merged_at) ?? 0
  return pool.reduce<PipelineRow | undefined>((best, r) => (!best || at(r) > at(best) ? r : best), undefined)
}
