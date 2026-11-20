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
import { mergedEntries, nextVersion, parseVersion, type Bump } from './releaseplan'

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
  /** The release pull request for this version, when one is listed. */
  pr?: { number: number; merged: boolean }
  /** The batch pull request the changelog entries not merged yet are on (`unreleased.via`). */
  batch?: number
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
  const pr = ownPR ? { number: ownPR.number, merged: ownPR.state === 'merged' } : undefined
  return { phase, version, bump, why, stages, current, last, pr, ...(u?.via ? { batch: u.via.number } : {}) }
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

  // PRs merged. Entries only on the batch pull request's branch are not
  // merged yet: they wait for it.
  const n = f.merged, e = mergedEntries(f.u), onPR = (f.u?.count ?? 0) - e
  out.push(n > 0 || e > 0 || past || !!pr
    ? { key: 'merged', text: n > 0 ? `${n} merged` : e > 0 ? plural(e, 'entry', 'entries') : 'merged', state: 'done', tone: 'ok', title: n > 0 ? `${plural(n, 'pull request')} merged since the last tag.` : e > 0 ? `${plural(e, 'changelog entry', 'changelog entries')} waiting for a release.` : 'The work for it is merged.' }
    : { key: 'merged', text: 'merged', state: 'todo', tone: 'faint', title: onPR > 0 && f.u?.via ? `${plural(onPR, 'changelog entry', 'changelog entries')} on #${f.u.via.number}’s branch, waiting for it to merge.` : 'Nothing merged since the last tag yet.' })

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

/**
 * The five stages the right panel's strip names (owner, 2026-11-18:
 * `Merged ─ Release PR ─ Tagged ─ ◉ Building ─ Published`): the release
 * pull request and its CI are one stage, the site is left out (nothing read
 * says it). Each keeps the state, tone and hover of what it stands for.
 */
export type StripKey = 'merged' | 'pr' | 'tag' | 'builds' | 'published'
export interface StripStage { key: StripKey; text: string; state: ReleaseStage['state']; tone: ReleaseStage['tone']; title: string; unknown?: boolean }

const STRIP_TEXT: Record<StripKey, string> = { merged: 'Merged', pr: 'Release PR', tag: 'Tagged', builds: 'Building', published: 'Published' }

export function stripStages(s: ReleaseStatus, o: { out?: boolean } = {}): StripStage[] {
  if (!s.stages.length) return s.phase === 'idle' ? idleStrip(s, !!o.out) : []
  const at = (k: ReleaseStageKey) => s.stages.find((x) => x.key === k)
  const one = (key: StripKey, from: ReleaseStage | undefined): StripStage | undefined =>
    from && { key, text: STRIP_TEXT[key], state: from.state, tone: from.tone, title: from.title, unknown: from.unknown }
  // The release PR and its CI: the one that is current speaks, else the
  // first not done, else the PR (both done).
  const pr = at('pr'), ci = at('ci')
  const both = [pr, ci].filter((x): x is ReleaseStage => !!x)
  const lead = both.find((x) => x.state === 'current') ?? both.find((x) => x.state !== 'done') ?? pr
  const prStage = lead && { ...one('pr', lead)!, title: both.map((x) => x.title).join('\n') }
  return [one('merged', at('merged')), prStage, one('tag', at('tag')), one('builds', at('builds')), one('published', at('published'))]
    .filter((x): x is StripStage => !!x)
}

/**
 * The strip with nothing under way (owner, 2026-11-19: the strip is always
 * drawn): the first stage current and dim, the rest to come; within the hour
 * of a release's publishing, every stage done and *Published* marked.
 */
function idleStrip(s: ReleaseStatus, out: boolean): StripStage[] {
  const keys: StripKey[] = ['merged', 'pr', 'tag', 'builds', 'published']
  if (out && s.last) {
    return keys.map((key) => key === 'published'
      ? { key, text: STRIP_TEXT[key], state: 'current', tone: 'ok', title: `${s.last!.tag} is published on GitHub.` }
      : { key, text: STRIP_TEXT[key], state: 'done', tone: 'ok', title: `Done for ${s.last!.tag}.` })
  }
  return keys.map((key, i) => i === 0
    ? { key, text: STRIP_TEXT[key], state: 'current', tone: 'faint', title: 'Nothing merged and no changelog entry waiting since the last release: the next one starts with a merge.' }
    : { key, text: STRIP_TEXT[key], state: 'todo', tone: 'faint', title: 'To come, once there is something to release.' })
}

