/**
 * The release's own status (.ai/04-ui.md § Release plan, *The release
 * status*; owner, 2026-10-16, translated: "I don't have a release indicator
 * … it's not clear how releases go and where"): which release is under way,
 * why it is that number, and where it is along
 * merged → release PR → CI → tag → builds → published → site, drawn as the
 * pull request rows' pills (components/Journey JourneyPills). Pure.
 *
 * Every stage is read from what the daemon already has, never guessed
 * (rule 6): the tags and changelog entries (`GET /v1/work`), the listed pull
 * requests and their board cards, the published releases with their asset
 * counts (the Pipeline answer) and the newest release run
 * (`…/ci/release`). A stage nothing read can say is drawn neutral with
 * *not known* on hover — the site's deploy always is.
 *
 * Which release it is:
 * - **a release pull request** (`chore(release): 1.2.3`, `release: v1.2.3`),
 *   open or merged, for a version past every known tag — that version;
 * - else **the newest tag while its release run is unfinished, red, or has
 *   published nothing yet** — that tag (`phase` `tagged`): the work merged
 *   since is the release after it;
 * - else, with work merged or changelog entries waiting, **the predicted
 *   next version** (lib/releaseplan nextVersion);
 * - else none (`phase` `idle`): only the last release line is said.
 */
import type { ReleaseCI, WorkRepo } from './api'
import type { BranchPR } from './branches'
import type { JourneyPillStep } from './journey'
import type { BoardCard, BoardRelease } from './prboard'
import { nextVersion, parseVersion, type Bump } from './releaseplan'

export type ReleaseStageKey = 'merged' | 'pr' | 'ci' | 'tag' | 'builds' | 'published' | 'site'
export const RELEASE_STAGES: readonly ReleaseStageKey[] = ['merged', 'pr', 'ci', 'tag', 'builds', 'published', 'site']

export interface ReleaseStage extends JourneyPillStep {
  key: ReleaseStageKey
}

export interface ReleaseStatus {
  /** pre: not tagged yet; tagged: the tag is pushed, its release under way; idle: nothing waiting. */
  phase: 'pre' | 'tagged' | 'idle'
  /** "0.127.0", no "v"; absent when no rule says it. */
  version?: string
  bump?: Bump | 'major'
  /** "minor · a feature since v0.126.0"; absent with no version. */
  why?: { text: string; title: string }
  /** Empty when idle. */
  stages: ReleaseStage[]
  /** The stage it is at now; absent when every knowable one is done, or idle. */
  current?: ReleaseStageKey
  /** The newest published release that is not this one. */
  last?: { tag: string; url?: string; at: number; assets?: number; prerelease?: boolean }
}

export interface ReleaseStatusInput {
  /** The last tag as git has it (`WorkRepo.tags.last`). */
  lastTag?: { name: string; at: number }
  unreleased?: WorkRepo['unreleased']
  /** Pull requests merged since the last tag (the plan's merged rows). */
  merged: number
  prs: readonly BranchPR[]
  cards?: readonly BoardCard[]
  /** Published releases, newest first (`board.releases`). */
  releases: readonly BoardRelease[]
  /** The repository's newest release run. */
  run?: ReleaseCI
}

/** "v0.126.0" → "0.126.0"; undefined for a tag that is not x.y.z. */
export function plainVersion(tag: string | undefined): string | undefined {
  const p = tag ? parseVersion(tag) : undefined
  return p ? p.v.join('.') : undefined
}

