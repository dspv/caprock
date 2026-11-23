/**
 * The right panel's *Release* section as release notes (.ai/04-ui.md §
 * Release plan, *The right panel*; owner, 2026-11-19, translated: "the
 * Release section is unclear, it looks more like a list of PRs" — variant
 * A, with B's next step in the folded line). Pure; drawn by
 * components/ReleasePlan CockpitRelease.
 *
 *   Next release 0.183.1 · patch · last release 8h ago
 *   ◉──○──○──○──○  Waiting for #949 to merge
 *   ────────────────────────────────────────
 *   FIXED
 *    PR from another repo no longer shows as this one's
 *   ────────────────────────────────────────
 *   via #949 ● green · ready to merge
 *   Not in it yet: 1 branch, no PR        ▸
 *
 * - **The heading** (`notesHeading`) says the release in one line: the
 *   predicted version named as the next release, with its bump and why,
 *   *Releasing 0.183.1* while something runs (*Release 0.183.1* when
 *   not), *0.183.1 released · 5 min ago* within the hour of its
 *   publishing, *Nothing new since v0.183.0 · 8h ago* otherwise.
 * - **The entries** (`notesOf`, `groupNotes`) are the changelog fragments'
 *   own words, grouped by kind in Keep a Changelog order: those on the
 *   default branch and those the open batch pull request carries
 *   (`WorkRepo.unreleased.entries`), or, once the release is cut, its
 *   released section (`WorkRepo.released`).
 * - **The via line** (`viaLine`) is the batch pull request as one line: its
 *   number, its checks and whether it can merge, read from its board card.
 * - **Not in it yet** (`notInIt`) folds what is on its way but not in it:
 *   pushed branches with no pull request and any other open pull request.
 */
import type { WorkEntry, WorkRepo } from './api'
import type { BoardCard } from './prboard'
import type { PlanRow } from './releaseplan'
import { ageText, landingOf } from './releaseplan'
import type { BranchPR } from './branches'
import { agoText, OUT_RECENT_MS, plainVersion, releasePRVersion, stageWords, stripStages, type ReleaseStatus } from './releasestatus'

/** Keep a Changelog's kinds, in its order; entries of no kind come last, as *Other*. */
export const KIND_ORDER = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'] as const

export interface NoteGroup {
  /** The kind, or "Other" for entries that say none. */
  kind: string
  entries: WorkEntry[]
}

/** Entries by kind, in KIND_ORDER, then the ones of no kind; each group keeps the entries' order. */
export function groupNotes(entries: readonly WorkEntry[]): NoteGroup[] {
  const by = new Map<string, WorkEntry[]>()
  for (const e of entries) {
    const k = KIND_ORDER.find((x) => x.toLowerCase() === e.kind?.toLowerCase()) ?? 'Other'
    by.set(k, [...(by.get(k) ?? []), e])
  }
  return [...KIND_ORDER, 'Other'].filter((k) => by.has(k)).map((kind) => ({ kind, entries: by.get(kind)! }))
}

