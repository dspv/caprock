/**
 * What the session deck's pull request rows say about a PR beyond its CI,
 * and the words of the force actions (owner, 2026-10-12, translated: "From
 * the PRs I want to see, for example, when there's a conflict, or that you
 * (an agent) are looking at it or fixing it — and if needed I want to FORCE
 * a fix or a check"). Pure: the deck draws and sends; this decides.
 * .ai/21-app.md § Session deck, PRs view.
 */
import { ApiError, type SessionPRLive, type SessionSummary } from './api'
import type { PullRequest } from './github'
import type { Dot } from './sidebar'
import { sessionTitle } from './sidebar'

/** One word on the row, coloured: what stands between the PR and a merge. */
export type PRChipWord = 'conflict' | 'behind' | 'review' | 'draft'
export interface PRChip { word: PRChipWord; tone: 'fail' | 'warn' | 'muted'; title: string }

/**
 * The state chips of an open pull request, from what GitHub already said of
 * it (`mergeable`, `mergeable_state`, the review, the draft flag): conflict
 * (cannot merge: GitHub's mergeable false or state dirty), behind (GitHub's
 * own `behind`, which it reports when the base must be merged in first),
 * review (changes requested) and draft. GitHub still computing mergeability
 * (null, `unknown`) says nothing rather than guess.
 */
export function prChips(p: SessionPRLive): PRChip[] {
  const pr = p.live
  if (!pr || pr.state !== 'open') return []
  const out: PRChip[] = []
  const ms = (pr.mergeable_state ?? '').toLowerCase()
  const conflict = pr.mergeable === false || ms === 'dirty'
  if (conflict) out.push({ word: 'conflict', tone: 'fail', title: `GitHub says #${pr.number} cannot be merged as it is: it conflicts with ${pr.base || 'its base'}` })
  else if (ms === 'behind') out.push({ word: 'behind', tone: 'warn', title: `GitHub says ${pr.branch || 'the branch'} is behind ${pr.base || 'its base'}: the base must be merged in before it can merge` })
  if (pr.review === 'changes_requested') out.push({ word: 'review', tone: 'fail', title: 'A reviewer requested changes' })
  if (pr.draft) out.push({ word: 'draft', tone: 'muted', title: 'A draft: not ready for review' })
  return out
}

export function hasConflict(p: SessionPRLive): boolean { return prChips(p).some((c) => c.word === 'conflict') }
export function isBehind(p: SessionPRLive): boolean { return prChips(p).some((c) => c.word === 'behind') }

/** A checkout of the session's project and the live agents in it, as the sidebar knows them. */
export interface DeckWorktree {
  branch: string
  path: string
  agents: { session: SessionSummary; dot: Dot }[]
}

/** An agent on a PR's branch, with the word its mark says. */
export interface PRAgent { session: SessionSummary; word: 'fixing' | 'waiting' | 'idle'; initial: string; title: string }

/** The word for an agent on the branch: fixing while it works, waiting while it waits on you, else idle. */
export function agentWord(dot: Dot): PRAgent['word'] {
  return dot === 'working' || dot === 'looping' ? 'fixing' : dot === 'waiting' ? 'waiting' : 'idle'
}

/**
 * The live agent sessions whose checkout is on the PR's head branch: who is
 * on it. Shells and ended sessions are not; the branch is the checkout's own
 * (the sidebar's worktree row), so a session in another clone of the same
 * name is not counted.
 */
export function prAgents(branch: string | undefined, worktrees: DeckWorktree[] | undefined): PRAgent[] {
  if (!branch || !worktrees) return []
  const out: PRAgent[] = []
  for (const w of worktrees) {
    if (w.branch !== branch) continue
    for (const a of w.agents) {
      if (a.session.status === 'ended' || a.session.kind === 'shell') continue
      const name = sessionTitle(a.session)
      const word = agentWord(a.dot)
      out.push({ session: a.session, word, initial: (name.trim()[0] ?? '?').toUpperCase(), title: `${name} — ${word} on ${branch}${a.session.owned ? '' : '\nNot started by Caprock: watched, never typed into'}` })
    }
  }
  // The one working first, then the one waiting on you.
  const rank = { fixing: 0, waiting: 1, idle: 2 }
  return out.sort((a, b) => rank[a.word] - rank[b.word])
}

