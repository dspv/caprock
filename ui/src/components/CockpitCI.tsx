/**
 * The cockpit's CI block. Its first view, *PRs*, is the repository's pull
 * requests in flight as progress bars toward a release (owner, 2026-10-14, translated:
 * "roughly the current size, showing PRs as progress bars toward release;
 * scrollable; we see PR statuses and CI statuses; from there you can expand
 * to a bigger block, and open the separate page"): each row its number, its
 * title, the three steps Open → CI → Merged as a thin bar with the step it
 * is on coloured — its CI's colour on the CI step, a merge filling it — its
 * release as a quiet word (*in v1.4.0*, *not released*) and how long it has
 * been there; the same steps the Pipeline page's rows draw (lib/journey).
 * The list scrolls inside the block; *Expand* makes it taller (remembered),
 * *Pipeline →* opens the page (→, not ↗: it stays in Caprock). It reads the Pipeline's own answer
 * (…/ci/stats, kept by the daemon), asked while the window is shown —
 * folded too, at the same idle pace, for the folded line below — and draws
 * the copy last kept at once.
 *
 * In flight only (owner, 2026-10-16, translated: "on the right it sometimes
 * shows too many PRs, e.g. for caprock-web"): the open pull requests and
 * the ones merged since the newest release, still heading to one
 * (lib/journey `inFlight`); released and closed-unmerged ones are dropped.
 * A repository with no published release (caprock-web pushes its changelog
 * syncs straight to master and tags nothing) has only its open ones in
 * flight. With nothing in flight it says so in one quiet line — *Nothing in
 * flight · last release v0.124.0, 2h ago* — over the three newest merges.
 *
 * (owner, 2026-10-13, translated: "I'd like to move
 * some CI/CD indicators into the right part — try making the indicator switch
 * between views right away, we'll see what sticks"): the session's pull
 * requests and their checks, in one of three views kept per viewer —
 * each PR's checks in one short group (the default: "✗ 1 failed ✓ 11", every check on hover), one ring with "10/11 · 4m" and the time
 * against the median, or the newest PR's checks by runner OS (ByOS). A click
 * opens the Pipeline page. Each tab names what it shows on hover. Hovering a
 * PR's checks lists them only after the pointer rests there, beside the
 * panel rather than over it (CheckSummary `beside`).
 *
 * Ring and By OS draw the session's own newest PR when it was read with its
 * checks (lib/deckCache, `prs:<session>` and `ci:<session>:<pr>`, redrawn
 * when either is told something new). Without one they draw the newest
 * in-flight PR of the same …/ci/stats answer the PRs view reads, asking
 * that PR's checks themselves (…/ci?pr=, kept as `ci:<session>:<pr>`) while
 * the view is shown unfolded (owner, 2026-10-16, translated: "the Ring mode
 * is empty"). With nothing in flight they say so in the same one line;
 * with neither answer kept the block is not drawn.
 *
 * A PR row of the session's own carries what the session deck's rows had
 * until the deck was removed (owner, 2026-10-20): the one most relevant
 * action — Resolve conflict, Update branch, Fix CI or Re-run — asked once in
 * the row (lib/usePRForce, the Pipeline page's own), asked in a few words on
 * one line (*Ask to fix #977 CI? Confirm Cancel*, the whole sentence on
 * hover), and a grey line with its agent cost and who is on it. Under the
 * list one link: *#977 log in Pipeline →* while a listed PR fails (the
 * Pipeline on that PR, its failed job's log and Investigate), else
 * *Pipeline →*; the per-row *Log in Pipeline →* went (owner, 2026-11-20:
 * two links, "the difference is unclear"). The session's pull requests (`prs:<session>`) are asked here, folded
 * too; the Pipeline page asks the same route under the same key. A listed
 * open PR the session did not record whose board card says its checks
 * failed has its checks read too (`RowChecksRead`, three at most) and then
 * offers Fix CI the same way (owner, 2026-11-23: #1042, opened from a
 * subagent's branch, had no Fix CI anywhere); folded, such a PR leads the
 * line over the session's own open one while that one is not failing.
 *
 * With GitHub connected and a repository, the block is never left out:
 * nothing in flight is one quiet line, folded with the newest merge (*Nothing
 * in flight · last: #1041 merged 2h ago*), and a refused read with nothing
 * in it never replaces the kept list (lib/ci keepStats).
 *
 * Folded, the block is two lines (owner, 2026-11-18): the PR it summarizes
 * — number and title, cut with an ellipsis — and the age; under them its
 * checks and the one action the state calls for (Fix CI on a real failure;
 * Rerun and the *Always rerun these* switch on a job GitHub never gave a
 * machine; nothing while running or green). The PR is the one the unfolded
 * views draw too (`lead`), counted by the same function (lib/ci
 * checkCounts), so folded and unfolded never disagree. It is the session's
 * own newest PR and its checks, drawn only once that read landed since the
 * block was drawn, the time beside it that read's. A copy kept from before is never drawn there
 * as running (owner, 2026-10-23: "#801 · 4 running · 11h" of a PR merged 11
 * hours earlier); unfolded, a kept copy not read again yet is timed as of its
 * read, so its elapsed time does not grow. When the session's own newest PR
 * is not open (merged, closed, or none with checks) and the repository has
 * an open one in flight, the line is that open PR's checks instead of
 * "#930 merged" (owner, 2026-11-17, translated: "in this mode I don't see CI
 * statuses"; the release PR a script opened was running CI): its checks are
 * asked folded only while it is the line.
 *
 * On a tab switch the line is drawn at once from the answers kept for that
 * repository (owner, 2026-11-18, translated: "I switch to the tab and only
 * after ~10 s the CI data comes"): the Pipeline answer (`stats:<repository>`),
 * the session's pull requests (`prs:<session>`) and the open PR's checks,
 * kept per repository (`ci:<repository>:<pr>`) so a tab of another session
 * on the same repository draws what this one read. A kept copy is drawn
 * muted, beside its own age, until the read since the block was drawn
 * lands; one older than KEPT_FOLD_MS waits for that read, so a copy of
 * hours ago never claims checks are running (the 2026-10-23 "#801 · 4
 * running · 11h").
 *
 * Unfolded alike (owner, 2026-11-20, translated: "I open it, see red, click
 * around and it fixes itself"): the list, Ring and By OS drawn from a kept
 * copy older than KEPT_FAINT_MS while it is read again are faint
 * (KEPT_CLASS), the age beside the label *as of 25 min ago*; full strength
 * once the read lands (useKeptCopy, lib/usePoll).
 */
import { useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { api, isPairedDevice, type SessionCI, type SessionCIStats, type SessionPRLive, type SessionPRs, type SessionSummary, type WorkRepo } from '@/lib/api'
import { githubApi, githubErrorText, useGitHubStatus, type AutoRerun, type PRCheck, type PullRequest } from '@/lib/github'
import { AUTO_RERUN_HINT, NO_RUNNER_TITLE, autoRerunWords, checkCounts, ciActive, type CheckCounts, type ChecksSummary, foreignRepo, keepStats, orderPRs, osName, osRollup, prChecks, readCockpitCIView, repoShort, runVsMedian, saveCockpitCIView, fmtRun, type CockpitCIView } from '@/lib/ci'
import { freshText, isReading, keptAt, KEPT_FAINT_MS, onDeckAnswer, readDeck, workRepoKey } from '@/lib/deckCache'
import { asBoard } from '@/lib/prboard'
import { tabRows, spanText } from '@/lib/prstats'
import { failingFlightLead, failsCI, flightLead, inFlight, mergedLine, openFlightLead, journey, pipelineRows, releaseNote, shipsOf, stageOf, type Flight, type PipelineRow, type ShipsContext } from '@/lib/journey'
import { landingOf, nextVersion, onMaster } from '@/lib/releaseplan'
import { CheckSummary, StateMark, type CheckFit } from './CheckSummary'
import { FitSummary } from './FitSummary'
import { SectionLabel, useFolded } from './Cockpit'
import { JourneyBar, JourneyLegend, ReleaseNoteWord } from './Journey'
import { CI_IDLE_MS, CI_RUNNING_MS, PRS_PENDING_MS, usePoll } from '@/lib/usePoll'
import { costText, costTitle } from '@/lib/prboard'
import { titleIsNumber } from '@/lib/work'
import { prAgents, quickActions, type DeckWorktree } from '@/lib/prforce'
import { FORCE_TITLE, usePRForce, type ForceKind } from '@/lib/usePRForce'
import { PipelineHostContext } from '@/lib/pipelineHost'
import { useCanControl } from '@/lib/useCanControl'
import { sessionTitle } from '@/lib/sidebar'
import { keys } from '@/lib/appkeys'

/** How old a kept copy may be to draw the folded line before the read lands: the daemon's own limit on a kept answer (deckMaxStale). */
export const KEPT_FOLD_MS = 3_600_000

/** The pull request the Ring and By OS views draw, with its checks. */
type LeadPR = { number: number; live: PullRequest }

/** A PR's number as the block says it: "#247", or "caprock-web #247" for one opened in another repository than `own`. */
function prNoText(p: LeadPR, own: string | undefined): string {
  const other = foreignRepo(p.live, own)
  return other ? `${repoShort(other)} #${p.number}` : `#${p.number}`
}

/** The most listed PRs, not the session's own, whose checks the list reads so their row offers Fix CI. */
const ROW_READS = 3

/** Redraws when an answer kept under a key starting with prefix changes; '' listens to none. */
function useDeckTick(prefix: string) {
  const [, bump] = useState(0)
  useEffect(() => {
    if (!prefix) return
    return onDeckAnswer((k) => { if (k.startsWith(prefix)) bump((x) => x + 1) })
  }, [prefix])
}

/** Reads one listed PR's checks while drawn, kept under cacheKey (lib/deckCache): nothing on screen of its own. */
function RowChecksRead({ sessionId, num, cacheKey }: { sessionId: string; num: number; cacheKey: string }) {
  usePoll<SessionCI>(true, `cockpit-ci-row:${sessionId}:${num}`, () => api.sessionCI(sessionId, num), (d) => ciActive(d.ci), CI_RUNNING_MS, cacheKey)
  return null
}

/** The most pull requests the PRs view lists (it scrolls). */
const LISTED = 40

/** The PRs view's height, and taller once expanded (remembered per viewer). */
const TALL_KEY = 'caprock.cockpit.pipeline.tall'
function readTall(): boolean {
  try { return localStorage.getItem(TALL_KEY) === '1' } catch { return false }
}

// Each tab says what it shows, on hover and to a screen reader (owner,
// 2026-10-14, translated: "OS mode is unclear").
const VIEWS: { v: CockpitCIView; label: string; title: string }[] = [
  { v: 'dots', label: 'PRs', title: 'PRs: the repository’s pull requests in flight — open, or merged since the last release — on their way to a release, as progress bars' },
  { v: 'ring', label: 'Ring', title: 'Ring: the newest pull request’s checks as one ring — done of all, the time, and against your usual run' },
  { v: 'grid', label: 'By OS', title: 'By OS: the newest pull request’s checks by runner — Linux, macOS, Windows — each with its state and longest time' },
]

/** The answer last kept under key (lib/deckCache), redrawn when a new one is kept. */
export function useDeckAnswer<T>(key: string): { d?: T; at?: number } {
  const snap = useSyncExternalStore(
    (cb) => onDeckAnswer((k) => { if (k === key) cb() }),
    () => readDeck<T>(key),
  )
  return { d: snap?.d, at: snap?.at }
}

/**
 * Whether the copy kept under key is drawn as kept — faint, as of its age —
 * and that age's moment (owner, 2026-11-20, translated: "I open it, see red,
 * click around and it fixes itself"): while a read of it is under way and
 * the copy is older than KEPT_FAINT_MS (lib/usePoll marks it), and on the
 * first draw, before that poll has had a chance to mark it, when the copy is
 * that old. Full strength once the read lands.
 */
export function useKeptCopy(key: string): { kept: boolean; at?: number } {
  const reading = useSyncExternalStore(
    (cb) => onDeckAnswer((k) => { if (k === key) cb() }),
    () => isReading(key),
  )
  useDeckAnswer<unknown>(key)
  const [drawn, setDrawn] = useState(false)
  useEffect(() => { setDrawn(true) }, [])
  const at = key ? keptAt(readDeck(key)) : undefined
  const old = at !== undefined && Date.now() - at >= KEPT_FAINT_MS
  return { kept: reading || (!drawn && old), at }
}

/** How a kept copy is drawn while it is read again: faint, its colours dulled, never full-strength red or green. */
export const KEPT_CLASS = 'opacity-70 saturate-50'

/** "as of 25 min ago": a kept copy's age, as the CI line says it. */
export function asOfText(ms: number): string {
  return `as of ${freshText(ms).replace('updated ', '').replace('just now', 'now')}`
}

/**
 * Where a PR's checks stand: how many of each, and how long since the first
 * started. The counts are lib/ci checkCounts — the folded line, the rows,
 * Ring and By OS all count through it, so they never disagree.
 */
export function checkSummary(items: PRCheck[], now: number): CheckCounts & { ms?: number } {
  const c = checkCounts(items)
  let start = Infinity, end = 0
  for (const x of items) {
    if (x.started_at) start = Math.min(start, x.started_at)
    end = Math.max(end, x.completed_at || 0)
  }
  const done = c.running === 0 && c.queued === 0
  const ms = start === Infinity ? undefined : Math.max(0, (done ? end : now) - start)
  return { ...c, ms: ms || undefined }
}

/** The one action a PR row of the inspector offers, worded short for its narrow column. */
const ACTION_LABEL: Record<ForceKind, string> = { conflict: 'Resolve conflict', ci: 'Fix CI', rerun: 'Re-run', update: 'Update branch' }

/** A failed read's answer never replaces a list that had live rows (as the Pipeline keeps it). */
const keepPRs = (prev: SessionPRs, next: SessionPRs) => !!next.refreshing && next.prs.every((p) => !p.live) && prev.prs.some((p) => !!p.live)

export function CockpitCI({ sessionId, repoScope, onOpen, s }: { sessionId: string; repoScope?: string; onOpen?: (pr?: number) => void; s?: SessionSummary }) {
  const [view, setViewState] = useState<CockpitCIView>(readCockpitCIView)
  const setView = (v: CockpitCIView) => { setViewState(v); saveCockpitCIView(v) }
  const [tall, setTallState] = useState(readTall)
  const setTall = (v: boolean) => { setTallState(v); try { localStorage.setItem(TALL_KEY, v ? '1' : '0') } catch { /* this page only */ } }
  const folded = useFolded()
  // The Pipeline's answer, folded too: folded, its open PR in flight is the
  // line when the session's own is not open. The daemon keeps the composed
  // answer and the reads it draws on (the pull request list 2 minutes, the
  // runs 30), and the pace is the idle one either way, so folding costs
  // GitHub nothing more than unfolded does.
  // A refused read with nothing in it never replaces the kept list (lib/ci
  // keepStats, as the Pipeline page reads it): without it one refused read
  // wiped the copy, and the block hid and the Release section lost its
  // release pull request (2026-11-23).
  const [stats, statsAt, statsMeta] = usePoll<SessionCIStats>(!!onOpen, `cockpit:${sessionId}`, () => api.sessionCIStats(sessionId), () => false, CI_IDLE_MS, `stats:${repoScope || sessionId}`, keepStats)
  const board = useMemo(() => asBoard(stats?.board), [stats?.board])
  const allRows = useMemo(() => pipelineRows(tabRows('repo', [], stats?.prs ?? []), board, stats?.prs ?? []), [stats?.prs, board])
  const flight = useMemo(() => {
    const f = inFlight(allRows, board)
    return { ...f, rows: f.rows.slice(0, LISTED) }
  }, [allRows, board])
  // The next version as the Release section predicts it (lib/releaseplan
  // releasePlan): the last tag, else the newest release, and the changelog
  // entries on the default branch — from the repository's entry of the Work
  // answer the Release section keeps (`work:<root>`), so nothing more is asked.
  const keptRepo = useDeckAnswer<WorkRepo>(repoScope ? workRepoKey(repoScope) : '')
  const next = useMemo(() => board?.ships_by === 'release' ? nextVersion(keptRepo.d?.tags?.last?.name ?? board.releases?.[0]?.tag, onMaster(keptRepo.d?.unreleased))?.version : undefined, [board, keptRepo.d])
  const ships = useMemo(() => shipsOf(board, next), [board, next])
  const hasStats = !!stats?.connected && (stats.prs?.length ?? 0) > 0
  // The repository was read (or refused) at all: the block stays drawn, one
  // quiet line when nothing is in flight, never gone (owner, 2026-11-23).
  const hasRepo = hasStats || (!!stats?.connected && !!stats.repo)
  // The session's own pull requests with what GitHub says of each (`prs:`,
  // the key the Pipeline page shares): their state, checks and merge state
  // say which action a row offers. Asked folded too: folded, the newest of
  // them is the block's one line, and a line drawn from the copy kept hours
  // ago said "4 running · 11h" of a pull request merged long before (owner,
  // 2026-10-23). The daemon answers from the reads it keeps per pull request
  // (github.PullByURL), so a poll costs GitHub nothing between them.
  const [n, setN] = useState(0)
  const [prsPolled, prsAt, prsMeta] = usePoll<SessionPRs>(!!onOpen, `cockpit-prs:${sessionId}:${n}`, () => api.sessionPRs(sessionId), (d) => d.prs.some((p) => p.live?.checks.state === 'pending'), PRS_PENDING_MS, `prs:${sessionId}`, keepPRs)
  const prs = { d: prsPolled, at: prsAt || undefined }
  // The repository's owner/name: a pull request the session opened in
  // another one is labelled with that one's name, leads only when this one
  // has none open, and never stands for a row of this repository's list.
  const own = stats?.repo
  const rows = orderPRs(prs.d?.prs ?? [], own).filter((p) => !!p.live)
  const mine = useMemo(() => new Map((prs.d?.prs ?? []).filter((p) => !foreignRepo(p, own)).map((p) => [p.number, p])), [prs.d, own])
  // The force actions the deck had, on the row of the PR they apply to
  // (lib/usePRForce, shared with the Pipeline page): each asks once, in the row.
  const host = useContext(PipelineHostContext)
  const canControl = useCanControl()
  const worktrees = host.worktreesOf?.(sessionId)
  const why = !s ? 'The session is not listed.' : !canControl ? 'This device can only watch. To act from it, open the Caprock app on your computer: Settings → Use on your phone, then press Allow control next to this device.'
    : !s.owned ? 'Caprock did not start this session, so it never types into it.'
      : s.status === 'ended' || s.detached ? 'This session is no longer running here, so nothing can be queued to it.' : ''
  const kit = usePRForce({
    sessionId, s: s ?? ({ session_id: sessionId } as SessionSummary), worktrees, onToast: host.onToast, canControl, connected: prs.d?.connected, why,
    onStartAgent: host.onStartAgent ? (req, title) => host.onStartAgent!(req, title, sessionId) : undefined,
    runsOf: (p) => (ciAnswerFor(p.number)),
    onDone: () => setN((x) => x + 1),
  })
  // The session's own newest PR when it was read with checks, else the newest in flight.
  const ownLead = prs.d?.connected && (rows[0]?.live?.checks.items.length ?? 0) > 0 ? rows[0] : undefined
  const flown = ownLead ? undefined : flightLead(flight)
  const leadNo = ownLead?.number ?? flown?.number ?? 0
  // Folded, when the session's own newest PR with checks is not open, the
  // repository's open PR in flight (read since the block was drawn) is the line.
  // One opened in another repository is not this one's open PR: the repository's own open one in flight leads over it.
  const ownOpen = ownLead?.live?.state === 'open' && !foreignRepo(ownLead, own)
  // A kept copy young enough to draw before its read lands (KEPT_FOLD_MS).
  const young = (at: number | undefined) => !!at && Date.now() - at < KEPT_FOLD_MS
  // When the session's own newest PR is not open, the repository's open PR
  // in flight is the one the block summarizes — folded and unfolded alike.
  // A failing open PR of the repository leads over the session's own open
  // one while that one is not failing (owner, 2026-11-23: #1042 failed, opened
  // from a subagent's branch, and Fix CI was nowhere): the line is where the
  // one action the state calls for is.
  const statsReady = statsMeta.confirmed || young(statsAt)
  const ownFails = ownOpen && ownLead?.live?.checks.state === 'fail'
  const failPick = statsReady && !ownFails ? failingFlightLead(flight, ownOpen ? ownLead?.number : undefined) : undefined
  const repoPick = failPick ?? (!ownOpen && statsReady ? openFlightLead(flight) : undefined)
  const ciNo = repoPick?.number ?? leadNo
  // A PR's checks are kept per repository when the block knows it, so a tab
  // of another session on the same repository draws them at once; the
  // Pipeline page keeps them per session (`ci:<session>:<pr>`), the newer wins.
  const ciKeyOf = (num: number) => (repoScope ? `ci:${repoScope}:${num}` : `ci:${sessionId}:${num}`)
  const ciRepo = useDeckAnswer<SessionCI>(ciNo ? ciKeyOf(ciNo) : '')
  const ciOwn = useDeckAnswer<SessionCI>(ciNo && repoScope ? `ci:${sessionId}:${ciNo}` : '')
  const ci = (ciOwn.at ?? 0) > (ciRepo.at ?? 0) ? ciOwn : ciRepo
  // Which of the copies drawn are kept ones still being read again: drawn
  // faint, as of their age, until the read lands (useKeptCopy).
  const statsKept = useKeptCopy(`stats:${repoScope || sessionId}`)
  const prsKept = useKeptCopy(`prs:${sessionId}`)
  const ciKept = useKeptCopy(ciNo ? ciKeyOf(ciNo) : '')
  // A PR's runs, when its CI was read (the Pipeline page or the lead's poll): Fix CI sends the failed job with its log.
  function ciAnswerFor(num: number) {
    const a = readDeck<SessionCI>(ciKeyOf(num)), b = readDeck<SessionCI>(`ci:${sessionId}:${num}`)
    const c = ((b?.at ?? 0) > (a?.at ?? 0) ? b : a)?.d
    return c?.pr?.number === num ? c.ci?.runs : undefined
  }
  // That PR's checks: while the repository's open PR is the one summarized
  // (its row and the folded line draw them), else only for Ring and By OS
  // shown unfolded when the session has no PR of its own with checks.
  const askCI = !!onOpen && ciNo > 0 && (repoPick ? true : view !== 'dots' && !folded && !ownLead)
  // The listed open PRs whose checks failed that the session did not record
  // (one a subagent's branch opened, one past the session's newest four):
  // their checks are read while the list is shown, so their row offers Fix
  // CI with the failed job and its log (owner, 2026-11-23: #1042 was red
  // and no Fix CI showed). At most ROW_READS, the newest first.
  const rowReads = !!onOpen && !!s && !folded && view === 'dots'
    ? flight.rows.filter((r) => failsCI(r) && !mine.get(r.number)?.live && !(askCI && r.number === ciNo)).slice(0, ROW_READS).map((r) => r.number)
    : []
  useDeckTick(rowReads.length > 0 ? 'ci:' : '')
  // A listed PR's state as its own checks' read says, when read.
  const readLive = (num: number) => {
    const a = readDeck<SessionCI>(ciKeyOf(num)), b = readDeck<SessionCI>(`ci:${sessionId}:${num}`)
    const c = ((b?.at ?? 0) > (a?.at ?? 0) ? b : a)?.d
    return c?.pr?.number === num ? c.pr.live : undefined
  }
  const [, ciAt, ciMeta] = usePoll<SessionCI>(askCI, `cockpit-ci:${sessionId}:${ciNo}`, () => api.sessionCI(sessionId, ciNo), (d) => ciActive(d.ci), CI_RUNNING_MS, ciNo ? ciKeyOf(ciNo) : undefined)
  const ownL: LeadPR | undefined = ownLead?.live ? { number: ownLead.number, live: ownLead.live } : undefined
  const repoLive = repoPick && ci.d?.pr?.number === repoPick.number ? ci.d.pr.live : undefined
  // Over the session's own open PR only while its checks still fail.
  const repoLead: LeadPR | undefined = repoPick && repoLive?.state === 'open' && repoLive.checks.items.length > 0 && (!ownOpen || repoLive.checks.state === 'fail') ? { number: repoPick.number, live: repoLive } : undefined
  const flownL: LeadPR | undefined = flown && ci.d?.pr?.number === flown.number && ci.d.pr.live ? { number: flown.number, live: ci.d.pr.live } : undefined
  // The one PR the block summarizes, folded and unfolded (owner, 2026-11-18:
  // the folded line and the unfolded views must say the same): the
  // session's own newest when open, else the repository's open one in
  // flight, else the session's own newest, else the newest in flight. Its
  // counts everywhere come from one function over the same checks
  // (lib/ci prChecks → checkNodes → countNodes).
  const lead: LeadPR | undefined = repoLead ?? ownL ?? flownL
  // A copy kept from before, not read again since the block was drawn, is
  // timed as of when it was read: a check it says runs is not still running
  // now, and its elapsed time does not grow (the read, once it lands, moves it).
  const fresh = lead === ownL ? prsMeta.confirmed : ciMeta.confirmed
  // Folded, the line is the session's own newest PR, once it was read since
  // the block was drawn or from a copy kept less than KEPT_FOLD_MS ago (the
  // PRs it reads are asked folded too). When that PR is not open, the
  // repository's open PR in flight takes the line, once its checks say it is
  // still open — read since, or kept that recently — so a copy of hours ago
  // never claims checks are running.
  const foldOwn = folded && ownL && (prsMeta.confirmed || young(prs.at)) ? ownL : undefined
  const foldRepoLead = folded && repoLead && (ciMeta.confirmed || young(ci.at)) ? repoLead : undefined
  const foldLead = foldRepoLead ?? foldOwn
  const foldIsRepo = !!foldLead && foldLead === foldRepoLead
  // The line drawn from a kept copy not read again since the block was drawn: muted, timed as of its read.
  const foldKept = !!foldLead && !(foldIsRepo ? ciMeta.confirmed : prsMeta.confirmed)
  const foldElse = foldLead ? foreignRepo(foldLead.live, own) : undefined
  // The repository's PR acts on what its checks' read says, even when the
  // session recorded it too (its own row may carry no live read).
  const foldPR: SessionPRLive | undefined = foldLead
    ? (foldIsRepo ? undefined : ownLead) ?? { ...(mine.get(foldLead.number) ?? { session_id: sessionId, url: foldLead.live.url, number: foldLead.number, last_at: 0 }), live: foldLead.live }
    : undefined
  const running = rows.some((p) => p.live?.checks.state === 'pending') || lead?.live.checks.state === 'pending' || foldLead?.live.checks.state === 'pending'
  // A clock only while a check runs and the window is shown: the elapsed time moves.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (!running) return
    const t = window.setInterval(() => { if (!document.hidden) setNow(Date.now()) }, 1000)
    return () => window.clearInterval(t)
  }, [running, prs.at, ci.at])
  // Hidden only where there is nothing to read: no answer yet, GitHub not
  // connected, or no GitHub repository here.
  if (!hasRepo && !ownLead) return null
  const leadAt = lead === ownL && ownL ? prs.at : (ci.at || ciAt)
  const leadNow = fresh || !leadAt ? now : Math.min(now, leadAt)
  const foldAt = foldIsRepo ? (ci.at || ciAt) : foldLead ? prs.at : undefined
  const leadSum = foldLead ? prChecks(foldLead, foldKept && foldAt ? Math.min(now, foldAt) : now) : undefined
  // Merged, what comes next: its row of the repository's list (its card says
  // the release); one in another repository says *Merged* alone.
  const foldMerged = foldLead?.live.state === 'merged'
    ? (foldElse ? mergedLine(undefined) : mergedLine(allRows.find((r) => r.number === foldLead.number && !r.foreign) ?? foldLead.live, ships, board?.releases))
    : undefined
  // The time beside the line is the time of what it shows.
  const at = folded ? foldAt : view === 'dots' ? (stats?.read_at || stats?.fetched_at || statsAt) : leadAt
  const refused = !hasStats && stats?.error ? stats.error.message : undefined
  const quiet = hasRepo && flight.rows.length === 0 ? <Quiet f={flight} now={now} refused={refused} /> : null
  const listed = flight.rows.length > 0 ? flight.rows : flight.recent
  // What the view in front draws from a kept copy being read again: the
  // list from the Pipeline answer (and the session's own PRs' checks), Ring
  // and By OS from their PR's checks; folded, the line's own (foldKept).
  const listKept = statsKept.kept || (prsKept.kept && rows.length > 0)
  const leadKept = lead === ownL && ownL ? prsKept.kept : ciKept.kept
  const viewKept = folded ? foldKept : view === 'dots' ? listKept : leadKept
  // One door to the Pipeline under the list (owner, 2026-11-20, translated:
  // two links, "Log in Pipeline →" and "Pipeline →" — "the difference is
  // unclear, keep one"): on the failing pull request's log when one is
  // listed, the first of them; else the Pipeline.
  const failingNo = listed.find((r) => r.card?.stage === 'fix' || r.mine?.live?.checks.state === 'fail' || (lead?.number === r.number && lead.live.checks.state === 'fail'))?.number

  const faint = (text: string) => <span className="text-[11.5px] text-fg-faint">{text}</span>
  const checksOf = (draw: (p: LeadPR) => ReactNode) =>
    lead ? draw(lead) : quiet ?? (flown ? faint(ci.d?.pr?.number === flown.number ? `#${flown.number}’s checks could not be read.` : `Reading #${flown.number}’s checks…`) : faint('Reading the repository’s pull requests…'))
  const body = view === 'ring' ? checksOf((p) => <Ring p={p} ci={ci.d} now={leadNow} own={own} />) : view === 'grid' ? checksOf((p) => <ByOS p={p} ci={ci.d} now={leadNow} own={own} />) : (
    !hasRepo ? faint('Reading the repository’s pull requests…') : (
      <div data-cockpit-ci-body-kept={listKept ? '' : undefined} title={listKept && at ? `${asOfText(now - at)} — being read again` : undefined} className={`grid gap-1${listKept ? ` ${KEPT_CLASS}` : ''}`}>
      {quiet}
      {listed.length > 0 && <JourneyLegend className="-mr-1.5 pr-1.5" />}
      {listed.length > 0 && <ul data-cockpit-journey className={`app-scroll -mr-1.5 grid content-start gap-1.5 overflow-y-auto pr-1.5 ${tall ? 'max-h-[440px]' : 'max-h-[176px]'}`}>
        {listed.map((r) => {
          // The session's own, else one of the repository's whose checks were
          // read: Fix CI acts on any listed PR (the daemon's force routes take
          // a PR the PRs & CI tab listed).
          const mp = mine.get(r.number)
          const rl = !mp?.live && !r.foreign && r.state === 'open' ? readLive(r.number) : undefined
          const p: SessionPRLive | undefined = rl ? { ...(mp ?? { session_id: sessionId, url: r.url, number: r.number, title: r.title, last_at: 0 }), live: rl } : mp
          const agents = p ? prAgents(p.live?.branch, worktrees) : []
          const acts = !!s && !!p && (quickActions(p).length > 0 || kit.confirm?.pr === p.number || !!kit.standing(p, agents, now))
          // The row's checks: the same PR's, read the same way, as the
          // folded line counts them (the summarized PR's own copy when it is this one).
          const rowLive = lead?.number === r.number ? lead.live : p?.live
          const sum = rowLive?.state === 'open' ? prChecks({ live: rowLive }, now) : undefined
          return <JourneyRow key={r.number} r={r} now={now} ships={ships} sum={sum}
            act={acts && p ? <RowAction p={p} kit={kit} worktrees={worktrees} now={now} /> : null}
            agent={agents[0]}
            idle={sum?.counts.norunner ?? 0}
            auto={rowLive?.state === 'open' ? rowLive.checks.auto_rerun : undefined} />
        })}
      </ul>}
      {rowReads.map((num) => <RowChecksRead key={num} sessionId={sessionId} num={num} cacheKey={ciKeyOf(num)} />)}
      </div>
    )
  )

  return (
    <section aria-label="CI" data-cockpit-ci={view} data-checks-edge className="grid gap-2">
      <SectionLabel
        // Folded, two lines (owner, 2026-11-18): the PR it summarizes — its
        // number and title — beside the label, the age at the right; under
        // them its checks at the left and the one action the state calls for
        // at the right. Never a third line.
        after={folded && !foldLead && hasRepo && flight.rows.length === 0 ? (
          // Nothing in flight, folded: one quiet line, never a section gone
          // (owner, 2026-11-23: *Nothing in flight · last: #1041 merged 2h ago*).
          <span data-fold-only data-cockpit-ci-fold-quiet className="flex min-w-0 flex-1"><Quiet f={flight} now={now} refused={refused} short /></span>
        ) : foldLead ? (
          <span data-fold-only data-cockpit-ci-fold-pr={foldLead.number} className="flex min-w-0 flex-1 items-baseline gap-1.5 text-[11.5px]"
            title={`${foldIsRepo ? (ownOpen ? `#${foldLead.number}: the repository’s open pull request whose checks failed — this session’s own did not fail` : `#${foldLead.number}: the repository’s open pull request — this session’s own is not open`) : foldElse ? `${foldElse} #${foldLead.number}: this session’s pull request in another repository` : `#${foldLead.number}: this session’s newest pull request`}\n${foldLead.live.title}`}>
            <span data-cockpit-ci-fold-repo={foldElse} className="num shrink-0 text-fg-muted">{prNoText(foldLead, own)}</span>
            <span className="min-w-0 truncate text-fg">{foldLead.live.title}</span>
          </span>
        ) : undefined}
        sub={leadSum && foldLead ? (
          <span data-fold-only data-cockpit-ci-fold={foldLead.number} data-cockpit-ci-fold-of={foldIsRepo ? 'repo' : 'session'} data-cockpit-ci-kept={foldKept ? '' : undefined}
            title={foldKept ? 'As last read, while it is read again' : undefined} className={`@container flex min-w-0 flex-1 items-center gap-2${foldKept ? ` ${KEPT_CLASS}` : ''}`}>
            {/* Merged or closed, its checks are history: "merged" says
              * more than "all 1" (owner, 2026-10-27: "there is zero info here").
              * Merged, a green check and what comes next (owner, 2026-11-20,
              * translated: a grey "merged" was "cramped and visually unclear";
              * variant A): *✓ Merged · goes out in 0.185.1*, *· released in
              * 0.185.1*; one line, the muted part cut first. */}
            {foldMerged
              ? (
                <span data-cockpit-ci-merged={foldMerged.released ? 'released' : foldMerged.tail ? 'waits' : 'done'} title={foldMerged.title}
                  className="flex min-w-0 flex-1 items-center gap-1.5 whitespace-nowrap text-[11.5px]">
                  <StateMark tone="pass" />
                  <span className="shrink-0 text-ok">Merged</span>
                  {foldMerged.tail && <span className="min-w-0 truncate text-fg-muted">· {foldMerged.tail}</span>}
                </span>
              )
              : foldLead.live.state === 'closed'
              ? <span className="min-w-0 flex-1 text-[11.5px] text-fg-muted" title="Closed without a merge: it will not ship">Closed</span>
              // Shortened, never cut at the panel's edge (owner, 2026-11-18):
              // the skipped count goes first, then the words, then all but
              // the worst state (CheckSummary `fit`, FitSummary).
              // The bar shrinks first (96 → 64 → 40 px), then the words go.
              // A segment per check (owner, 2026-11-19: one check said
              // nothing of how full the run is).
              : <FitSummary className="justify-items-start" variants={FOLD_FITS.map(([f, w]) => (
                <CheckSummary key={`${f}${w}`} s={leadSum} fit={f} bar={w} label={foldIsRepo ? `#${foldLead.number}, the repository’s open pull request: its checks` : `${prNoText(foldLead, own)}: its checks`} focusable={false} beside className="shrink-0" />
              ))} />}
            {foldLead.live.state === 'open' && (
              <span data-cockpit-ci-fold-act className="ml-auto flex shrink-0 items-center gap-2">
                {/* The one action the state calls for: Fix CI on a real
                  * failure; on a job GitHub never gave a machine, Rerun and
                  * the switch that makes Caprock do it (or what Caprock did).
                  * Each asks once, as every force action does. */}
                {leadSum.counts.fail > 0 && !!s && <FoldAction kind="ci" p={foldPR!} kit={kit} now={now} />}
                {leadSum.counts.fail === 0 && leadSum.counts.norunner > 0 && !!s && (
                  <FoldAction kind="rerun" p={foldPR!} kit={kit} now={now} />
                )}
                {foldLead.live.checks.auto_rerun
                  ? <AutoRerunWord a={foldLead.live.checks.auto_rerun} />
                  : leadSum.counts.fail === 0 && leadSum.counts.norunner > 0 && <AutoRerunSwitch short />}
              </span>
            )}
          </span>
        ) : undefined}
        right={(
        <span className="flex items-center gap-2">
          <span data-cockpit-ci-age data-cockpit-ci-age-kept={viewKept && at ? '' : undefined} className="shrink-0 whitespace-nowrap text-[10.5px] text-fg-faint" title={`${folded ? (foldIsRepo ? `When GitHub was last read for #${foldLead!.number}’s checks, the repository’s open pull request` : 'When GitHub was last read for this session’s pull requests') : view === 'dots' ? 'When GitHub was last read for the Pipeline' : lead === ownL && ownL ? 'When GitHub was last read for this session’s pull requests' : 'When GitHub was last read for this pull request’s checks'}${viewKept ? '. Drawn faint, as last read, while it is read again.' : ''}`}>{at ? (viewKept ? asOfText(now - at) : freshText(now - at).replace('updated ', '').replace('just now', 'now')) : ''}</span>
          {!folded && (
            <span role="tablist" aria-label="CI view" className="flex items-center gap-px rounded-[5px] border border-[var(--app-hairline)] p-px">
              {VIEWS.map((x) => (
                <button key={x.v} type="button" role="tab" aria-selected={view === x.v} data-cockpit-ci-view={x.v} title={x.title} aria-label={x.title} onClick={() => setView(x.v)}
                  className={`rounded-[4px] px-1.5 text-[10.5px] leading-[15px] ${view === x.v ? 'bg-[var(--app-row-hover)] text-fg' : 'text-fg-faint hover:text-fg-muted'}`}>{x.label}</button>
              ))}
            </span>
          )}
        </span>
      )}>CI</SectionLabel>
      {view === 'dots' ? (
        <>
          {body}
          {/* The link sits in the middle (owner, 2026-11-23: at the right it
              read as a gap before the next block); Expand keeps the left. */}
          <span className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-[11px]">
            {listed.length > 4 ? (
              <button type="button" data-cockpit-ci-tall aria-expanded={tall} onClick={() => setTall(!tall)} className="justify-self-start text-fg-faint hover:text-fg-muted">{tall ? 'Less' : 'Expand'}</button>
            ) : <span />}
            {onOpen && (failingNo
              ? <button type="button" data-cockpit-ci-open={failingNo} onClick={() => onOpen(failingNo)} title={`Open the Pipeline on #${failingNo}: its failed job, its steps and the end of its log, with Investigate`} className="min-w-0 truncate whitespace-nowrap text-accent hover:underline">#{failingNo} log in Pipeline →</button>
              : <button type="button" data-cockpit-ci-open onClick={() => onOpen()} title="Open the Pipeline: its own tab, beside the Dashboard" className="text-accent hover:underline">Pipeline →</button>)}
          </span>
        </>
      ) : (
        <button type="button" data-cockpit-ci-open onClick={() => onOpen?.()} disabled={!onOpen} title="Open the Pipeline page in a tab"
          className="-mx-1.5 rounded-[6px] px-1.5 py-1 text-left hover:bg-[var(--app-row-hover)] disabled:cursor-default disabled:hover:bg-transparent">
          <span data-cockpit-ci-body-kept={leadKept && lead ? '' : undefined} className={`block${leadKept && lead ? ` ${KEPT_CLASS}` : ''}`}>{body}</span>
        </button>
      )}
    </section>
  )
}

/**
 * One pull request's row: its number, title, time on its step and its steps
 * as a bar; a merge waiting for a release says so in a word ("next release",
 * "in v0.132.0"), the whole of it on hover.
 */
function JourneyRow({ r, now, ships, act, agent, idle = 0, auto, sum }: { r: PipelineRow; now: number; ships: ShipsContext; act?: ReactNode; agent?: { session: SessionSummary; word: string }; idle?: number; auto?: AutoRerun; sum?: ChecksSummary }) {
  const since = r.card?.stage_at ?? r.merged_at ?? r.created_at
  const steps = journey(r)
  const said = releaseNote(r, ships)
  // What its agents cost and who is on it, when Caprock knows: a grey line.
  const cost = r.card ? costText(r.card.spend) : ''
  const who = agent ? sessionTitle(agent.session) : r.card?.spend.agents.join(', ') ?? ''
  return (
    <li data-cockpit-ci-pr={r.number} data-stage={stageOf(r)} className="grid min-w-0 gap-1">
      <span className="flex min-w-0 items-center gap-1.5 text-[12px]">
        {!titleIsNumber(r.number, r.title) && <span className="num shrink-0 text-fg-muted">#{r.number}</span>}
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg" title={r.title}>{r.title}</span>
        {said && <ReleaseNoteWord note={said} className="shrink-0 text-[10.5px]" />}
        {since ? <span className="num shrink-0 text-[10.5px] text-fg-faint" title={new Date(since).toLocaleString()}>{spanText(Math.max(0, now - since))}</span> : null}
      </span>
      <JourneyBar steps={steps} landing={landingOf(r.labels)?.word} />
      {(cost || who || act || sum || auto) && (
        <span data-cockpit-ci-pr-meta className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-fg-faint">
          {/* Its checks, counted as the folded line counts them (one function, the same read). */}
          {sum && <span data-cockpit-ci-row-checks={r.number} data-cockpit-ci-norunner={idle || undefined} className="inline-flex shrink-0"><CheckSummary s={sum} label={`#${r.number}: its checks`} beside className="shrink-0 text-[10.5px]" /></span>}
          {auto ? <AutoRerunWord a={auto} /> : idle > 0 && <AutoRerunSwitch />}
          {(cost || who) && (
            <span className="min-w-[4rem] flex-1 truncate" title={[r.card && cost ? costTitle(r.card.spend) : '', agent ? `${sessionTitle(agent.session)} — ${agent.word}` : ''].filter(Boolean).join('\n')}>
              {cost && <span data-cockpit-ci-cost className="num">{cost}</span>}{cost && who ? ' · ' : ''}{who && <span data-cockpit-ci-agent>{who}</span>}
            </span>
          )}
          {act}
        </span>
      )}
    </li>
  )
}

type Kit = ReturnType<typeof usePRForce>

const AUTO_TONE = { muted: 'text-fg-faint', norunner: 'text-norunner', danger: 'text-danger' } as const

/** "re-run by Caprock": Caprock re-ran this PR's jobs GitHub never gave a machine; when, and what came of it, on hover. */
function AutoRerunWord({ a }: { a: AutoRerun }) {
  const w = autoRerunWords(a)
  if (!w) return null
  return <span data-auto-rerun={a.error ? 'error' : a.again ? 'again' : 'done'} title={w.title} className={`min-w-0 shrink truncate whitespace-nowrap text-[10.5px] ${AUTO_TONE[w.tone]}`}>{w.text}</span>
}

/**
 * The switch Settings → GitHub has (*Rerun jobs GitHub never ran*), beside a
 * job GitHub never gave a machine: the same setting, ticked here or there.
 * Shown only on this computer (a paired device may not change it) and by a
 * daemon that has it. `short` is the folded line's one word.
 */
function AutoRerunSwitch({ short = false }: { short?: boolean }) {
  const { status, set } = useGitHubStatus()
  // The box moves at once; a refusal puts it back and says why on hover.
  const [want, setWant] = useState<boolean | undefined>(undefined)
  const [error, setError] = useState('')
  if (isPairedDevice() || !status?.connected || status.auto_rerun === undefined) return null
  const on = want ?? status.auto_rerun
  const busy = want !== undefined
  const flip = async (v: boolean) => {
    setWant(v)
    setError('')
    try { set(await githubApi.setAutoRerun(v)) } catch (e) { setError(githubErrorText(e)) } finally { setWant(undefined) }
  }
  return (
    <label data-auto-rerun-switch={short ? 'short' : 'full'} title={error || `${AUTO_RERUN_HINT}\nThe same switch as Settings → GitHub.`}
      className={`inline-flex min-w-0 shrink cursor-pointer items-center gap-1 whitespace-nowrap text-[10.5px] ${error ? 'text-danger' : 'text-fg-muted hover:text-fg'}`}>
      <input type="checkbox" checked={on} disabled={busy} onChange={(e) => void flip(e.target.checked)}
        aria-label="Always rerun jobs GitHub never ran" className="h-[11px] w-[11px] shrink-0 accent-[var(--color-accent)]" />
      {/* Folded, the words go before the line would overflow: under 400 px
        * of line only the box and ↻ stay, the whole of it on hover. */}
      {short ? (
        <>
          <span aria-hidden className="@min-[400px]:hidden">↻</span>
          <span className="hidden truncate @min-[400px]:inline">Always rerun these</span>
        </>
      ) : <span className="truncate">Always rerun these</span>}
    </label>
  )
}


/**
 * The folded line's one action: *Fix CI* on a real failure, *Rerun* on a job
 * GitHub never gave a machine (the tooltip saying why). A click asks once —
 * *Fix CI? / Re-run? Confirm · Cancel* — then says what it is doing until
 * GitHub shows the checks running again. They are the deck's own actions
 * (lib/usePRForce), refused with the reason on a device that may only watch.
 */
function FoldAction({ kind, p, kit, now }: { kind: 'ci' | 'rerun'; p: SessionPRLive; kit: Kit; now: number }) {
  const g = kit.standing(p, [], now)
  // One word on the narrow line, the whole of it on hover.
  if (g) return <span data-cockpit-ci-fold-progress title={g.text} className="shrink-0 whitespace-nowrap text-[11px] text-accent">{kind === 'ci' ? 'fixing…' : 're-running…'}</span>
  if (kit.confirm?.pr === p.number && kit.confirm.kind === kind) {
    return (
      <span data-cockpit-ci-fold-confirm className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px]">
        <span className="text-fg" title={kit.confirmText(p, kind)}>{kind === 'ci' ? 'Fix CI?' : 'Re-run?'}</span>
        <button type="button" data-cockpit-ci-fold-confirm-yes autoFocus onClick={() => void kit.force(p, kind)}
          className="rounded-[4px] border border-accent/60 bg-accent/10 px-1 font-medium text-accent hover:bg-accent/20">Confirm</button>
        <button type="button" onClick={() => kit.setConfirm(undefined)} onKeyDown={(e) => { if (e.key === 'Escape') kit.setConfirm(undefined) }} title={`Cancel (${keys('Esc')})`}
          className="rounded-[4px] px-1 text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">Cancel</button>
      </span>
    )
  }
  const no = kit.forceWhy(p, kind)
  const tone = kind === 'ci' ? 'border-accent/50 text-accent hover:bg-accent/10' : 'border-norunner/60 text-norunner hover:bg-norunner/10'
  return (
    <button type="button" data-cockpit-ci-fold-action={kind} data-cockpit-ci-fold-rerun={kind === 'rerun' ? '' : undefined} disabled={!!no || kit.forcing === p.number} onClick={() => kit.setConfirm({ pr: p.number, kind })}
      title={no || (kind === 'rerun' ? `${NO_RUNNER_TITLE} ${FORCE_TITLE.rerun}` : FORCE_TITLE.ci)}
      className={`shrink-0 rounded-[4px] border px-1 text-[10.5px] font-medium leading-[15px] ${tone} disabled:cursor-not-allowed disabled:border-[var(--app-hairline)] disabled:font-normal disabled:text-fg-faint`}>
      {kind === 'ci' ? 'Fix CI' : 'Rerun'}
    </button>
  )
}

/**
 * The one action a row offers (owner, 2026-10-20: the deck's per-PR actions
 * moved here when it was removed): Resolve conflict when it conflicts,
 * Update branch when it is behind, Fix CI when its CI failed — Re-run when
 * no agent can be reached for a fix. A click asks once in the row, as the
 * deck did; then the row says what it is doing until GitHub shows it done.
 */
function RowAction({ p, kit, worktrees, now }: { p: SessionPRLive; kit: Kit; worktrees?: DeckWorktree[]; now: number }) {
  const g = kit.standing(p, prAgents(p.live?.branch, worktrees), now)
  if (g) return <span data-cockpit-ci-progress className="shrink-0 text-accent">{g.text}</span>
  const c = kit.confirm?.pr === p.number ? kit.confirm : undefined
  if (c) {
    return (
      // One line at the cockpit's width (owner, 2026-11-20): the question in
      // a few words, the whole sentence on hover.
      <span data-cockpit-ci-confirm className="flex w-full min-w-0 flex-nowrap items-center gap-1.5 whitespace-nowrap text-[11px]">
        <span data-cockpit-ci-confirm-text className="min-w-0 flex-1 truncate text-fg" title={kit.confirmText(p, c.kind)}>{kit.confirmShort(p, c.kind)}</span>
        <button type="button" data-cockpit-ci-confirm-yes autoFocus onClick={() => void kit.force(p, c.kind)}
          className="shrink-0 rounded-[4px] border border-accent/60 bg-accent/10 px-1.5 font-medium text-accent hover:bg-accent/20">Confirm</button>
        <button type="button" onClick={() => kit.setConfirm(undefined)} onKeyDown={(e) => { if (e.key === 'Escape') kit.setConfirm(undefined) }} title={`Cancel (${keys('Esc')})`}
          className="shrink-0 rounded-[4px] px-1 text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">Cancel</button>
      </span>
    )
  }
  const ks = quickActions(p)
  if (ks.length === 0) return null
  const k = ks.find((x) => !kit.forceWhy(p, x)) ?? ks[0]!
  const no = kit.forceWhy(p, k)
  return (
    <button type="button" data-cockpit-ci-action={k} disabled={!!no || kit.forcing === p.number} onClick={() => kit.setConfirm({ pr: p.number, kind: k })}
      title={no || FORCE_TITLE[k]}
      className={`shrink-0 rounded-[4px] border px-1.5 text-[10.5px] font-medium leading-[16px] disabled:cursor-not-allowed disabled:border-[var(--app-hairline)] disabled:font-normal disabled:text-fg-faint ${k === 'conflict' ? 'border-danger/50 text-danger hover:bg-danger/10' : 'border-accent/50 text-accent hover:bg-accent/10'}`}>
      {ACTION_LABEL[k]}
    </button>
  )
}

/**
 * Nothing in flight, in one quiet line: *Nothing in flight · last release
 * v0.124.0, 2h ago*; where work ships on merge, *Nothing in flight · no
 * releases here: work ships when it merges*. Folded (`short`), where the
 * merges listed under it are not drawn, the newest merge: *Nothing in flight
 * · last: #1041 merged 2h ago*. GitHub refusing the read with nothing kept
 * says so: *Pull requests not read · GitHub: …*.
 */
function Quiet({ f, now, refused, short = false }: { f: Flight; now: number; refused?: string; short?: boolean }) {
  const rel = f.release
  const last = f.recent[0]
  if (refused && !last && !rel) {
    return (
      <span data-cockpit-ci-quiet="refused" className="truncate text-[11.5px] text-fg-faint" title={`GitHub refused the read of this repository’s pull requests: ${refused}. Asked again in a minute.`}>
        Pull requests not read · GitHub: {refused}
      </span>
    )
  }
  if (short && last?.merged_at) {
    return (
      <span data-cockpit-ci-quiet="last" className="truncate text-[11.5px] text-fg-faint" title={`${last.title}\nMerged ${new Date(last.merged_at).toLocaleString()}`}>
        Nothing in flight · last: #{last.number} merged {spanText(Math.max(0, now - last.merged_at))} ago
      </span>
    )
  }
  if (f.ships === 'merge') {
    return (
      <span data-cockpit-ci-quiet="merge" className="truncate text-[11.5px] text-fg-faint" title="No release published and no version tag in the last 180 days: merged is the last step here">
        Nothing in flight · no releases here: work ships when it merges
      </span>
    )
  }
  return (
    <span data-cockpit-ci-quiet className="truncate text-[11.5px] text-fg-faint" title={rel ? new Date(rel.published_at).toLocaleString() : 'GitHub lists no published release for this repository'}>
      Nothing in flight · {rel ? `last release ${rel.tag}, ${spanText(Math.max(0, now - rel.published_at))} ago` : 'no release published'}
    </span>
  )
}

/** One ring for the lead PR: its checks done of all, its time, and its run against the median. */
function Ring({ p, ci, now, own }: { p: LeadPR; ci?: SessionCI; now: number; own?: string }) {
  const s = checkSummary(p.live.checks.items, now)
  const r = 15
  const c = 2 * Math.PI * r
  const arc = (n: number) => (s.total ? (n / s.total) * c : 0)
  const segs: { n: number; color: string }[] = [
    { n: s.pass, color: 'var(--color-ok)' }, { n: s.fail, color: 'var(--color-danger)' }, { n: s.norunner, color: 'var(--color-norunner)' }, { n: s.running, color: 'var(--color-warn)' },
  ]
  let off = 0
  const run = ci?.pr?.number === p.number ? ci.ci?.runs?.[0] : undefined
  const vs = run ? runVsMedian(run, now) : undefined
  const done = s.pass + s.fail + s.norunner
  return (
    <span data-cockpit-ci-ring className="flex items-center gap-3">
      <svg width="38" height="38" viewBox="0 0 38 38" role="img" aria-label={`${done} of ${s.total} checks done`} className="shrink-0 -rotate-90">
        <circle cx="19" cy="19" r={r} fill="none" stroke="var(--app-hairline)" strokeWidth="4" />
        {segs.map((g, i) => {
          const len = arc(g.n)
          const el = len > 0 ? <circle key={i} cx="19" cy="19" r={r} fill="none" stroke={g.color} strokeWidth="4" strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-off} className={g.color.includes('warn') ? 'animate-pulse motion-reduce:animate-none' : ''} /> : null
          off += len
          return el
        })}
      </svg>
      <span className="grid min-w-0 gap-0.5">
        <span className="num text-[15px] font-semibold leading-none text-fg">{done}/{s.total}{s.ms ? <span className="text-[12px] font-normal text-fg-muted"> · {fmtRun(s.ms)}</span> : null}</span>
        <span className="truncate text-[11px] text-fg-muted">
          <span title={foreignRepo(p.live, own)}>{prNoText(p, own)}</span>{s.fail ? <span className="text-danger"> · {s.fail} failed</span> : null}{s.norunner ? <span className="text-norunner" title={NO_RUNNER_TITLE}> · {s.norunner} no runner</span> : null}{s.running ? <span className="text-warn"> · {s.running} running</span> : null}
          {vs ? <span className={vs.tone === 'warn' ? 'text-warn' : 'text-fg-faint'}> · {vs.text}</span> : null}
        </span>
      </span>
    </span>
  )
}

