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
 * - **The bar** is the stage's place, a named segment per step (two of the
 *   ten blocks the text report draws): a fact, not a guess at how far the
 *   work is.
 * - **Beside the word**, each from what the board already read, never a
 *   guess: what the row waits for now (`waitOf`: "CI on Windows · 6m",
 *   "needs a rebase", "fix: go (windows-latest)", "a release"), its age since
 *   opened ("19h"), its checks per OS (`card.os`) as dots, its CI time
 *   against the usual (`card.ci_ms`, the flow's median), and the agent spend
 *   recorded on it (`store.SpendByPR`, at list price; "—" when none was).
 * - **A repository that cuts no releases** (`board.ships_by` merge: none
 *   published and no version tag in 180 days — a site deployed on every
 *   merge; owner, 2026-10-18) has no next release: no version, the line
 *   *No releases here: work ships when it merges*, bars without the
 *   released step, and its merges, done, under a short *Merged recently*
 *   (MERGED_RECENT) instead of piling up as waiting for a release.
 * - **What else heads into it** (owner, 2026-10-18, translated: "it shows
 *   vaguely what's going on on the way to the release"; agents push
 *   branches and one batch pull request ships them): where a session is
 *   known (the right panel), its repository's pushed branches with no pull
 *   request (`branchRows`) and the session's working subagents
 *   (`subagentRows`). The rows stand in sections, each with a count:
 *   *In this release · 2 merged*, *Pull requests · 1 open*, *Branches
 *   pushed, no PR yet · 3*, *Agents working now · 6* (`planSections`), each
 *   with a one-line hint.
 */
import type { SessionCIStats, SubagentsNow, Work, WorkRepo, WorkSession } from './api'
import type { BranchPR, SessionBranches } from './branches'
import { fmtUSD } from './format'
import { AGENT_COST_NOTE, asBoard, type BoardFlow, type BoardOS, type ShipsBy } from './prboard'
import { spanText, vsMedianText } from './prstats'
import { buildWork, ciVsUsual, gapText, isIdle, MIN_GAPS, releaseLag, STEPS, todoSteps, type Stage, type WorkItem } from './work'

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
  /** A pushed branch row: its name, shown under the subject. */
  branch?: string
  url?: string
  /** The Work board's stage, or `branch`: pushed, with no pull request yet. */
  stage: Stage | 'branch'
  /** The section it is listed under (`planSections`). */
  section: RowSection
  /** Blocks filled, 0–BLOCKS. */
  filled: number
  /** The step it is on failed: its blocks are drawn red. */
  red: boolean
  /** A landing label that waits on the person ("needs a hand merge"). */
  warn: boolean
  word: string
  /** What the word means, on hover. */
  wordTitle?: string
  /** The step it is on is under way: CI running, an agent at work. */
  running: boolean
  /** What it waits for now, in plain words; absent when nothing read says. */
  wait?: Wait
  /** Since it was opened (an agent row: started), short: "19h". */
  age?: { text: string; title: string }
  /** Its checks per OS, macOS · Linux · Windows; absent when no check names an OS. */
  ci?: OSDot[]
  /** How long its CI took (or has run), against the repository's usual; absent when not read. */
  ciTime?: { text: string; title: string; tone?: 'warn' }
  /** The agent spend recorded on it, at API list price; "—" when none was. */
  cost: { text: string; title: string; known: boolean }
  /** The agent session it opens (`pickSession`); absent when no live session is on it. */
  session?: { id: string; owned: boolean; name: string }
}

export interface Wait {
  text: string
  title: string
  /** danger: it waits on a fix; warn: on the person. */
  tone?: 'danger' | 'warn'
}

export interface OSDot {
  os: BoardOS['os']
  label: string
  state: BoardOS['state']
  title: string
}

/** What a row reads beside its card: the clock and the repository's flow. */
export interface RowContext {
  now?: number
  flow?: Pick<BoardFlow, 'ci_median_ms' | 'days' | 'release_lag_median_ms' | 'release_lag_count'>
}