/** The checkout on the PR's branch, if the project has one. */
export function branchWorktree(branch: string | undefined, worktrees: DeckWorktree[] | undefined): DeckWorktree | undefined {
  return branch ? worktrees?.find((w) => w.branch === branch) : undefined
}

/** An agent Caprock may type into: one it started, still running here (rule 7). */
export function typeable(s: SessionSummary): boolean {
  return s.owned && s.status !== 'ended' && !s.detached && s.kind !== 'shell'
}

/** The worktree name a new agent fixing PR #n gets: its branch is caprock/<name>, at the PR's head. */
export function fixWorktreeName(n: number): string { return `pr-${n}-fix` }

/** Where a pushed fix goes: the PR's head branch, whatever the local branch is called. */
function pushLine(pr: Pick<PullRequest, 'branch'>, fresh: boolean): string {
  return fresh && pr.branch
    ? `Push to the pull request's branch: git push origin HEAD:${pr.branch}`
    : `Push to ${pr.branch ? `the pull request's branch, ${pr.branch}` : 'the same branch'}.`
}

/**
 * The message Fix conflict with agent sends: merge the base in, resolve,
 * check, push. `fresh` is a new worktree at the PR's head, whose local
 * branch is not the PR's: the push names the remote branch.
 */
export function fixConflictMessage(pr: Pick<PullRequest, 'number' | 'title' | 'url' | 'base' | 'branch'>, fresh = false): string {
  const base = pr.base || 'main'
  return [
    `Pull request #${pr.number}${pr.title ? ` "${pr.title}"` : ''} (${pr.url}) has merge conflicts with ${base}.`,
    `Fetch, then merge origin/${base} into this branch (git fetch origin && git merge origin/${base}), resolve the conflicts keeping both sides' intent, run the project's checks, and commit the merge.`,
    pushLine(pr, fresh),
  ].join('\n')
}

/**
 * The message Fix CI with agent sends when no job failed in the run read —
 * a flaky check, or one the user wants looked at anyway. A failed job sends
 * Investigate's message instead (investigateMessage), with its log.
 */
export function fixCIMessage(pr: Pick<PullRequest, 'number' | 'title' | 'url' | 'branch'>, fresh = false): string {
  return [
    `Look at the CI of pull request #${pr.number}${pr.title ? ` "${pr.title}"` : ''} (${pr.url}/checks).`,
    'Its checks have been unreliable: find the flaky or failing part (read the runs with gh run list / gh run view --log-failed), fix the cause rather than retrying, and run the checks locally.',
    pushLine(pr, fresh),
  ].join('\n')
}

/** A force action's failure in a line, with the permission GitHub asked for. */
export function forceErrText(e: unknown): string {
  if (e instanceof ApiError) {
    const b = e.body as { error?: string; needs?: string[] } | undefined
    const head = b?.error ?? e.message
    return b?.needs?.length ? `${head} Needs the token's ${b.needs.join(' or ')}.` : head
  }
  return e instanceof Error ? e.message : String(e)
}

/** "re-running 3 jobs…", "re-running 1 job…". */
export function rerunText(jobs: number): string {
  return jobs > 0 ? `re-running ${jobs} ${jobs === 1 ? 'job' : 'jobs'}…` : 're-running…'
}

/** What a PR row is doing after a force action, until GitHub shows it done. */
export interface PRProgress {
  kind: 'agent' | 'rerun' | 'update'
  text: string
  at: number
  /** The head when it began: an update or the agent's push moves it. */
  head?: string
}

/** How long a progress line stays at most when nothing tells it is done. */
export const PROGRESS_MAX_MS = 4 * 60_000

/**
 * Whether a progress line still stands: a re-run until the checks run again,
 * an update until the head moves, an agent while it works on the branch or
 * until its push moves the head; any after PROGRESS_MAX_MS.
 */
export function progressStands(g: PRProgress, p: SessionPRLive, agents: PRAgent[], now: number): boolean {
  if (now - g.at > PROGRESS_MAX_MS) return false
  const live = p.live
  if (!live) return true
  const moved = !!g.head && live.head_sha !== g.head
  if (g.kind === 'rerun') return live.checks.state !== 'pending' || now - g.at < 5_000
  if (g.kind === 'update') return !moved
  // An agent: until it pushed, or it settled after having worked.
  return !moved && (now - g.at < 30_000 || agents.some((a) => a.word === 'fixing'))
}