function cmp(a: string, b: string): number {
  const x = parseVersion(a)?.v, y = parseVersion(b)?.v
  if (!x || !y) return 0
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

const RELEASE_TITLE = /^(?:chore\(release\)|release)!?\s*:?\s*v?(\d+\.\d+\.\d+)\b/i

/** The version a release pull request's title names: "chore(release): 0.126.0 (#724)" → "0.126.0". */
export function releasePRVersion(title: string | undefined): string | undefined {
  return title ? RELEASE_TITLE.exec(title.trim())?.[1] : undefined
}

/** The bump from one version to the next. */
export function bumpBetween(from: string | undefined, to: string): ReleaseStatus['bump'] {
  const a = from ? parseVersion(from)?.v : undefined, b = parseVersion(to)?.v
  if (!a || !b) return undefined
  if (b[0] !== a[0]) return 'major'
  if (b[1] !== a[1]) return 'minor'
  return 'patch'
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Why the version is that number, from the changelog entries' kinds when read. */
function whyOf(version: string | undefined, bump: ReleaseStatus['bump'], since: string | undefined, u: WorkRepo['unreleased'], ruleTitle?: string): ReleaseStatus['why'] {
  if (!version || !bump) return undefined
  const added = u?.kinds?.Added ?? 0
  const rest = (u?.count ?? 0) - added
  const from = since ? ` since ${since}` : ''
  const counted = u && u.count > 0 && u.kinds
    ? bump === 'minor' ? ` (${plural(added, 'feature')}${rest > 0 ? `, ${rest} other` : ''})` : bump === 'patch' ? ` (${plural(u.count, 'entry', 'entries')})` : ''
    : ''
  const text = bump === 'minor' ? `minor · a feature${from}` : bump === 'patch' ? `patch · fixes only${from}` : `major${from}`
  const title = ruleTitle ?? 'A feature (an Added changelog entry) makes a minor release, fixes and other changes alone a patch (owner, 2026-10-15).'
  return { text: text + counted, title }
}

/** The release's status, from what is read; never a guess. */
export function releaseStatus(input: ReleaseStatusInput): ReleaseStatus {
  const { lastTag, unreleased: u, merged, prs, cards = [], releases, run } = input
  const tags = new Set<string>()
  for (const t of [lastTag?.name, run?.tag, ...releases.map((r) => r.tag)]) {
    const v = plainVersion(t)
    if (v) tags.add(v)
  }
  const latest = [...tags].sort(cmp).pop()
  const relOf = (v: string) => releases.find((r) => plainVersion(r.tag) === v)
  const runOf = (v: string) => (run && plainVersion(run.tag) === v && run.state !== 'none' ? run : undefined)
  const prevOf = (v: string | undefined) => releases.find((r) => plainVersion(r.tag) !== v && (!v || cmp(r.tag, v) < 0))
  const lastLine = (r: BoardRelease | undefined): ReleaseStatus['last'] => r && { tag: r.tag, url: r.url, at: r.published_at, assets: r.assets, prerelease: r.prerelease }

  // A release pull request past every tag, open or merged, the newest.
  const relPRs = prs.filter((p) => p.state !== 'closed' && releasePRVersion(p.title) && (!latest || cmp(releasePRVersion(p.title)!, latest) > 0))
    .sort((a, b) => b.number - a.number)
  const relPR = relPRs[0]

  const latestRun = latest ? runOf(latest) : undefined
  const tagUnderWay = !!latest && !!latestRun && (latestRun.state === 'running' || latestRun.state === 'fail' || !relOf(latest))
  const pending = (u?.count ?? 0) > 0 || merged > 0

  let phase: ReleaseStatus['phase']
  let version: string | undefined
  let bump: ReleaseStatus['bump']
  let why: ReleaseStatus['why']
  if (relPR) {
    phase = 'pre'
    version = releasePRVersion(relPR.title)
    bump = bumpBetween(latest, version!)
    const tagName = [lastTag?.name, ...releases.map((r) => r.tag)].find((t) => plainVersion(t) === latest) ?? (latest && `v${latest}`)
    why = whyOf(version, bump, tagName, u, `Named by #${relPR.number}’s title. A feature (an Added changelog entry) makes a minor release, fixes alone a patch.`)
  } else if (tagUnderWay) {
    phase = 'tagged'
    version = latest
    const prev = prevOf(latest)
    bump = bumpBetween(prev?.tag, latest!)
    why = whyOf(version, bump, prev?.tag, undefined, `Against the release before it${prev ? `, ${prev.tag}` : ''}.`)
  } else if (pending) {
    phase = 'pre'
    const tagName = lastTag?.name ?? (latest ? `v${latest}` : undefined)
    const nv = nextVersion(tagName, u)
    version = nv?.version
    bump = nv?.bump
    why = nv?.version ? whyOf(version, bump, tagName, u, nv.title) : undefined
  } else {
    return { phase: 'idle', stages: [], last: lastLine(releases[0]) }
  }

  // A tag under way: its own release pull request, merged, when listed.
  const ownPR = relPR ?? (version ? prs.find((p) => p.state === 'merged' && releasePRVersion(p.title) === version) : undefined)
  const stages = stagesOf({ phase, version, relPR: ownPR, cards, merged, u, rel: version ? relOf(version) : undefined, prev: prevOf(version), run: version ? runOf(version) : undefined, tagged: !!version && tags.has(version) })
  const current = stages.find((s) => s.state === 'current')?.key
  const last = lastLine(releases.find((r) => plainVersion(r.tag) !== version || phase === 'pre'))
  return { phase, version, bump, why, stages, current, last }
}

interface StageFacts {
  phase: 'pre' | 'tagged'
  version?: string
  relPR?: BranchPR
  cards: readonly BoardCard[]
  merged: number
  u: WorkRepo['unreleased']
  rel?: BoardRelease
  prev?: BoardRelease
  run?: ReleaseCI
  tagged: boolean
}

type Draft = Omit<ReleaseStage, 'state'> & { state: 'done' | 'todo' | 'unknown' | 'now' }

/** Each stage's state; the first one not done is the current one. */
export function stagesOf(f: StageFacts): ReleaseStage[] {
  const v = f.version ? `v${f.version}` : 'the next version'
  const pr = f.relPR
  const card = pr ? f.cards.find((c) => c.number === pr.number) : undefined
  const prMerged = pr?.state === 'merged'
  const past = f.tagged
  const out: Draft[] = []

  // PRs merged.
  const n = f.merged, e = f.u?.count ?? 0
  out.push(n > 0 || e > 0 || past || !!pr
    ? { key: 'merged', text: n > 0 ? `${n} merged` : e > 0 ? plural(e, 'entry', 'entries') : 'merged', state: 'done', tone: 'ok', title: n > 0 ? `${plural(n, 'pull request')} merged since the last tag.` : e > 0 ? `${plural(e, 'changelog entry', 'changelog entries')} waiting for a release.` : 'The work for it is merged.' }
    : { key: 'merged', text: 'merged', state: 'todo', tone: 'faint', title: 'Nothing merged since the last tag yet.' })

  // The release pull request.
  if (pr) {
    out.push(prMerged
      ? { key: 'pr', text: `#${pr.number}`, state: 'done', tone: 'ok', title: `Release pull request #${pr.number} merged: ${pr.title ?? ''}`.trim() }
      : pr.draft
        ? { key: 'pr', text: `#${pr.number} draft`, state: 'now', tone: 'muted', title: `Release pull request #${pr.number} is a draft: ${pr.title ?? ''}`.trim() }
        : { key: 'pr', text: `#${pr.number}`, state: 'done', tone: 'ok', title: `Release pull request #${pr.number} is open: ${pr.title ?? ''}`.trim() })
  } else {
    out.push(past
      ? { key: 'pr', text: 'release PR', state: 'unknown', tone: 'faint', title: `Not known: no release pull request for ${v} among the pull requests listed.` }
      : { key: 'pr', text: 'release PR', state: 'todo', tone: 'faint', title: `No release pull request for ${v} yet (a title like “chore(release): ${f.version ?? 'x.y.z'}”).` })
  }

  // Its CI.
  if (pr && (prMerged || past)) out.push({ key: 'ci', text: 'CI', state: 'done', tone: 'ok', title: `#${pr.number} merged, so its checks let it.` })
  else if (pr) {
    const ci = card?.ci
    if (ci === 'running') out.push({ key: 'ci', text: 'CI', state: 'now', tone: 'pending', title: `#${pr.number}’s checks are running.` })
    else if (ci === 'fail' || card?.why === 'ci') out.push({ key: 'ci', text: 'CI red', state: 'now', tone: 'fail', title: `#${pr.number}: ${card?.failed?.length ? `failed: ${card.failed.join(', ')}` : 'a check failed'}.` })
    else if (ci === 'pass' || ci === 'none') out.push({ key: 'ci', text: 'CI', state: 'done', tone: 'ok', title: ci === 'pass' ? `#${pr.number}’s checks passed.` : `#${pr.number} has no checks.` })
    else out.push({ key: 'ci', text: 'CI', state: 'unknown', tone: 'faint', title: `Not known: #${pr.number}’s checks were not read.` })
  } else {
    out.push(past
      ? { key: 'ci', text: 'CI', state: 'unknown', tone: 'faint', title: 'Not known: no release pull request listed to read the checks of.' }
      : { key: 'ci', text: 'CI', state: 'todo', tone: 'faint', title: 'The release pull request’s checks.' })
  }

  // The tag.
  out.push(past
    ? { key: 'tag', text: v, state: 'done', tone: 'ok', title: `${v} is tagged.` }
    : { key: 'tag', text: 'tag', state: 'todo', tone: 'faint', title: pr && !prMerged ? `Waits for #${pr.number} to merge and ${v} to be tagged.` : `${v} is not tagged yet.` })

  // The builds: the tag's release run, and the files on its release.
  const run = f.run
  const jobs = run?.run?.jobs ?? []
  const done = jobs.filter((j) => j.status === 'completed').length
  const total = f.prev?.assets
  const count = f.rel?.assets !== undefined && total ? `${f.rel.assets}/${total}` : jobs.length ? `${done}/${jobs.length}` : ''
  const counted = f.rel?.assets !== undefined && total
    ? `${plural(f.rel.assets, 'file')} on ${v}’s release, of the ${total} ${f.prev!.tag} has.`
    : jobs.length ? `${done} of ${plural(jobs.length, 'job')} of the release run finished.` : ''
  const text = count ? `builds ${count}` : 'builds'
  if (run?.state === 'running') out.push({ key: 'builds', text, state: 'now', tone: 'pending', title: `The release run for ${v} is running. ${counted}`.trim() })
  else if (run?.state === 'fail') out.push({ key: 'builds', text, state: 'now', tone: 'fail', title: `The release run for ${v} failed. ${counted}`.trim() })
  else if (run?.state === 'pass') out.push({ key: 'builds', text: f.rel?.assets !== undefined ? `${plural(f.rel.assets, 'file')}` : 'builds', state: 'done', tone: 'ok', title: `The release run for ${v} passed. ${counted}`.trim() })
  else if (past) out.push({ key: 'builds', text, state: 'unknown', tone: 'faint', title: `Not known: no release run for ${v} read. ${counted}`.trim() })
  else out.push({ key: 'builds', text: 'builds', state: 'todo', tone: 'faint', title: `The release run, once ${v} is tagged.` })

  // Published on GitHub.
  const draft = run?.release?.draft
  out.push(f.rel || (run?.release && !draft)
    ? { key: 'published', text: 'published', state: 'done', tone: 'ok', title: `${v} is published on GitHub${f.rel?.prerelease ? ' as a pre-release' : ''}.` }
    : { key: 'published', text: 'published', state: 'todo', tone: 'faint', title: draft ? `${v}’s release is a draft.` : `No GitHub release for ${v} read yet.` })

  // The site: nothing read says.
  out.push({ key: 'site', text: 'site', state: 'unknown', tone: 'faint', title: 'Not known: Caprock reads nothing of the site’s deploy.' })

  // The first stage not done is where it is; a later one done (published
  // before the last build attached its files) stays done.
  const at = out.findIndex((s) => s.state !== 'done' && s.state !== 'unknown')
  return out.map((s, i): ReleaseStage => {
    if (s.state === 'done') return s as ReleaseStage
    if (i === at) return { ...s, state: 'current', tone: s.state === 'todo' ? 'muted' : s.tone } as ReleaseStage
    if (s.state === 'unknown') return { ...s, state: 'todo', unknown: true } as ReleaseStage
    return { ...s, state: 'todo', tone: 'faint' } as ReleaseStage
  })
}