/** The sections a plan's rows stand in, in this order. */
export type RowSection = 'merged' | 'pr' | 'branch' | 'agent'
export const SECTION_ORDER: readonly RowSection[] = ['merged', 'pr', 'branch', 'agent']

/** How many pushed branches the plan lists, newest first. */
export const BRANCHES_LISTED = 15
/** A pushed branch committed longer ago than this is not listed. */
export const BRANCH_RECENT_MS = 14 * 24 * 60 * 60 * 1000
/** How many working subagents the plan lists. */
export const SUBAGENTS_LISTED = 10

/** How many merges a repository that ships on merge lists under *Merged recently*. */
export const MERGED_RECENT = 3

/** The line said where work ships on merge, in place of the release line. */
export const SHIPS_ON_MERGE = 'No releases here: work ships when it merges'

export interface PlanGroup {
  key: 'drafts' | 'idle' | 'merged'
  label: string
  rows: PlanRow[]
}

export interface ReleasePlanData {
  root: string
  name: string
  next?: NextVersion
  /** "3 changes waiting for the next release · last release v0.119.0, 2h 05m ago"; the usual gap on hover. */
  since?: { text: string; title: string }
  rows: PlanRow[]
  later: PlanGroup[]
  /** How merged work ships here (`board.ships_by`); absent: not known. */
  ships?: ShipsBy
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

const OS_LABEL: Record<BoardOS['os'], string> = { linux: 'Linux', macos: 'macOS', windows: 'Windows' }
/** The dots' order, as the owner says them: macOS, Linux, Windows. */
const OS_ORDER: BoardOS['os'][] = ['macos', 'linux', 'windows']

/** "45m", "19h", "3d": an age, at one unit. */
export function ageText(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** A pull request's checks per OS as dots, macOS · Linux · Windows. */
export function osDots(os: readonly BoardOS[] | undefined, now?: number): OSDot[] | undefined {
  if (!os?.length) return undefined
  const by = new Map(os.map((o) => [o.os, o]))
  const out: OSDot[] = []
  for (const k of OS_ORDER) {
    const o = by.get(k)
    if (!o) continue
    const n = `${o.checks} check${o.checks === 1 ? '' : 's'}`
    const what = o.state === 'fail' ? 'failed' : o.state === 'pass' ? 'passed' : `running${o.since && now ? ` ${spanText(Math.max(0, now - o.since))}` : ''}`
    out.push({ os: k, label: OS_LABEL[k], state: o.state, title: `${OS_LABEL[k]}: ${what} (${n})` })
  }
  return out.length ? out : undefined
}

/**
 * What a row waits for now, in plain words, from what the board read: the
 * landing queue's label, a session's state, the pull request's stage, its
 * failed checks and which OS's checks still run. Nothing when none of it says.
 */
export function waitOf(it: WorkItem, landing: ReturnType<typeof landingOf>, ctx: RowContext = {}): Wait | undefined {
  const { now, flow } = ctx
  const c = it.card
  const lw = landing?.word.slice(LANDING_PREFIX.length).trim().toLowerCase()
  if (lw === 'needs a hand merge') return { text: 'your merge', title: 'The landing queue could not merge it: it waits for you to merge it by hand.', tone: 'warn' }
  if (lw === 'queued') return { text: 'its turn to land', title: 'In the landing queue: it is merged when the ones before it are.' }
  if (lw === 'updating') return { text: 'the queue’s update', title: 'The landing queue is bringing it up to date with the default branch.' }
  if (it.kind === 'session') {
    const ss = it.sessions
    if (ss.some((x) => x.state === 'permission')) return { text: 'your permission', title: 'An agent on it asks for a permission.', tone: 'warn' }
    if (ss.some((x) => x.state === 'question')) return { text: 'your answer', title: 'An agent on it asks you a question.', tone: 'warn' }
    const w = ss.find((x) => x.state === 'working' || x.state === 'background')
    if (w) {
      const t = todoSteps(w)
      return t ? { text: `the agent · ${t.text}`, title: t.title } : { text: 'the agent', title: 'An agent is at work on it; no pull request yet.' }
    }
    if (ss.length) return { text: 'your next prompt', title: 'Its agent is at its prompt, waiting for you.' }
    return undefined
  }
  if (it.kind !== 'pr' || it.stage === 'released') return undefined
  if (it.stage === 'merged') {
    const lag = releaseLag('merged', flow)
    return { text: 'a release', title: `Merged: it ships with the next release${lag ? `, ${lag.text}. ${lag.title}` : '.'}` }
  }
  if (it.word === 'draft') return { text: 'marked ready', title: 'A draft: it waits to be marked ready for review.' }
  if (c?.why === 'conflict') return { text: 'needs a rebase', title: 'GitHub says it conflicts with its base branch: rebase it, or merge the base in.', tone: 'danger' }
  if (c?.why === 'changes_requested') return { text: 'requested changes', title: 'A reviewer asked for changes.', tone: 'danger' }
  if (c?.why === 'ci' || landing?.red) {
    const f = c?.failed ?? []
    if (!f.length) return { text: 'a fix: CI red', title: 'A check failed; its name was not read.', tone: 'danger' }
    return { text: `fix: ${f[0]}${f.length > 1 ? ` +${f.length - 1}` : ''}`, title: `Failed: ${f.join(', ')}${f.length >= 3 ? ' (the first three named)' : ''}.`, tone: 'danger' }
  }
  if (c?.ci === 'running') {
    const run = (c.os ?? []).filter((o) => o.state === 'running')
    const starts = run.map((o) => o.since ?? 0).filter((t) => t > 0)
    const since = starts.length ? Math.min(...starts) : c.stage_at
    const took = since && now ? ` · ${spanText(Math.max(0, now - since))}` : ''
    const usual = now ? ciVsUsual(c, flow, now) : undefined
    const more = usual ? ` ${usual.text}. ${usual.title}` : ''
    if (run.length) {
      const names = OS_ORDER.filter((k) => run.some((o) => o.os === k)).map((k) => OS_LABEL[k])
      return { text: `CI on ${names.join(', ')}${took}`, title: `Checks still running on ${names.join(', ')}; the time is since the first of them started.${more}` }
    }
    return { text: `CI${took}`, title: `Its checks are running.${more}` }
  }
  if (c?.stage === 'ready') {
    if (c.review === 'review_required') return { text: 'a review', title: 'Checks are done; GitHub says a review is required before it merges.' }
    return { text: 'a merge', title: c.ci === 'none' ? 'No checks ran; nothing else holds it.' : 'Checks passed; nothing else holds it.' }
  }
  return undefined
}

/**
 * Its CI time: finished, the checks' span against the usual ("12m +9%",
 * amber past +20%); running, the time so far over the usual ("6m / ~11m").
 * Nothing on a merged row or without the stamps.
 */
export function ciTimeOf(it: WorkItem, ctx: RowContext = {}): PlanRow['ciTime'] {
  const c = it.card
  if (!c || it.kind !== 'pr' || it.stage === 'merged' || it.stage === 'released') return undefined
  const median = ctx.flow?.ci_median_ms
  const usual = median ? ` Usually ${spanText(median)}: the median of this repository’s successful CI runs over the last ${ctx.flow?.days ?? 14} days.` : ''
  if (c.ci === 'running') {
    if (!c.stage_at || !ctx.now) return undefined
    const so = spanText(Math.max(0, ctx.now - c.stage_at))
    return { text: median ? `${so} / ~${spanText(median)}` : so, title: `CI running ${so} so far, since its first check started.${usual}` }
  }
  if (!c.ci_ms) return undefined
  const vs = vsMedianText(c.ci_ms, median)
  return {
    text: vs ? `${spanText(c.ci_ms)} ${vs.text}` : spanText(c.ci_ms),
    title: `CI took ${spanText(c.ci_ms)}, its first check’s start to its last one’s finish.${usual}`,
    tone: vs?.tone === 'warn' ? 'warn' : undefined,
  }
}

/** The agent spend recorded on a row, as the Work board says it; "—" when none was. */
export function costOf(it: WorkItem): PlanRow['cost'] {
  if (it.costUsd === undefined) return { text: '—', title: 'No Caprock session was recorded on it, so no agent cost is said.', known: false }
  const n = it.card && it.card.spend.sessions > 0 ? it.card.spend.sessions : it.sessions.length
  return { text: fmtUSD(it.costUsd), title: `${fmtUSD(it.costUsd)} of agent work over ${n} session${n === 1 ? '' : 's'}, at API list price, not a bill.\n${AGENT_COST_NOTE}`, known: true }
}

/**
 * The session a row opens (owner, 2026-10-17, translated, of an idle agent's
 * row: "from here I want to go into the session"): of the live sessions on
 * it, the newest that is not idle, else the newest.
 */
export function pickSession(ss: readonly WorkSession[], now?: number): PlanRow['session'] {
  if (!ss.length) return undefined
  const newest = (xs: readonly WorkSession[]) => xs.reduce((a, b) => (b.started_at > a.started_at ? b : a))
  const awake = now === undefined ? ss : ss.filter((x) => !isIdle(x, now))
  const s = newest(awake.length ? awake : ss)
  return { id: s.session_id, owned: s.owned, name: s.name || s.project || s.session_id.slice(0, 8) }
}

/** One board row as a plan row: its blocks, its word, a landing label over the word, what it waits for, its age and CI per OS. */
export function rowOf(it: WorkItem, labels?: BranchPR['labels'], ctx: RowContext = {}): PlanRow {
  const landing = it.kind === 'pr' ? landingOf(labels) : undefined
  // A pull request's age is since it was opened; an agent's, since its first session.
  const started = (it.kind === 'pr' ? it.pr?.created_at : undefined) ?? it.startedAt
  return {
    key: it.key,
    number: it.pr?.number,
    title: it.title,
    url: it.pr?.url,
    stage: it.stage,
    section: it.kind === 'pr' ? (it.stage === 'merged' ? 'merged' : 'pr') : 'agent',
    filled: Math.max(0, Math.min(BLOCKS, it.fill * PER_STEP)),
    red: it.red || !!landing?.red,
    warn: !landing?.red && !!landing?.warn,
    // An agent's row says in its word that no pull request is open yet, at
    // any width (owner, 2026-10-17: a bare bar and "agent" said nothing).
    word: landing?.word ?? (it.kind === 'session' && it.word === 'agent' ? 'no PR yet' : it.word),
    wordTitle: landing ? `Set by the landing queue; on the board: ${it.word}` : it.kind === 'session' && it.word === 'agent' ? 'An agent is on it; it has not opened a pull request yet.' : undefined,
    running: it.running || (it.kind === 'session' && it.working),
    wait: waitOf(it, landing, ctx),
    age: started && ctx.now ? { text: ageText(ctx.now - started), title: `${it.kind === 'pr' ? 'Opened' : 'Started'} ${spanText(Math.max(0, ctx.now - started))} ago` } : undefined,
    ci: it.kind === 'pr' && it.stage !== 'merged' ? osDots(it.card?.os, ctx.now) : undefined,
    ciTime: ciTimeOf(it, ctx),
    cost: costOf(it),
    session: pickSession(it.sessions, ctx.now),
  }
}

const mergedAt = (it: WorkItem) => it.pr?.merged_at ?? 0

/**
 * One repository's rows: the next release's — merged since the last tag,
 * open pull requests, agents with no pull request — furthest along first,
 * and later's drafts and idle agents. Released, closed, tasks and queued
 * messages are not the release's.
 */
export function planRows(items: readonly WorkItem[], idle: readonly WorkItem[], root: string, lastTagAt: number | undefined, prs: readonly BranchPR[] = [], ctx: RowContext = {}, ships?: ShipsBy): { rows: PlanRow[]; later: PlanGroup[]; merged: number } {
  const labels = new Map(prs.map((p) => [p.number, p.labels]))
  const mine = (it: WorkItem) => it.repo?.root === root
  const next: WorkItem[] = []
  const drafts: WorkItem[] = []
  const done: WorkItem[] = []
  for (const it of items) {
    if (!mine(it)) continue
    if (it.kind === 'session') { next.push(it); continue }
    if (it.kind !== 'pr' || it.stage === 'released' || it.stage === 'planned') continue
    // Where work ships on merge, a merge is done: no release to wait for.
    if (it.stage === 'merged' && ships === 'merge') { done.push(it); continue }
    // Merged before the last tag: in that tag, though no GitHub release says so.
    if (it.stage === 'merged' && lastTagAt && mergedAt(it) > 0 && mergedAt(it) <= lastTagAt) continue
    if (it.word === 'draft') drafts.push(it)
    else next.push(it)
  }
  next.sort((a, b) => b.fill - a.fill || (a.stage === 'merged' ? mergedAt(a) - mergedAt(b) : (a.pr?.number ?? Infinity) - (b.pr?.number ?? Infinity)))
  const later: PlanGroup[] = []
  if (done.length) {
    const recent = [...done].sort((a, b) => mergedAt(b) - mergedAt(a)).slice(0, MERGED_RECENT)
    later.push({
      key: 'merged', label: 'Merged recently · shipped when merged',
      rows: recent.map((it) => ({ ...rowOf(it, labels.get(it.pr?.number ?? -1), ctx), wait: undefined, wordTitle: 'Merged: the last step here. This repository cuts no releases, so work ships when it merges.' })),
    })
  }
  if (drafts.length) later.push({ key: 'drafts', label: 'Later · drafts, not yet ready for review', rows: drafts.map((it) => rowOf(it, labels.get(it.pr?.number ?? -1), ctx)) })
  const sleeping = idle.filter(mine)
  if (sleeping.length) {
    later.push({
      key: 'idle', label: 'Not in a release yet · agents waiting for you, idle 30+ min',
      rows: sleeping.map((it) => ({ ...rowOf(it, undefined, ctx), word: 'idle', wordTitle: 'At its prompt for over 30 minutes, waiting for you; it has not opened a pull request yet.' })),
    })
  }
  return { rows: next.map((it) => rowOf(it, labels.get(it.pr?.number ?? -1), ctx)), later, merged: next.filter((it) => it.stage === 'merged').length }
}

/**
 * The line under the version, in plain words (owner, 2026-10-17: "0 merged
 * since v0.129.0 · 9m ago · usual gap 1h 58m (median of 10)" read as
 * nothing): *Nothing new since v0.129.0, released 9m ago*, or *3 changes
 * waiting for the next release · last release v0.129.0, 9m ago*. The usual
 * gap, with MIN_GAPS behind it, is on hover only.
 */
export function sinceLine(last: { name: string; at: number } | undefined, merged: number, repo: WorkRepo | undefined, stats: SessionCIStats | undefined, now: number): ReleasePlanData['since'] {
  if (!last) return undefined
  const flow = asBoard(stats?.board)?.flow
  let median = repo?.tags?.gap_median_ms
  let n = repo?.tags?.gaps ?? 0
  if (!median || n < MIN_GAPS) { median = flow?.release_gap_median_ms; n = flow?.release_gap_count ?? 0 }
  const ago = `${gapText(now - last.at)} ago`
  const text = merged > 0
    ? `${merged} change${merged === 1 ? '' : 's'} waiting for the next release · last release ${last.name}, ${ago}`
    : `Nothing new since ${last.name}, released ${ago}`
  const what = merged > 0
    ? `${merged} pull request${merged === 1 ? '' : 's'} merged since ${last.name}, not in a release yet.`
    : `No pull request merged since ${last.name}.`
  const usual = median && n >= MIN_GAPS
    ? ` Releases here usually come ${gapText(median)} apart: the median gap between the last ${n + 1}. When the next one comes is your call.`
    : ' Too few releases here to say a usual gap.'
  return { text, title: what + usual }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * The pushed branches heading for the release: on origin, ahead of the
 * default branch, committed in the last 14 days, with no pull request (none
 * in the branch's own read nor in the Pipeline's list by head), and not
 * already on the default branch by content (`landed`: a squash merge, or
 * inside a batch). The newest BRANCHES_LISTED; each titled by its last
 * commit's subject, its word the commits ahead and its age.
 */
export function branchRows(br: SessionBranches | undefined, prs: readonly BranchPR[], now: number, repo?: string): PlanRow[] {
  if (!br?.branches?.length) return []
  const headed = new Set(prs.map((p) => p.head).filter((h): h is string => !!h))
  return br.branches
    .filter((b) => !b.default && b.remote && (b.ahead ?? 0) > 0 && !b.pr && !headed.has(b.name) && !b.landed && b.committed_ms > 0 && now - b.committed_ms <= BRANCH_RECENT_MS)
    .sort((a, b) => b.committed_ms - a.committed_ms)
    .slice(0, BRANCHES_LISTED)
    .map((b): PlanRow => {
      const n = b.ahead ?? 0
      const age = ageText(now - b.committed_ms)
      const base = br.base ?? br.default ?? 'the default branch'
      return {
        key: `b:${b.name}`,
        title: b.subject || b.name,
        branch: b.name,
        url: repo && br.default ? `https://github.com/${repo}/compare/${encodeURIComponent(br.default)}...${b.name.split('/').map(encodeURIComponent).join('/')}` : undefined,
        stage: 'branch', section: 'branch', filled: PER_STEP, red: false, warn: false, running: false,
        word: `${plural(n, 'commit')} · pushed ${age} ago`,
        wordTitle: `${b.name}: pushed, ${plural(n, 'commit')} ahead of ${base}, the last ${spanText(Math.max(0, now - b.committed_ms))} ago; no pull request yet.`,
        age: { text: age, title: `Last commit ${spanText(Math.max(0, now - b.committed_ms))} ago` },
        cost: b.sessions > 0
          ? { text: fmtUSD(b.cost_usd), title: `${fmtUSD(b.cost_usd)} of agent work over ${plural(b.sessions, 'session')} on this branch, at API list price, not a bill.\n${AGENT_COST_NOTE}`, known: true }
          : { text: '—', title: 'No Caprock session was recorded on this branch, so no agent cost is said.', known: false },
      }
    })
}

/** The session's working subagents, newest first, the first SUBAGENTS_LISTED: what each was asked, and for how long it has worked. */
export function subagentRows(subs: SubagentsNow | undefined, now: number): PlanRow[] {
  return [...(subs?.working ?? [])]
    .sort((a, b) => b.started_at - a.started_at)
    .slice(0, SUBAGENTS_LISTED)
    .map((a): PlanRow => {
      const task = a.description || a.doing || a.agent_type || 'A subagent'
      const title = `Agent: ${task}`
      const age = ageText(now - a.started_at)
      return {
        key: `sa:${a.agent_id}`,
        title,
        stage: 'agent', section: 'agent', filled: PER_STEP, red: false, warn: a.asking, running: !a.asking,
        word: a.asking ? 'asking' : `working ${age}`,
        wordTitle: a.asking ? 'This subagent waits on a permission prompt.' : `A subagent of this session${a.agent_type ? ` (${a.agent_type})` : ''}, working for ${spanText(Math.max(0, now - a.started_at))}, ${plural(a.tool_calls, 'call')} so far.`,
        wait: a.doing && a.doing !== task ? { text: a.doing, title: `Now: ${a.doing}` } : undefined,
        age: { text: age, title: `Started ${spanText(Math.max(0, now - a.started_at))} ago` },
        cost: a.cost_usd !== undefined
          ? { text: fmtUSD(a.cost_usd), title: `${fmtUSD(a.cost_usd)} of this subagent's own calls so far, at API list price, not a bill.`, known: true }
          : { text: '—', title: 'Its cost is not known yet.', known: false },
      }
    })
}

/** The rows by section, in SECTION_ORDER, each named with its count; empty sections left out. */
export function planSections(rows: readonly PlanRow[]): { key: RowSection; label: string; hint: string; rows: PlanRow[] }[] {
  const label: Record<RowSection, (n: number) => string> = {
    merged: (n) => `In this release · ${n} merged`,
    pr: (n) => `Pull requests · ${n} open`,
    branch: (n) => `Branches pushed, no PR yet · ${n}`,
    agent: (n) => `Agents working now · ${n}`,
  }
  const hint: Record<RowSection, string> = {
    merged: 'Already merged: ships with the next release',
    pr: 'Open pull requests, with how far each has got',
    branch: 'Will go into the next batch PR',
    agent: 'Subagents of this session, at work now',
  }
  return SECTION_ORDER.map((key) => {
    const rs = rows.filter((r) => r.section === key)
    return { key, label: label[key](rs.length), hint: hint[key], rows: rs }
  }).filter((s) => s.rows.length > 0)
}

/** What a session adds to its repository's plan: its pushed branches and its working subagents (the right panel). */
export interface PlanExtra {
  branches?: SessionBranches
  subagents?: SubagentsNow
}

/** The plan of one repository, from the board's rows and what is read of the repository. */
export function releasePlan(input: { root: string; name?: string; repo?: WorkRepo; stats?: SessionCIStats; items: readonly WorkItem[]; idle?: readonly WorkItem[]; now: number; extra?: PlanExtra }): ReleasePlanData {
  const { root, repo, stats, now } = input
  const board = asBoard(stats?.board)
  const rel = board?.releases?.[0]
  // The last tag as git has it; else the newest published GitHub release.
  const last = repo?.tags?.last ?? (rel ? { name: rel.tag, at: rel.published_at } : undefined)
  const ships = board?.ships_by
  const planned = planRows(input.items, input.idle ?? [], root, last?.at, stats?.prs ?? [], { now, flow: board?.flow }, ships)
  const { later, merged } = planned
  const added = [...branchRows(input.extra?.branches, stats?.prs ?? [], now, stats?.repo ?? input.extra?.branches?.repo), ...subagentRows(input.extra?.subagents, now)]
  const rows = [...planned.rows, ...added].sort((a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section))
  const name = input.name ?? repo?.name ?? root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? root
  if (ships === 'merge') {
    return {
      root, name, rows, later, ships,
      since: { text: SHIPS_ON_MERGE, title: 'No release is published on GitHub and no version tag was made in the last 180 days, so merged is the last step here: there is no next release to wait for.' },
    }
  }
  const next = nextVersion(last?.name, repo?.unreleased)
  return {
    root,
    name,
    next,
    since: sinceLine(last, merged, repo, stats, now),
    rows: ships === 'release' ? rows.map((r) => waitsForRelease(r, next?.version)) : rows,
    later,
    ships,
  }
}

/**
 * A merged row where releases are cut says what it waits for: *the next
 * release (v0.133.0)*, the number when the rule predicts one.
 */
export function waitsForRelease(r: PlanRow, version: string | undefined): PlanRow {
  if (r.stage !== 'merged') return r
  const what = `the next release${version ? ` (v${version})` : ''}`
  return {
    ...r,
    wordTitle: r.wordTitle ?? `Merged; waits for ${what}`,
    wait: r.wait && !r.wait.tone ? { ...r.wait, text: what, title: r.wait.title.replace(/^Merged: it ships with the next release/, `Merged: it ships with ${what}`) } : r.wait,
  }
}

/** Nothing to say: no rows, nothing later (merges already shipped aside), no version. */
export function planEmpty(p: ReleasePlanData): boolean {
  return p.rows.length === 0 && p.later.every((g) => g.key === 'merged') && !p.next
}

const NO_WORK: Work = { now: 0, day_start: 0, sessions: [], hive: 'off', queued: [], repos: [], totals: { live: 0, working: 0, waiting_you: 0, today_usd: 0, machine_today_usd: 0 } }

/**
 * One repository's plan for a page that reads one Pipeline answer (the
 * Pipeline page, the right panel): the board built from the Work answer, when
 * there is one, and that answer alone. Without the Work answer there are no
 * agent rows and no version, only the pull requests.
 */
export function planForRepo(work: Work | undefined, root: string, stats: SessionCIStats | undefined, now: number, extra?: PlanExtra): ReleasePlanData {
  const w = work ? { ...work, tasks: [], queued: [] } : NO_WORK
  const board = buildWork(w, new Map([[root, stats]]), now)
  const repo = work?.repos?.find((r) => r.root === root)
  return releasePlan({ root, repo, stats, items: board.items, idle: board.idle, now, extra })
}