/** The folded line's wordings, widest first: the bar's width, then what the words keep. */
const FOLD_FITS: [CheckFit, number][] = [['full', 96], ['full', 64], ['full', 40], ['noskip', 40], ['compact', 40], ['worst', 40]]

const OS_WORD = { pass: 'passed', fail: 'failed', norunner: 'no runner', running: 'running', queued: 'queued', skipped: 'skipped' } as const
const OS_TEXT = { pass: 'text-ok', fail: 'text-danger', norunner: 'text-norunner', running: 'text-warn', queued: 'text-fg-muted', skipped: 'text-fg-faint' } as const

/**
 * The newest PR's checks by runner OS, one line each: *Linux ✓ passed 1m 48s
 * · 4 checks*, *Windows ● running 2m 10s*. It used to be a job × OS matrix
 * that showed only once the PR's row had been opened in the deck, and said
 * so in place of anything else; this reads the checks the PR row already
 * carries (with their jobs when the deck read them), so it always has
 * something to show unless no check names an OS.
 */
function ByOS({ p, ci, now, own }: { p: LeadPR; ci?: SessionCI; now: number; own?: string }) {
  const runs = ci?.pr?.number === p.number ? ci.ci?.runs : undefined
  const sum = prChecks(p, now, runs)
  const rows = sum ? osRollup(sum.nodes) : []
  if (rows.length === 0) return <span className="text-[11.5px] text-fg-faint">{prNoText(p, own)}’s checks name no runner OS.</span>
  return (
    <span data-cockpit-ci-os className="grid grid-cols-[auto_10px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 text-[11.5px]">
      {rows.map((r) => (
        <span key={r.os} data-os={r.os} data-tone={r.tone} className="contents">
          <span className="text-fg">{osName(r.os)}</span>
          <StateMark tone={r.tone} />
          <span className={`truncate ${OS_TEXT[r.tone]}`}>{OS_WORD[r.tone]}{r.ms ? <span className="num text-fg-muted"> {fmtRun(r.ms)}</span> : null}</span>
          <span className="num text-right text-fg-faint">{r.counts.total} {r.counts.total === 1 ? 'check' : 'checks'}</span>
        </span>
      ))}
    </span>
  )
}
