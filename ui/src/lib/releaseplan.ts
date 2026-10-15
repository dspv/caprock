/**
 * The release plan (.ai/04-ui.md § Release plan): one repository's next
 * release as a heading and rows of work with block progress bars (owner,
 * 2026-10-15, translated, of a text status report: "exactly this, as a
 * view" — the next version, each piece of work with a bar and its stage
 * word, then what comes later). Pure; drawn by components/ReleasePlan on the
 * Pipeline page, in the right panel and as the Work page's Release view.
 *
 * - **The version** is predicted by a stated rule, never guessed (rule 6):
 *   the last tag, bumped by the changes waiting for a release — any `Added`
 *   entry (a changelog fragment's `kind:` or the CHANGELOG's `### Added` in
 *   [Unreleased]) makes the next minor, entries that are all of other kinds
 *   the next patch (owner, 2026-10-15: "a feature is a minor release, fixes
 *   are patches"). With no tag, no pending entries, or entries whose kind is
 *   not said, no number: "Next release".
 * - **The rows** are the Work board's own (lib/work buildWork), one
 *   repository's: pull requests merged since the last tag (a full bar but
 *   the released step, "merged"), open ones (filled to their step along
 *   agent → PR → CI → merged → released, the CI step red on a red check or a
 *   conflict; a landing-queue label, "landing: queued", is the stage word
 *   when it is there), and agents working with no pull request yet
 *   ("agent"). Drafts and agents idle at their prompt come *later*.
 * - **The bar** is the stage's place, ten blocks for five steps: a fact, not
 *   a guess at how far the work is.
 */
import type { SessionCIStats, Work, WorkRepo } from './api'
import type { BranchPR } from './branches'
import { asBoard } from './prboard'
import { buildWork, gapText, MIN_GAPS, STEPS, type Stage, type WorkItem } from './work'

/** Blocks in a bar: two per step. */
export const BLOCKS = 10
const PER_STEP = BLOCKS / STEPS.length

/** A landing-queue label's prefix, as the queue sets it on a pull request. */
export const LANDING_PREFIX = 'landing: '

export type Bump = 'minor' | 'patch'

export interface NextVersion {
  /** "0.120.0", without the tag's "v"; absent when the rule cannot say. */
  version?: string
  bump?: Bump
  /** The hover: what the number is made of. */
  title: string
}

export interface PlanRow {
  key: string
  number?: number
  title: string
  url?: string
  stage: Stage
  /** Blocks filled, 0–BLOCKS. */
  filled: number
  /** The step it is on failed: its blocks are drawn red. */
  red: boolean
  /** A landing label that waits on the person ("needs a hand merge"). */
  warn: boolean
  word: string
  /** What the word means, on hover. */
  wordTitle?: string
}

export interface PlanGroup {
  key: 'drafts' | 'idle'
  label: string
  rows: PlanRow[]
}

export interface ReleasePlanData {
  root: string
  name: string
  next?: NextVersion
  /** "3 merged since v0.119.0 · 2h 05m ago · usual gap 2h 40m (median of 9)". */
  since?: { text: string; title: string }
  rows: PlanRow[]
  later: PlanGroup[]
}

/** "v0.119.0" → [0, 119, 0] and its prefix; undefined for a tag that is not x.y.z. */
export function parseVersion(tag: string): { prefix: string; v: [number, number, number] } | undefined {
  const m = /^([A-Za-z-]*?)(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim())
  if (!m) return undefined
  return { prefix: m[1] ?? '', v: [Number(m[2]), Number(m[3]), Number(m[4])] }
}

/** The bump the pending entries call for: minor with any Added, patch when every entry has another kind, else none. */
export function bumpOf(u: WorkRepo['unreleased']): Bump | undefined {
  if (!u || u.count <= 0 || !u.kinds) return undefined
  if ((u.kinds.Added ?? 0) > 0) return 'minor'
  const known = Object.values(u.kinds).reduce<number>((n, c) => n + (c ?? 0), 0)
  // An entry under no kind could be a feature: the rule cannot say.
  return known >= u.count ? 'patch' : undefined
}

