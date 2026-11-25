/**
 * The release's own status at the top of the Pipeline's *Next release*
 * panel (.ai/04-ui.md § Release plan, *The release status*;
 * lib/releasestatus): the version's bump and why, its stages as the pull
 * request rows' pills, and one line for the last release. Reads nothing
 * itself.
 */
import { STATUS_TEXT, stageWords, stripStages, TONE_STATE, type BatchPR, type MainChecks, type ReleaseStatus, type StatusTone, type StripKey, type StripStage } from '@/lib/releasestatus'
import type { BoardCard } from '@/lib/prboard'
import { fmtAgo } from '@/lib/format'
import { openExternal } from '@/lib/nudges'
import { extProps } from '@/lib/externalLinks'
import { JourneyPills } from './Journey'

const BUMP_PILL: Record<NonNullable<ReleaseStatus['bump']>, string> = {
  major: 'border-danger/60 bg-danger/15 text-danger',
  minor: 'border-accent/60 bg-accent/15 text-accent',
  patch: 'border-border-strong bg-panel-2 text-fg',
}

/** "minor · a feature since v0.126.0 (2 features, 3 other)": the bump as a pill, the reason beside it. */
export function ReleaseWhy({ status: s }: { status: ReleaseStatus }) {
  if (!s.why || !s.bump) return null
  const [, ...rest] = s.why.text.split(' · ')
  return (
    <span data-release-why title={s.why.title} className="inline-flex min-w-0 cursor-help items-center gap-1.5 text-[12px] text-fg-muted">
      <span className={`inline-flex h-[20px] shrink-0 items-center rounded-full border px-2 text-[11.5px] font-semibold ${BUMP_PILL[s.bump]}`}>{s.bump}</span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{rest.join(' · ')}</span>
    </span>
  )
}

/** The stages as pills: done ticked, the current one filled, the rest outlined, an unknown one dotted with a "?". */
export function ReleaseStages({ status: s }: { status: ReleaseStatus }) {
  if (!s.stages.length) return null
  return (
    <div data-release-stages data-release-current={s.current ?? ''} className="min-w-0">
      <JourneyPills steps={s.stages} label={s.version ? `Release ${s.version}: stages` : 'Release stages'} />
    </div>
  )
}

/**
 * A tag already pushed, its release under way, above the next release's
 * heading: the work merged since is the release after it.
 */
export function ReleaseInFlight({ status: s, phone = false }: { status: ReleaseStatus; phone?: boolean }) {
  return (
    <div data-release-status="tagged" className="grid min-w-0 gap-1.5 rounded-md border border-border bg-panel-2 px-2.5 py-2">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className={`num font-semibold text-fg ${phone ? 'text-[16px]' : 'text-[14px]'}`}>{s.version}</span>
        <span className="text-[11px] uppercase tracking-[0.1em] text-fg-faint">releasing</span>
        <ReleaseWhy status={s} />
      </div>
      <ReleaseStages status={s} />
    </div>
  )
}

// The one colour language of the section (lib/releasestatus StatusTone):
// grey nothing happening, blue (--color-progress) and pulsing in progress,
// amber waiting on something that moves, red stopped, green done.
const DOT_NOW: Record<StatusTone, string> = {
  // Hollow, but ringed as every current step is: never weaker than the
  // steps to come (owner, 2026-11-26).
  idle: 'border-[1.5px] border-fg-muted bg-transparent shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-fg-muted)_22%,transparent)]',
  active: 'bg-progress shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-progress)_22%,transparent)] release-step-pulse',
  waiting: 'bg-warn shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-warn)_22%,transparent)]',
  fail: 'bg-danger shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-danger)_22%,transparent)]',
  ok: 'bg-ok shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-ok)_22%,transparent)]',
}

/**
 * Each stage's one word under its circle (owner, 2026-11-23, variant A): at
 * most six letters, so five fit side by side in the 280px inspector. The
 * full name (*Release PR*, *Published*) stays on hover and for a screen
 * reader.
 */
const STEP_WORD: Record<StripKey, string> = { merged: 'Merged', pr: 'PR', tag: 'Tagged', builds: 'Build', published: 'Out' }

/** A step's state in words, on hover and for a screen reader: *Release PR: not started*, *Merged: done*. */
function dotState(x: StripStage, current: boolean, tone: StatusTone): string {
  if (current) return TONE_STATE[tone]
  if (x.state === 'done') return 'done'
  return x.unknown ? 'not known' : 'not started'
}

/**
 * The right panel's stages (owner, 2026-11-23, variant A, translated: the
 * dots and the words shared one line and the words were cut — *Waiting for
 * #1035 · checks run…*): a stepper across the panel's width, five circles
 * joined by a line — Merged, PR, Tagged, Build, Out (lib/releasestatus
 * stripStages) — each with its one word under it. Done ones green with the
 * line after them green, the one it is at in the status's colour (owner,
 * 2026-11-20: hollow grey when nothing is happening, blue and pulsing in
 * progress, amber waiting, red stopped, green done) with a ring around it,
 * the rest hollow and all alike — a step nothing read says is drawn as any
 * other step to come, *not known* only on hover (owner, 2026-11-26,
 * translated: a dashed PR step beside a *Tagged* that looked further along
 * was "not logical, not clear"). Each step says its stage and its state on
 * hover (*Release PR: not started*). While the release pull request is open
 * it is the step the release is at, until it merges: its checks running,
 * red, given no machine, green and waiting to merge, or not read yet
 * (*Release PR open · #1080 · reading checks…*).
 * An ordered list, the current step `aria-current="step"`, each step's name
 * and state in text for a screen reader. Under it, on its own line and
 * whole (two lines rather than an ellipsis), the status, plain words first
 * and the detail after (stageWords): *Ready to release · not started*.
 * `version` puts a tag already under way first, where no heading above
 * names it.
 */