/**
 * The release status in words, said the same everywhere in the section: the
 * words beside the stage dots, the dots' colour and the folded line
 * (.ai/04-ui.md § Release plan, *The right panel*). One colour language
 * (owner, 2026-11-20, translated: "I stopped understanding what this means
 * … it must be really clear, I must know the status exactly" — a grey
 * *not opened yet* drawn amber read as a release under way):
 *
 * - `idle`, grey: nothing is happening — a person starts the next step
 *   (*Ready to release · not started*), or there is nothing to release;
 * - `active`, blue (`--color-progress`) and pulsing: in progress right now (*Releasing ·
 *   checks 1 of 3 systems*, *Releasing · building apps, 5 of 23 files*);
 * - `waiting`, amber: waiting on something else that is moving (*Waiting
 *   for #949 to merge*);
 * - `fail`, red: stopped, needs action (*Release stopped · checks failed*);
 * - `ok`, green: done (*Released · 5 min ago*).
 *
 * The state comes first in plain words, the detail after it. Never more
 * than was read (rule 6).
 */
export type StatusTone = 'idle' | 'active' | 'waiting' | 'fail' | 'ok'

/** The status's colour as text: the strip's words and the folded line. */
export const STATUS_TEXT: Record<StatusTone, string> = { idle: 'text-fg-muted', active: 'text-progress', waiting: 'text-warn', fail: 'text-danger', ok: 'text-ok' }

/** The current dot's state on hover, by tone: *Release PR: not started*. */
export const TONE_STATE: Record<StatusTone, string> = { idle: 'not started', active: 'in progress', waiting: 'waiting', fail: 'stopped', ok: 'done' }

export interface StageWords {
  key: StripKey
  /** Its place among the five, from 1. */
  index: number
  name: string
  /** The state first: "Ready to release", "Releasing", "Release stopped", "Released", "Waiting for #949 to merge". */
  lead: string
  /** The lead with the version in it, for the folded line: "Ready to release 0.185.1", "Release 0.185.1 stopped". */
  vlead: string
  /** What was read of it: "not started", "checks 1 of 3 systems"; may be empty. */
  detail: string
  /** "lead · detail". */
  text: string
  tone: StatusTone
  /** Its hover when the stage's own title would not explain the words (the OS groups behind *checks 1 of 3 systems*). */
  title?: string
}

/** The OS groups in the order the hover names them. */
const WORDS_OS: readonly { os: string; label: string }[] = [{ os: 'macos', label: 'macOS' }, { os: 'windows', label: 'Windows' }, { os: 'linux', label: 'Linux' }]

/** How long after a release is published the folded line says it is out, rather than "nothing new". */
export const OUT_RECENT_MS = 3_600_000

/** A pull request in flight that is not the release one: the batch the next release waits for. */
export interface BatchPR {
  number: number
  ci?: 'running' | 'fail' | 'no_runner' | 'pass' | 'none'
  /** The next step it waits for, in a few words (lib/releasenotes viaLine): "merge #949", "wait for CI". */
  next?: string
}

