/**
 * The release's own status at the top of the Pipeline's *Next release*
 * panel (.ai/04-ui.md § Release plan, *The release status*;
 * lib/releasestatus): the version's bump and why, its stages as the pull
 * request rows' pills, and one line for the last release. Reads nothing
 * itself.
 */
import type { ReleaseStatus } from '@/lib/releasestatus'
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
