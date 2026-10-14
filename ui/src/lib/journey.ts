/**
 * A pull request's way to a release, in four steps — Open → CI → Merged →
 * Released — as the Pipeline page's rows and the cockpit's progress bars
 * both draw it (owner, 2026-10-14, translated: "PR rows with their statuses,
 * so I understand how things travel, what gets released"; "PRs as progress
 * bars toward release"). One function, so the two never disagree. Pure.
 *
 * The stage is the daemon's (internal/api/prboard.go, `BoardCard.stage`);
 * a pull request with no card (closed unmerged, or merged before the
 * board's window) is told from its own state.
 */
import type { BoardCard, PRBoard, Stage } from './prboard'
import type { BranchPR } from './branches'
import type { TabPR } from './prstats'

export type StepKey = 'open' | 'ci' | 'merged' | 'released'
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
}

export const STEP_NAME: Record<StepKey, string> = { open: 'Open', ci: 'CI', merged: 'Merged', released: 'Released' }

/** What a row knows: its card, if the board has one, and its own state. */
export interface JourneyInput {
  card?: Pick<BoardCard, 'stage' | 'ci' | 'why' | 'release' | 'stage_at'>
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

function ciStep(card: JourneyInput['card'], stage: Stage | 'closed'): Pick<JourneyStep, 'text' | 'tone' | 'title'> {
  if (card?.why === 'conflict') return { text: 'Conflict', tone: 'fail', title: 'GitHub says it conflicts with its base branch' }
  if (card?.why === 'changes_requested') return { text: 'Changes requested', tone: 'fail', title: 'A reviewer asked for changes' }
  switch (card?.ci) {
    case 'running': return { text: 'CI running', tone: 'pending', title: 'Its head commit’s checks are running' }
    case 'fail': return { text: 'CI red', tone: 'fail', title: 'A check on its head commit failed' }
    case 'pass': return { text: 'CI green', tone: 'ok', title: 'Every check on its head commit passed' }
    case 'none': return { text: 'No checks', tone: 'muted', title: 'No check ran on its head commit' }
  }
  if (stage === 'ready') return { text: 'CI green', tone: 'ok', title: 'Its checks passed' }
  return { text: 'CI', tone: 'faint', title: 'Its checks were not read: only the newest open pull requests’ are' }
}

/** The four steps of one pull request. */
export function journey(p: JourneyInput): JourneyStep[] {
  const stage = stageOf(p)
  const ci = ciStep(p.card, stage)
  const step = (key: StepKey, state: StepState, tone: StepTone, text: string, title: string): JourneyStep => ({ key, state, tone, text, title })
  const tag = p.card?.release
  switch (stage) {
    case 'draft':
      return [
        step('open', 'current', 'muted', 'Draft', 'Opened as a draft: not ready for review'),
        step('ci', p.card?.ci ? 'current' : 'todo', p.card?.ci ? ci.tone : 'faint', p.card?.ci ? ci.text : 'CI', ci.title),
        step('merged', 'todo', 'faint', 'Merged', 'Not merged yet'),
        step('released', 'todo', 'faint', 'Released', 'In no release yet'),
      ]
    case 'open': case 'fix': case 'ready':
      return [
        step('open', 'done', 'muted', 'Open', 'Opened'),
        step('ci', 'current', ci.tone, ci.text, stage === 'ready' ? `${ci.title}: waiting for a review or a merge` : ci.title),
        step('merged', 'todo', 'faint', 'Merged', 'Not merged yet'),
        step('released', 'todo', 'faint', 'Released', 'In no release yet'),
      ]
    case 'merged':
      return [
        step('open', 'done', 'muted', 'Open', 'Opened'),
        step('ci', 'done', 'ok', 'CI', 'Merged, so its checks were let through'),
        step('merged', 'current', 'merged', 'Merged', 'Merged, in no published release yet'),
        step('released', 'todo', 'faint', 'Released', 'Waiting for the next release'),
      ]
    case 'released':
      return [
        step('open', 'done', 'muted', 'Open', 'Opened'),
        step('ci', 'done', 'ok', 'CI', 'Merged, so its checks were let through'),
        step('merged', 'done', 'merged', 'Merged', 'Merged'),
        step('released', 'current', 'accent', tag || 'Released', tag ? `Shipped in ${tag}: the first release published after the merge (matched by time)` : 'In a published release'),
      ]
    case 'closed':
      return [
        step('open', 'done', 'muted', 'Open', 'Opened'),
        step('ci', 'todo', 'faint', 'CI', 'Closed before it was merged'),
        step('merged', 'closed', 'muted', 'Closed', 'Closed without a merge'),
        step('released', 'todo', 'faint', 'Released', 'Closed: it will not ship'),
      ]
  }
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

/** How far along it is, 1–4, for the cockpit's bar. */
export function progressOf(steps: JourneyStep[]): number {
  const i = steps.findIndex((s) => s.state === 'current' || s.state === 'closed')
  return i < 0 ? steps.filter((s) => s.state === 'done').length : i + 1
}

/** One row of the Pipeline: a listed pull request with its board card and labels. */
export interface PipelineRow extends TabPR {
  card?: BoardCard
  labels?: { name: string; color?: string }[]
  author?: string
  author_avatar?: string
}

/** The rows with their cards, labels and authors, in journey order. */
export function pipelineRows(rows: TabPR[], board: PRBoard | undefined, repo: BranchPR[]): PipelineRow[] {
  const cards = new Map((board?.cards ?? []).map((c) => [c.number, c]))
  const listed = new Map(repo.map((p) => [p.number, p]))
  return journeyOrder(rows.map((r) => {
    const b = listed.get(r.number)
    return { ...r, card: cards.get(r.number), labels: b?.labels, author: b?.author, author_avatar: b?.author_avatar }
  }))
}