/**
 * The next version from the last tag and the pending entries; undefined when
 * nothing is pending (no entries read, or none), so there is no heading to
 * number.
 */
export function nextVersion(lastTag: string | undefined, u: WorkRepo['unreleased']): NextVersion | undefined {
  if (!u || u.count <= 0) return undefined
  const from = `read from ${u.ref}’s changelog entries as of your last fetch`
  const rule = 'Next version, by the pending changes: a feature (an Added entry) makes a minor release, fixes and other changes alone a patch'
  const bump = bumpOf(u)
  const parsed = lastTag ? parseVersion(lastTag) : undefined
  if (!bump || !parsed) {
    const why = !lastTag ? 'no tag to count from' : !parsed ? `${lastTag} is not a x.y.z version` : 'some entries say no kind (Added, Fixed, …), so a feature cannot be ruled out'
    return { title: `${rule}. No number: ${why}. ${u.count} entr${u.count === 1 ? 'y' : 'ies'} ${from}.` }
  }
  const [a, b, c] = parsed.v
  const version = bump === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`
  const added = u.kinds?.Added ?? 0
  const what = bump === 'minor' ? `${added} Added entr${added === 1 ? 'y' : 'ies'}` : `${u.count} entr${u.count === 1 ? 'y' : 'ies'}, none Added`
  return { version, bump, title: `${rule}: ${what} since ${lastTag}, ${from}. When it ships is your call.` }
}

/** A landing-queue label on a pull request, as its stage word; the red and warn ones say so. */
export function landingOf(labels: BranchPR['labels']): { word: string; red: boolean; warn: boolean } | undefined {
  const l = labels?.find((x) => x.name.toLowerCase().startsWith(LANDING_PREFIX))
  if (!l) return undefined
  const what = l.name.slice(LANDING_PREFIX.length).trim().toLowerCase()
  return { word: l.name, red: what === 'ci red', warn: what === 'needs a hand merge' }
}

/** One board row as a plan row: its blocks, its word, a landing label over the word. */
export function rowOf(it: WorkItem, labels?: BranchPR['labels']): PlanRow {
  const landing = it.kind === 'pr' ? landingOf(labels) : undefined
  return {
    key: it.key,
    number: it.pr?.number,
    title: it.title,
    url: it.pr?.url,
    stage: it.stage,
    filled: Math.max(0, Math.min(BLOCKS, it.fill * PER_STEP)),
    red: it.red || !!landing?.red,
    warn: !landing?.red && !!landing?.warn,
    word: landing?.word ?? it.word,
    wordTitle: landing ? `Set by the landing queue; on the board: ${it.word}` : undefined,
  }
}

const mergedAt = (it: WorkItem) => it.pr?.merged_at ?? 0

/**
 * One repository's rows: the next release's — merged since the last tag,
 * open pull requests, agents with no pull request — furthest along first,
 * and later's drafts and idle agents. Released, closed, tasks and queued
 * messages are not the release's.
 */
export function planRows(items: readonly WorkItem[], idle: readonly WorkItem[], root: string, lastTagAt: number | undefined, prs: readonly BranchPR[] = []): { rows: PlanRow[]; later: PlanGroup[]; merged: number } {
  const labels = new Map(prs.map((p) => [p.number, p.labels]))
  const mine = (it: WorkItem) => it.repo?.root === root
  const next: WorkItem[] = []
  const drafts: WorkItem[] = []
  for (const it of items) {
    if (!mine(it)) continue
    if (it.kind === 'session') { next.push(it); continue }
    if (it.kind !== 'pr' || it.stage === 'released' || it.stage === 'planned') continue
    // Merged before the last tag: in that tag, though no GitHub release says so.
    if (it.stage === 'merged' && lastTagAt && mergedAt(it) > 0 && mergedAt(it) <= lastTagAt) continue
    if (it.word === 'draft') drafts.push(it)
    else next.push(it)
  }
  next.sort((a, b) => b.fill - a.fill || (a.stage === 'merged' ? mergedAt(a) - mergedAt(b) : (a.pr?.number ?? Infinity) - (b.pr?.number ?? Infinity)))
  const later: PlanGroup[] = []
  if (drafts.length) later.push({ key: 'drafts', label: 'Drafts', rows: drafts.map((it) => rowOf(it, labels.get(it.pr?.number ?? -1))) })
  const sleeping = idle.filter(mine)
  if (sleeping.length) later.push({ key: 'idle', label: 'Agents idle over 30 min', rows: sleeping.map((it) => ({ ...rowOf(it), word: 'idle' })) })
  return { rows: next.map((it) => rowOf(it, labels.get(it.pr?.number ?? -1))), later, merged: next.filter((it) => it.stage === 'merged').length }
}

/** "3 merged since v0.119.0 · 2h 05m ago · usual gap 2h 40m (median of 9)": the usual gap only with MIN_GAPS behind it. */
export function sinceLine(last: { name: string; at: number } | undefined, merged: number, repo: WorkRepo | undefined, stats: SessionCIStats | undefined, now: number): ReleasePlanData['since'] {
  const flow = asBoard(stats?.board)?.flow
  let median = repo?.tags?.gap_median_ms
  let n = repo?.tags?.gaps ?? 0
  if (!median || n < MIN_GAPS) { median = flow?.release_gap_median_ms; n = flow?.release_gap_count ?? 0 }
  const usual = median && n >= MIN_GAPS ? `usual gap ${gapText(median)} (median of ${n})` : ''
  const parts = last ? [`${merged} merged since ${last.name}`, `${gapText(now - last.at)} ago`] : []
  if (usual) parts.push(usual)
  if (!parts.length) return undefined
  return {
    text: parts.join(' · '),
    title: usual
      ? `The usual gap is the median time between this repository’s last ${n + 1} releases. When the next one comes is not said: that is your call.`
      : 'Too few releases here to say a usual gap.',
  }
}

/** The plan of one repository, from the board's rows and what is read of the repository. */
export function releasePlan(input: { root: string; name?: string; repo?: WorkRepo; stats?: SessionCIStats; items: readonly WorkItem[]; idle?: readonly WorkItem[]; now: number }): ReleasePlanData {
  const { root, repo, stats, now } = input
  const board = asBoard(stats?.board)
  const rel = board?.releases?.[0]
  // The last tag as git has it; else the newest published GitHub release.
  const last = repo?.tags?.last ?? (rel ? { name: rel.tag, at: rel.published_at } : undefined)
  const { rows, later, merged } = planRows(input.items, input.idle ?? [], root, last?.at, stats?.prs ?? [])
  return {
    root,
    name: input.name ?? repo?.name ?? root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? root,
    next: nextVersion(last?.name, repo?.unreleased),
    since: sinceLine(last, merged, repo, stats, now),
    rows,
    later,
  }
}

/** Nothing to say: no rows, nothing later, no version. */
export function planEmpty(p: ReleasePlanData): boolean {
  return p.rows.length === 0 && p.later.length === 0 && !p.next
}

const NO_WORK: Work = { now: 0, day_start: 0, sessions: [], hive: 'off', queued: [], repos: [], totals: { live: 0, working: 0, waiting_you: 0, today_usd: 0, machine_today_usd: 0 } }

/**
 * One repository's plan for a page that reads one Pipeline answer (the
 * Pipeline page, the right panel): the board built from the Work answer, when
 * there is one, and that answer alone. Without the Work answer there are no
 * agent rows and no version, only the pull requests.
 */
export function planForRepo(work: Work | undefined, root: string, stats: SessionCIStats | undefined, now: number): ReleasePlanData {
  const w = work ? { ...work, tasks: [], queued: [] } : NO_WORK
  const board = buildWork(w, new Map([[root, stats]]), now)
  const repo = work?.repos?.find((r) => r.root === root)
  return releasePlan({ root, repo, stats, items: board.items, idle: board.idle, now })
}