export function stageWords(s: ReleaseStatus, strip: readonly StripStage[], o: { cards?: readonly BoardCard[]; out?: boolean; now: number; batch?: BatchPR }): StageWords | undefined {
  const v = s.version
  const vv = v ? `v${v}` : 'the next version'
  let i = strip.findIndex((x) => x.state === 'current')
  const say = (tone: StatusTone, lead: string, vlead: string, detail: string, title?: string): StageWords => {
    const x = strip[i]!
    return { key: x.key, index: i + 1, name: x.text, lead, vlead, detail, text: detail ? `${lead} · ${detail}` : lead, tone, ...(title ? { title } : {}) }
  }
  const lastV = plainVersion(s.last?.tag) ?? s.last?.tag
  if (i < 0) {
    for (let j = strip.length - 1; j >= 0; j--) if (strip[j]!.state === 'done') { i = j; break }
    if (i < 0) return undefined
    return say('ok', 'Released', v ? `${v} released` : 'Released', '')
  }
  const x = strip[i]!
  const at = (k: ReleaseStageKey) => s.stages.find((y) => y.key === k)
  if (s.phase === 'idle') {
    if (x.key === 'published' && o.out && s.last) return say('ok', 'Released', `${lastV} released`, agoText(o.now - s.last.at))
    return say('idle', 'Nothing new', 'Nothing new', '')
  }
  const ready = v ? `Ready to release ${v}` : 'Ready to release'
  const releasing = v ? `Releasing ${v}` : 'Releasing'
  const stopped = v ? `Release ${v} stopped` : 'Release stopped'
  switch (x.key) {
    case 'merged': {
      // Every entry on the batch pull request's branch: the release waits for it.
      const n = o.batch?.number ?? s.batch
      const lead = n ? `Waiting for #${n} to merge` : 'Waiting for the batch PR to merge'
      const ci = o.batch?.ci ?? (n ? o.cards?.find((c) => c.number === n)?.ci : undefined)
      if (ci === 'fail') return say('fail', lead, lead, 'its checks failed', `${x.title}\nIts checks failed: it cannot merge until they pass.`)
      return say('waiting', lead, lead, '')
    }
    case 'pr': {
      if (!s.pr) {
        return say('idle', 'Ready to release', ready, 'not started',
          `Nothing is running. The changes are merged; ${vv} starts when someone opens its release pull request (a title like “chore(release): ${v ?? 'x.y.z'}”).`)
      }
      const n = s.pr.number
      if (at('pr')?.state === 'current') return say('idle', 'Ready to release', ready, `#${n} is a draft`, `Release pull request #${n} is a draft: nothing runs until someone marks it ready.`)
      const ci = at('ci')
      const os = o.cards?.find((c) => c.number === n)?.os ?? []
      if (ci?.tone === 'fail') {
        const failed = WORDS_OS.filter((w) => os.some((y) => y.os === w.os && y.state === 'fail')).map((w) => w.label)
        return say('fail', 'Release stopped', stopped, `checks failed${failed.length ? ` on ${failed.join(', ')}` : ''}`, `Release pull request ${ci.title}`)
      }
      if (ci?.tone === 'pending') {
        if (!os.length) return say('active', 'Releasing', releasing, 'checks running', `Release pull request ${ci.title}`)
        // Owner, 2026-11-19: a bare *CI 1/3* read like a count of checks; it counts operating systems.
        const passed = os.filter((y) => y.state === 'pass').length
        const names = WORDS_OS.filter((w) => os.some((y) => y.os === w.os)).map((w) => w.label).join(', ')
        const title = `Release pull request #${n}: ${passed} of ${os.length} ${os.length === 1 ? 'system' : 'systems'} (${names}) passed${passed < os.length ? '; the rest are running' : ''}.`
        return say('active', 'Releasing', releasing, `checks ${passed} of ${os.length} ${os.length === 1 ? 'system' : 'systems'}`, title)
      }
      return say('idle', 'Ready to release', ready, `#${n} open`)
    }
    case 'tag': {
      if (s.pr && !s.pr.merged) {
        const ci = at('ci')
        if (ci?.state === 'done') return say('idle', 'Ready to merge', v ? `${v} ready to merge` : 'Ready to merge', `#${s.pr.number} ${/no checks/.test(ci.title) ? 'has no checks' : 'checks passed'}`,
          `Nothing is running: release pull request #${s.pr.number} waits for someone to merge it, then ${vv} to be tagged.`)
        return say('idle', 'Release PR open', v ? `${v} release PR open` : 'Release PR open', `#${s.pr.number}, checks not read`)
      }
      return say('idle', 'Not tagged yet', v ? `${v} not tagged yet` : 'Not tagged yet', s.pr ? `#${s.pr.number} merged` : '',
        `Nothing is running: ${vv} is not tagged yet${s.pr ? `, though release pull request #${s.pr.number} merged` : ''}. Its release builds once the tag is pushed.`)
    }
    case 'builds': {
      const b = at('builds')
      const m = b && /(\d+)\/(\d+)/.exec(b.text)
      const count = m ? `${m[1]} of ${m[2]} ${/ files? on /.test(b!.title) ? 'files' : 'jobs'}` : ''
      if (x.tone === 'fail') return say('fail', 'Release stopped', stopped, count ? `build failed at ${count}` : 'build failed')
      if (b?.tone === 'pending') return say('active', 'Releasing', releasing, count ? `building apps, ${count}` : 'building apps')
      return say('idle', 'Not built yet', v ? `${v} not built yet` : 'Not built yet', '')
    }
    case 'published':
      if (/a draft\./.test(x.title)) return say('fail', 'Release stopped', stopped, 'draft only, not public', `${x.title} Nobody can download it until it is published.`)
      if (at('builds')?.state === 'done') return say('active', 'Releasing', releasing, 'publishing')
      return say('idle', 'Not released yet', v ? `${v} not released yet` : 'Not released yet', 'no build read')
  }
}

export interface ReleaseFold {
  /** Which line it is: from the status words' tone, or nothing new / just out. */
  kind: 'idle' | 'out' | 'ready' | 'waiting' | 'releasing' | 'stopped'
  text: string
  title: string
  tone: StatusTone
}

/** "5 min ago", one unit, as the CI line says its age. */
export function agoText(ms: number): string {
  if (ms < 60_000) return 'now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`
  return `${Math.floor(ms / 86_400_000)} d ago`
}

function batchWord(b: BatchPR | undefined): string {
  if (!b) return ''
  const w = b.ci === 'pass' ? 'green' : b.ci === 'fail' ? 'CI red' : b.ci === 'no_runner' ? 'a job not run' : b.ci === 'running' ? 'CI running' : 'open'
  return ` · PR #${b.number} ${w}`
}

const FOLD_KIND: Record<StatusTone, ReleaseFold['kind']> = { idle: 'ready', active: 'releasing', waiting: 'waiting', fail: 'stopped', ok: 'out' }

/**
 * The folded Release section's one line: the same words and colour as the
 * words beside the stage dots (stageWords), with the version in the lead
 * (.ai/04-ui.md § Release plan, *The right panel*). Never a guess: a count,
 * a check state or a time only where read.
 *
 * - *Nothing new since v0.182.4*, grey; *0.183.0 released · 5 min ago*,
 *   green, within OUT_RECENT_MS of its publishing;
 * - *Ready to release 0.183.1 · not started · 2 changes*, grey;
 * - *Waiting for #949 to merge · 0.183.1 · 2 changes*, amber (red with
 *   *its checks failed*);
 * - *Releasing 0.183.0 · checks 1 of 3 systems*, *Releasing 0.183.0 ·
 *   building apps, 12 of 23 files*, accent;
 * - *Release 0.183.0 stopped · checks failed*, *… · build failed*, *… ·
 *   draft only, not public*, red.
 */
export function releaseFold(s: ReleaseStatus, o: { waiting: number; batch?: BatchPR; lastTag?: string; now: number; cards?: readonly BoardCard[] }): ReleaseFold {
  if (s.phase === 'idle') {
    const last = s.last
    if (last && o.now - last.at < OUT_RECENT_MS) {
      return { kind: 'out', text: `${plainVersion(last.tag) ?? last.tag} released · ${agoText(o.now - last.at)}${batchWord(o.batch)}`, title: `${last.tag} was published on GitHub ${agoText(o.now - last.at)}.`, tone: 'ok' }
    }
    const tag = o.lastTag ?? last?.tag
    return { kind: 'idle', text: `${tag ? `Nothing new since ${tag}` : 'Nothing new'}${batchWord(o.batch)}`, title: tag ? `Nothing merged and no changelog entry waiting since ${tag}.` : 'Nothing merged and no changelog entry waiting.', tone: 'idle' }
  }
  const strip = stripStages(s)
  const w = stageWords(s, strip, { cards: o.cards, now: o.now, batch: o.batch })
  const n = o.waiting
  const changes = n > 0 ? `${n} ${n === 1 ? 'change' : 'changes'}` : ''
  const stage = w ? strip[w.index - 1] : undefined
  const why = s.why?.title ?? 'No version is predicted: no changelog entry of a known kind was read.'
  if (!w) return { kind: 'ready', text: [s.version ?? 'Next release', changes].filter(Boolean).join(' · '), title: why, tone: 'idle' }
  const title = [w.title ?? stage?.title, why].filter(Boolean).join('\n')
  // Waiting for the batch: the version and the changes after the batch's own words.
  if (w.key === 'merged') return { kind: FOLD_KIND[w.tone], text: [w.vlead, w.detail, s.version, changes].filter(Boolean).join(' · '), title, tone: w.tone }
  const ready = w.key === 'pr' && !s.pr
  const parts = [w.vlead, w.detail, ready ? changes : ''].filter(Boolean).join(' · ')
  return { kind: FOLD_KIND[w.tone], text: `${parts}${ready ? batchWord(o.batch) : ''}`, title, tone: w.tone }
}

/**
 * A tag newer than every published release: its release is under way (or
 * stuck), so the right panel reads the release run while it is.
 */
export function tagUnpublished(lastTag: string | undefined, releases: readonly BoardRelease[]): boolean {
  const v = plainVersion(lastTag)
  if (!v) return false
  return releases.every((r) => { const p = plainVersion(r.tag); return !p || cmp(v, p) > 0 })
}