export function ReleaseStrip({ status: s, version, out, words: showWords = true, cards, batch, main, now = Date.now(), href, kept }: {
  status: ReleaseStatus; version?: boolean; out?: boolean
  /** False where the heading above already says the status (a release just out, its pill): the steps alone. */
  words?: boolean
  /** Where the words go when they name the batch pull request (*Waiting for #977 · CI red*): the Pipeline on it. */
  href?: string
  /** Drawn from a kept copy being read again: faint, its age on hover (owner, 2026-11-20). */
  kept?: string
  /** The board's cards: the release pull request's checks per OS, for *checks 1 of 3 systems*. */
  cards?: readonly BoardCard[]
  /** The batch pull request, for *Waiting for #949 to merge*. */
  batch?: BatchPR
  /** The default branch's checks running or red, for *Ready to release · master checks running · 12 of 17*. */
  main?: MainChecks
  now?: number
}) {
  const stages = stripStages(s, { out })
  const w = stageWords(s, stages, { cards, out, now, batch, main })
  if (!stages.length || !w) return null
  const at = w.index - 1
  const current = stages[at]?.state === 'current'
  const wordsTitle = [w.title ?? stages[at]?.title, kept].filter(Boolean).join('\n')
  const wordsTone = current ? STATUS_TEXT[w.tone] : 'text-ok'
  return (
    <div data-release-strip data-release-current={current ? w.key : ''} data-release-tone={w.tone} data-release-kept={kept ? '' : undefined} role="group"
      aria-label={`Release stage ${w.index} of ${stages.length}: ${w.name}, ${current ? TONE_STATE[w.tone] : 'done'}`}
      className={`grid min-w-0 gap-1.5 text-[11.5px] leading-[16px]${kept ? ' opacity-70 saturate-50' : ''}`}>
      <ol data-release-steps aria-label="Release stages" className="m-0 grid min-w-0 list-none p-0" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}>
        {stages.map((x, i) => {
          const done = x.state === 'done'
          const now_ = i === at && current
          const state = dotState(x, now_, w.tone)
          const lineDone = i > 0 && stages[i - 1]!.state === 'done'
          return (
            <li key={x.key} data-strip-step={x.key} aria-current={now_ ? 'step' : undefined}
              title={`${x.text}: ${state}\n${now_ && w.title ? w.title : x.title}`}
              className="relative flex min-w-0 flex-col items-center gap-[5px]">
              {/* The line from the step before, stopping short of both circles. */}
              {i > 0 && <span aria-hidden data-strip-line={lineDone ? 'done' : 'todo'}
                className={`absolute top-[5px] right-[calc(50%+9px)] left-[calc(-50%+9px)] h-[2px] rounded-full ${lineDone ? 'bg-ok' : 'bg-border-strong'}`} />}
              <span aria-hidden data-strip-stage={x.key} data-step-state={x.state} data-step-unknown={x.unknown ? '' : undefined}
                className={`box-border block size-[12px] shrink-0 rounded-full ${now_ ? DOT_NOW[w.tone] : done ? 'bg-ok' : 'border-[1.5px] border-border-strong'}`} />
              <span aria-hidden data-strip-word className={`max-w-full truncate text-[10.5px] leading-[13px] ${now_ ? (w.tone === 'idle' ? 'text-fg' : STATUS_TEXT[w.tone]) : done ? 'text-fg-muted' : 'text-fg-faint'}`}>{STEP_WORD[x.key]}</span>
              <span className="sr-only">{`${x.text}: ${state}`}</span>
            </li>
          )
        })}
      </ol>
      {/* In progress, the heading above already says *Releasing 0.185.3*: the
        * words say only where it is (*building 0 of 23 files*) — the lead
        * with them was cut (owner, 2026-11-21). On their own line they wrap,
        * never cut (owner, 2026-11-23). */}
      {showWords && <p className="m-0 min-w-0 [overflow-wrap:anywhere]">
        {version && s.version && <span className="num mr-2 font-semibold text-fg">{s.version}</span>}
        {href && w.key === 'merged'
          ? <a data-release-stage-words href={href} title={wordsTitle} className={`tabular-nums no-underline hover:underline ${wordsTone}`}>{w.text}</a>
          : <span data-release-stage-words title={wordsTitle} className={`tabular-nums ${wordsTone}`}>{current && (w.tone === 'active' || w.detailOnly) && w.detail ? w.detail : w.text}</span>}
      </p>}
    </div>
  )
}

/** "Last release v0.126.0 · 3h ago · 14 files · GitHub ↗". */
export function LastRelease({ last, now }: { last: NonNullable<ReleaseStatus['last']>; now: number }) {
  return (
    <p data-release-last className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[12px] text-fg-muted">
      <span className="text-fg-faint">Last release</span>
      <span className="num font-medium text-fg">{last.tag}</span>
      <span aria-hidden>·</span>
      <span className="num" title={new Date(last.at).toLocaleString()}>{fmtAgo(last.at, now)}</span>
      {last.prerelease && <><span aria-hidden>·</span><span>pre-release</span></>}
      {last.assets !== undefined && <><span aria-hidden>·</span><span className="num" title="Files uploaded to the GitHub release">{last.assets} file{last.assets === 1 ? '' : 's'}</span></>}
      {last.url && <><span aria-hidden>·</span>
        <button type="button" onClick={() => openExternal(last.url!)} className="text-accent hover:underline" {...extProps(`${last.tag} on GitHub`)}>GitHub ↗</button></>}
    </p>
  )
}
