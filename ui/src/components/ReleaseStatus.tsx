/**
 * The release's own status at the top of the Pipeline's *Next release*
 * panel (.ai/04-ui.md § Release plan, *The release status*;
 * lib/releasestatus): the version's bump and why, its stages as the pull
 * request rows' pills, and one line for the last release. Reads nothing
 * itself.
 */
import { STATUS_TEXT, stageWords, stripStages, TONE_STATE, type BatchPR, type ReleaseStatus, type StatusTone, type StripStage } from '@/lib/releasestatus'
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
  idle: 'border-[1.5px] border-fg-muted bg-transparent',
  active: 'bg-progress shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-progress)_22%,transparent)] release-step-pulse',
  waiting: 'bg-warn shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-warn)_22%,transparent)]',
  fail: 'bg-danger shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-danger)_22%,transparent)]',
  ok: 'bg-ok shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-ok)_22%,transparent)]',
}

/** A dot's state on hover, in words: *Release PR: not started*, *Merged: done*. */
function dotState(x: StripStage, current: boolean, tone: StatusTone): string {
  if (current) return TONE_STATE[tone]
  if (x.state === 'done') return 'done'
  return x.unknown ? 'not known' : 'not started'
}

/**
 * The right panel's stages (owner, 2026-11-19, variant A, translated: "dots,
 * one word — looks more logical"; the word strip of 2026-11-18 wrapped
 * *Published* to a second line at 330px): five dots joined by short lines —
 * Merged, Release PR, Tagged, Building, Published (lib/releasestatus
 * stripStages) — done ones green with a green line after them, the one it
 * is at in the status's colour (owner, 2026-11-20: hollow grey when nothing
 * is happening, blue and pulsing in progress, amber waiting, red stopped,
 * green done), the rest the track's; each dot says its stage and its state
 * in words on hover (*Release PR: not started*). Beside them the status,
 * plain words first and the detail after (stageWords): *Ready to release ·
 * not started*, cut with an ellipsis before it wraps. `version` puts a tag
 * already under way first, where no heading above names it.
 */
export function ReleaseStrip({ status: s, version, out, cards, batch, now = Date.now(), href, kept }: {
  status: ReleaseStatus; version?: boolean; out?: boolean
  /** Where the words go when they name the batch pull request (*Waiting for #977 · CI red*): the Pipeline on it. */
  href?: string
  /** Drawn from a kept copy being read again: faint, its age on hover (owner, 2026-11-20). */
  kept?: string
  /** The board's cards: the release pull request's checks per OS, for *checks 1 of 3 systems*. */
  cards?: readonly BoardCard[]
  /** The batch pull request, for *Waiting for #949 to merge*. */
  batch?: BatchPR
  now?: number
}) {
  const stages = stripStages(s, { out })
  const w = stageWords(s, stages, { cards, out, now, batch })
  if (!stages.length || !w) return null
  const at = w.index - 1
  const current = stages[at]?.state === 'current'
  return (
    <div data-release-strip data-release-current={current ? w.key : ''} data-release-tone={w.tone} data-release-kept={kept ? '' : undefined} role="group"
      aria-label={`Release stage ${w.index} of ${stages.length}: ${w.name}, ${current ? TONE_STATE[w.tone] : 'done'}`}
      className={`flex h-[16px] min-w-0 items-center text-[11.5px] leading-[16px]${kept ? ' opacity-70 saturate-50' : ''}`}>
      {version && s.version && <span className="num mr-2 shrink-0 font-semibold text-fg">{s.version}</span>}
      <span aria-hidden className="flex shrink-0 items-center">
        {stages.map((x, i) => {
          const done = x.state === 'done'
          const now_ = i === at && current
          return (
            <span key={x.key} className="flex items-center">
              {i > 0 && <span data-strip-line={stages[i - 1]!.state === 'done' ? 'done' : 'todo'} className={`h-[2px] w-[18px] ${stages[i - 1]!.state === 'done' ? 'bg-ok' : 'bg-border-strong'}`} />}
              <span data-strip-stage={x.key} data-step-state={x.state} data-step-unknown={x.unknown ? '' : undefined}
                title={`${x.text}: ${dotState(x, now_, w.tone)}\n${now_ && w.title ? w.title : x.title}`}
                className={`box-border block size-[8px] shrink-0 rounded-full ${now_ ? DOT_NOW[w.tone] : done ? 'bg-ok' : 'bg-border-strong'}`} />
            </span>
          )
        })}
      </span>
      {href && w.key === 'merged'
        ? <a data-release-stage-words href={href} title={[w.title ?? stages[at]?.title, kept].filter(Boolean).join('\n')} className={`ml-2.5 min-w-0 truncate tabular-nums no-underline hover:underline ${current ? STATUS_TEXT[w.tone] : 'text-ok'}`}>{w.text}</a>
        : <span data-release-stage-words title={[w.title ?? stages[at]?.title, kept].filter(Boolean).join('\n')} className={`ml-2.5 min-w-0 truncate tabular-nums ${current ? STATUS_TEXT[w.tone] : 'text-ok'}`}>{w.text}</span>}
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