/** A CHANGELOG first line in plain words, for a daemon that sends no entries: the scope off, markdown dropped. */
export function plainItem(item: string): WorkEntry {
  const m = /^\*\*([^*]+?):\*\*\s*/.exec(item)
  const text = (m ? item.slice(m[0].length) : item)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*([^*]+?)\*\*/g, '$1').replace(/(^|[^\w*])\*([^*\s][^*]*?)\*/g, '$1$2').replace(/`/g, '')
  return { text: text.trim(), scope: m?.[1]?.trim() }
}

/** What the heading says the release is. */
export type NotesState = 'idle' | 'out' | 'waiting' | 'shipping'

export interface NotesHeading {
  state: NotesState
  /** "Next release 0.183.1", "Releasing 0.183.1", "0.183.1 released", "Nothing new since v0.183.0". */
  text: string
  /** The text in a narrow panel, when it differs: "Next 0.183.1". */
  short?: string
  /** "patch": the bump word, its reason on hover, with a version predicted. */
  why?: { text: string; title: string }
  /** "last release 8h ago", "5 min ago", "8h ago": the last release's age. */
  age?: string
  /** The age said only where the line has room (400px and up): a bare *27m ago* beside a version read as the version's age. */
  ageWide?: boolean
  title: string
}

/** A release is shipping: its pull request listed, or its tag pushed and not yet published. */
export function shipping(s: ReleaseStatus): boolean {
  return s.phase === 'tagged' || !!s.pr
}

/**
 * The heading's one line, from the release status and the last tag:
 * shipping, out within the hour, waiting with a version (or *Next
 * release* when the rule cannot say), else nothing new.
 */
export function notesHeading(s: ReleaseStatus, lastTag: { name: string; at: number } | undefined, now: number): NotesHeading {
  const last = s.last
  if (shipping(s)) {
    const v = s.version ?? 'the next release'
    // *Releasing* only while something runs (owner, 2026-11-20): over a
    // stopped build or a release pull request waiting for a merge it would
    // say the opposite of the words under it.
    const moving = stageWords(s, stripStages(s), { now })?.tone === 'active'
    return { state: 'shipping', text: `${moving ? 'Releasing' : 'Release'} ${v}`, why: whyWords(s), title: s.why?.title ?? `Release ${v}: the dots under this line say where it is.` }
  }
  if (s.phase === 'idle') {
    if (last && now - last.at < OUT_RECENT_MS) {
      return { state: 'out', text: `${plainVersion(last.tag) ?? last.tag} released`, age: agoText(now - last.at), title: `${last.tag} was published on GitHub ${agoText(now - last.at)}.` }
    }
    const tag = lastTag?.name ?? last?.tag
    const at = lastTag?.at ?? last?.at
    return {
      state: 'idle', text: tag ? `Nothing new since ${tag}` : 'Nothing new since the last release', age: at ? ago(now - at) : undefined,
      title: tag ? `No changelog entry waiting and nothing merged since ${tag}.` : 'No changelog entry waiting and nothing merged.',
    }
  }
  const at = lastTag?.at ?? last?.at
  // Owner, 2026-11-20: a bare *0.185.1* did not say what the number is.
  return {
    state: 'waiting', text: s.version ? `Next release ${s.version}` : 'Next release', short: s.version ? `Next ${s.version}` : undefined, why: whyWords(s),
    // Narrow, *Next 0.185.3 · patch · fixes only* (owner, 2026-11-23,
    // variant 1A): a bare *27m ago* there was read as the version's age, so
    // the last release's age goes, and stays on the version's hover.
    age: at ? `last release ${ago(now - at)}` : undefined, ageWide: at ? true : undefined,
    title: `${s.why?.title ?? 'No version is predicted: some changelog entries say no kind, or no tag was read to count from.'}${at ? `\nLast release ${ago(now - at)}.` : ''}`,
  }
}

/** "8h ago", "just now". */
const ago = (ms: number) => { const t = ageText(ms); return t === 'now' ? 'just now' : `${t} ago` }

/**
 * "patch · fixes only", "minor · a feature": the bump and its reason
 * (owner, 2026-11-23, variant 1A: *patch · 27m ago* did not say why it is a
 * patch); the rule behind it on hover.
 */
function whyWords(s: ReleaseStatus): NotesHeading['why'] {
  if (!s.bump || !s.why) return undefined
  const reason = s.bump === 'minor' ? 'a feature' : s.bump === 'patch' ? 'fixes only' : 'a breaking change'
  return { text: `${s.bump} · ${reason}`, title: `${s.bump}: ${reason}.\n${s.why.title}` }
}

/**
 * The entries the section lists: the release being shipped (or just out)
 * says its released section's, when the CHANGELOG has one by that version;
 * otherwise what waits — the default branch's fragments and the batch pull
 * request's. Nothing when idle.
 */
export function notesOf(repo: WorkRepo | undefined, h: NotesHeading, s: ReleaseStatus): WorkEntry[] {
  if (!repo) return []
  const released = repo.released
  const version = h.state === 'out' ? plainVersion(s.last?.tag) : s.version
  if ((h.state === 'shipping' || h.state === 'out') && released && version && plainVersion(released.version) === version) return released.entries ?? []
  if (h.state === 'idle' || h.state === 'out') return []
  const u = repo.unreleased
  if (!u) return []
  return u.entries ?? u.items.map(plainItem)
}

/** The batch pull request: the newest open one that is not a release pull request. */
export function batchOf(prs: readonly BranchPR[], via?: number): BranchPR | undefined {
  const open = prs.filter((p) => p.state === 'open' && !releasePRVersion(p.title))
  return open.find((p) => p.number === via) ?? [...open].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0) || b.number - a.number)[0]
}

export interface ViaLine {
  number: number
  prTitle?: string
  /** "green", "CI red", "CI running", "a job not run", "no checks", "CI not read". */
  ci: { text: string; tone: 'ok' | 'fail' | 'pending' | 'warn' | 'muted' }
  /** "ready to merge", "needs a rebase", "go failed", "draft", "landing: queued". */
  state: { text: string; tone?: 'danger' | 'warn' }
  /** The next step it waits for, for the folded line: "merge #949", "wait for CI". */
  next: string
  title: string
}

/** The batch pull request as one line, from its board card and its labels; nothing guessed. */
export function viaLine(pr: BranchPR, card: BoardCard | undefined): ViaLine {
  const n = pr.number
  const landing = landingOf(pr.labels)
  const ci: ViaLine['ci'] = card?.ci === 'pass' ? { text: 'green', tone: 'ok' }
    : card?.ci === 'fail' || card?.why === 'ci' || landing?.red ? { text: 'CI red', tone: 'fail' }
      : card?.ci === 'running' ? { text: 'CI running', tone: 'pending' }
        : card?.ci === 'no_runner' ? { text: 'a job not run', tone: 'warn' }
          : card?.ci === 'none' ? { text: 'no checks', tone: 'muted' }
            : { text: 'CI not read', tone: 'muted' }
  const failed = card?.failed ?? []
  let state: ViaLine['state']
  let next: string
  if (ci.tone === 'fail') {
    // Plain words (owner, 2026-11-20: "fix: e2e (headless shell)" did not
    // read): the job's name without its matrix, *e2e failed*; all of them
    // by their whole names on hover.
    state = { text: failed.length ? `${failed[0]!.replace(/\s*\([^)]*\)\s*$/, '') || failed[0]} failed${failed.length > 1 ? ` +${failed.length - 1}` : ''}` : 'CI failed', tone: 'danger' }
    next = `fix CI on #${n}`
  } else if (landing && !landing.red) {
    state = { text: landing.word, tone: landing.warn ? 'warn' : undefined }
    next = landing.warn ? `merge #${n} by hand` : `#${n} landing`
  } else if (pr.draft) {
    state = { text: 'draft' }
    next = `mark #${n} ready`
  } else if (card?.why === 'conflict') {
    state = { text: 'needs a rebase', tone: 'danger' }
    next = `rebase #${n}`
  } else if (card?.why === 'changes_requested') {
    state = { text: 'changes requested', tone: 'danger' }
    next = `changes on #${n}`
  } else if (ci.tone === 'pending') {
    state = { text: 'checks running' }
    next = 'wait for CI'
  } else if (card?.stage === 'ready' && card.review === 'review_required') {
    state = { text: 'needs a review', tone: 'warn' }
    next = `review #${n}`
  } else if (card?.stage === 'ready') {
    state = { text: 'ready to merge' }
    next = `merge #${n}`
  } else {
    state = { text: 'open' }
    next = `merge #${n}`
  }
  const title = [`#${n}${pr.title ? ` ${pr.title}` : ''}: the batch pull request the entries from its branch ship in.`,
    ci.tone === 'fail' && failed.length ? `Failed: ${failed.join(', ')}.` : `Checks: ${ci.text}.`,
    `Next: ${next}.`].join('\n')
  return { number: n, prTitle: pr.title, ci, state, next, title }
}

export interface NotInIt {
  branches: PlanRow[]
  prs: PlanRow[]
  /** "1 branch, no PR · 1 other PR"; absent when there is nothing. */
  text?: string
}

/** What is on its way but not in the release: pushed branches with no pull request, and open pull requests that are neither the batch nor a release one. */
export function notInIt(rows: readonly PlanRow[], batch: number | undefined): NotInIt {
  const branches = rows.filter((r) => r.section === 'branch')
  const prs = rows.filter((r) => r.section === 'pr' && r.number !== batch && !releasePRVersion(r.title))
  const fresh = branches.filter((r) => !r.older).length
  const parts: string[] = []
  if (branches.length) parts.push(`${fresh || branches.length} ${(fresh || branches.length) === 1 ? 'branch' : 'branches'}, no PR`)
  if (prs.length) parts.push(`${prs.length} other PR${prs.length === 1 ? '' : 's'}`)
  return { branches, prs, text: parts.length ? parts.join(' · ') : undefined }
}
