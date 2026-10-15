/**
 * The Pipeline's count tiles that open the pull requests behind them
 * (.ai/04-ui.md § Pipeline; owner, 2026-10-15, translated: "I see the red
 * 'NEEDS A FIX 4' figure, but I can't see which PRs those are or whether
 * they were fixed"). In flight, Needs a fix and Ready are buckets of the
 * board's stages; a click filters the list to one, its hover names up to
 * five, and Needs a fix also says how many left it lately. Pure, but for
 * the small per-repository note of what was seen needing a fix.
 */
import type { BoardCard, PRBoard, Stage } from './prboard'
import type { BranchPR } from './branches'
import { failedTitle, stageOf, type JourneyInput } from './journey'

export type Bucket = 'flight' | 'fix' | 'ready'

export const BUCKET_LABEL: Record<Bucket, string> = { flight: 'In flight', fix: 'Needs a fix', ready: 'Ready' }

const STAGES_OF: Record<Bucket, readonly Stage[]> = { flight: ['draft', 'open', 'fix', 'ready'], fix: ['fix'], ready: ['ready'] }

export const isBucket = (k: string): k is Bucket => k === 'flight' || k === 'fix' || k === 'ready'

/** A row is in a bucket by its stage, its card's or its own. */
export function inBucket(r: JourneyInput, b: Bucket): boolean {
  const s = stageOf(r)
  return s !== 'closed' && STAGES_OF[b].includes(s)
}

/** Why a card is where it is, in the CI pill's words, and the hover's. */
export function reasonOf(c: Pick<BoardCard, 'stage' | 'ci' | 'why' | 'failed'>): { text: string; title: string; fail?: boolean } {
  if (c.why === 'conflict') return { text: 'Conflict', title: 'GitHub says it conflicts with its base branch', fail: true }
  if (c.why === 'changes_requested') return { text: 'Changes requested', title: 'A reviewer asked for changes', fail: true }
  if (c.why === 'ci' || c.ci === 'fail') return { text: 'CI red', title: failedTitle(c.failed), fail: true }
  if (c.stage === 'draft') return { text: 'Draft', title: 'Opened as a draft' }
  if (c.stage === 'ready') return { text: c.ci === 'none' ? 'No checks' : 'CI green', title: 'Waiting for a review or a merge' }
  return { text: c.ci === 'running' ? 'CI running' : 'Open', title: c.ci === 'running' ? 'Its checks are running' : 'Its checks were not read yet' }
}

export interface BucketItem { number: number; title: string; reason: string; reasonTitle: string; fail: boolean }

/** A bucket's pull requests as the tile's hover lists them, in the board's order. */
export function bucketItems(board: PRBoard, prs: readonly BranchPR[], b: Bucket): BucketItem[] {
  const titles = new Map(prs.map((p) => [p.number, p.title]))
  return board.cards.filter((c) => STAGES_OF[b].includes(c.stage)).map((c) => {
    const r = reasonOf(c)
    return { number: c.number, title: titles.get(c.number) || `#${c.number}`, reason: r.text, reasonTitle: r.title, fail: !!r.fail }
  })
}

// ---------------------------------------------------------------- fixed lately

/** How far back "fixed" counts. */
export const FIXED_WINDOW_MS = 24 * 3600_000

/**
 * What the page saw of Needs a fix in one repository: each pull request seen
 * in it (when first), and when it was seen out of it. Built only from the
 * board answers the page already reads, so "fixed" is what this browser saw
 * leave the bucket — never a guess about the time it was not open.
 */
export interface FixSeen { [pr: string]: { in: number; out?: number } }

/** The note after one more answer: a card in fix is (still) in; one seen in that is now in another stage left it then. */
export function noteFixes(prev: FixSeen, cards: readonly Pick<BoardCard, 'number' | 'stage'>[], now: number): FixSeen {
  const out: FixSeen = {}
  const stage = new Map(cards.map((c) => [c.number, c.stage]))
  for (const [k, v] of Object.entries(prev)) {
    const st = stage.get(Number(k))
    // One gone from the board (closed unmerged) was not fixed.
    if (st === undefined) continue
    const left = st === 'fix' ? undefined : v.out ?? now
    // Kept a day past the window, then forgotten.
    if (left !== undefined && now - left > 2 * FIXED_WINDOW_MS) continue
    out[k] = left === undefined ? { in: v.in } : { in: v.in, out: left }
  }
  for (const c of cards) if (c.stage === 'fix' && !out[c.number]) out[c.number] = { in: now }
  return out
}

/** How many left Needs a fix within the window. */
export function fixedLately(seen: FixSeen, now: number): number {
  return Object.values(seen).filter((v) => v.out !== undefined && now - v.out <= FIXED_WINDOW_MS).length
}

const FIX_KEY = 'caprock.pipeline.fixSeen:'

export function readFixSeen(repo: string): FixSeen {
  try {
    const v = JSON.parse(localStorage.getItem(FIX_KEY + repo) ?? '{}') as unknown
    return v && typeof v === 'object' ? v as FixSeen : {}
  } catch { return {} }
}

export function writeFixSeen(repo: string, seen: FixSeen) {
  try { localStorage.setItem(FIX_KEY + repo, JSON.stringify(seen)) } catch { /* this view only */ }
}
