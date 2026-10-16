/**
 * The release plan (.ai/04-ui.md § Release plan; lib/releaseplan.ts): a
 * repository's next version as a heading — its hover says how it was
 * predicted — then a row per piece of work: its number and title, a bar of a
 * named segment per step filled to its step, the stage word, and as width
 * allows what it waits for, its age and its CI per OS; then what comes
 * later. The bars sit in one aligned column, as in the text report the owner
 * asked to see as a view (2026-10-15):
 *
 *   0.120.0
 *     #656 brain: agents → shared brain   ▓▓▓▓░  merged  a release         5h
 *     #659 sidebar footer edge            ▓▓▓░░  CI      CI on Windows · 6m  19h  ● ● ●
 *     Second Brain live build             ▓░░░░  agent   the agent · 3 of 7  40m
 *
 * The bar grows with the row (owner, 2026-10-16, translated: "a lot of empty
 * space wasted — make it bigger, or add some indicator"); the extra columns
 * drop off first as the container narrows (a container query), never a
 * sideways scroll.
 *
 * Drawn on the Pipeline page, in the right panel (`compact`), as the Work
 * page's Release view, and on the phone home (`phone`: components/
 * PhoneReleases). It reads nothing itself.
 */
import { useMemo, type ReactNode } from 'react'
import type { ReleaseCI, SessionCIStats } from '@/lib/api'
import { asBoard } from '@/lib/prboard'
import { releaseStatus, type ReleaseStatus } from '@/lib/releasestatus'
import { LastRelease, ReleaseInFlight, ReleaseStages, ReleaseWhy } from './ReleaseStatus'
import { BLOCKS, planEmpty, planForRepo, type OSDot, type PlanRow, type ReleasePlanData, type Wait } from '@/lib/releaseplan'
import { changesRelease, useWork } from '@/lib/useWork'
import { useNow } from '@/lib/useNow'
import { pipelineHref, STEPS } from '@/lib/work'
import { SectionLabel, useFolded } from './Cockpit'
import { useDeckAnswer } from './CockpitCI'
import { Panel } from './ui'
import { extTitle } from '@/lib/externalLinks'

export interface ReleasePlanProps {
  plan: ReleasePlanData
  /** The right panel's size: smaller type, titles on one line. */
  compact?: boolean
  /** Name the repository beside the version (the Work page lists several). */
  showRepo?: boolean
  /** A pull request row opens this instead of the Pipeline's detail link (the Pipeline page opens it in place). */
  onOpen?: (number: number) => void
  /** Said when there is nothing to plan; absent, nothing is drawn. */
  empty?: ReactNode
  /**
   * The phone's size (390px): a row is a 44px tap target with its title on
   * one line and the bar and word under it, so every bar starts at the same
   * left edge whatever the title; a pull request row opens the pull request
   * on GitHub. Takes over `compact` and `onOpen`.
   */
  phone?: boolean
  /**
   * The release's own status (lib/releasestatus; the Pipeline page): its
   * bump and why beside the version, its stages as pills under it, a tag
   * already under way above it, and the last release under the rows.
   */
  status?: ReleaseStatus
  /** The clock the last release's age is said against; with `status`. */
  now?: number
}

export function ReleasePlan({ plan, compact = false, showRepo = false, onOpen, empty, phone = false, status, now = Date.now() }: ReleasePlanProps) {
  const nothing = plan.rows.length === 0 && plan.later.length === 0
  if (nothing && !plan.next && !empty) return null
  // A release pull request names the version; else the rule's prediction.
  const pre = status?.phase === 'pre' ? status : undefined
  const v = pre?.version ?? plan.next?.version
  return (
    <section data-release-plan={plan.name} aria-label={`${plan.name}: next release`} className="grid min-w-0 gap-1.5">
      {status?.phase === 'tagged' && <ReleaseInFlight status={status} phone={phone} />}
      <header className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <h3 data-release-version={v ?? ''} title={pre?.why?.title ?? plan.next?.title ?? 'No changelog entries read for this repository, so no version is predicted.'}
          className={`num font-semibold text-fg ${phone ? 'text-[17px] tracking-[-0.01em]' : compact ? 'cursor-help text-[13px]' : 'cursor-help text-[16px] tracking-[-0.01em]'}`}>
          {v ?? 'Next release'}
        </h3>
        {v && <span className={`text-fg-faint ${compact && !phone ? 'text-[10.5px]' : 'text-[11px] uppercase tracking-[0.1em]'}`}>{compact && !phone ? 'next' : 'next release'}</span>}
        {pre && <ReleaseWhy status={pre} />}
        {showRepo && <span className="min-w-0 truncate text-[13px] font-medium text-fg-muted" title={plan.root}>{plan.name}</span>}
        {plan.since && (
          <span data-release-since title={plan.since.title} className={`num min-w-0 text-fg-muted [overflow-wrap:anywhere] ${phone ? 'basis-full text-[12.5px]' : compact ? 'basis-full text-[11px]' : 'text-[12.5px]'}`}>{plan.since.text}</span>
        )}
      </header>
      {pre && <ReleaseStages status={pre} />}
      {nothing ? (
        <p className={`text-fg-muted ${phone ? 'text-[14px]' : compact ? 'text-[11.5px]' : 'text-[12.5px]'}`}>{empty ?? 'Nothing waiting for a release.'}</p>
      ) : phone ? (
        <PhoneRows plan={plan} />
      ) : (
        <Rows plan={plan} compact={compact} onOpen={onOpen} />
      )}
      {status?.last && <LastRelease last={status.last} now={now} />}
    </section>
  )
}

/**
 * Every row, the next release's and later's, in one grid, so every bar and
 * column lines up whatever the title's length. The title and the bar share
 * the width the other columns leave (1.4 : 1, so the bar is never past ~40%
 * of the row; the cockpit's 2.2 : 1), and the columns beside the word come
 * in as the container widens — what it waits for at 520px, the agent cost
 * at 600px, CI per OS at 680px, the CI time at 760px, the age at 840px — so
 * a narrow panel drops the age first and what it waits for last. No column
 * gap: each cell after the title carries its own left padding, so a column
 * no row fills is zero wide.
 */
function Rows({ plan, compact, onOpen }: { plan: ReleasePlanData; compact: boolean; onOpen?: (n: number) => void }) {
  const size = compact ? 'text-[11px]' : 'text-[12px]'
  const row = (r: PlanRow) => (
    <li key={r.key} data-release-row={r.number ?? r.key} data-stage={r.stage} className="col-span-full grid min-w-0 grid-cols-subgrid items-center">
      <Title row={r} root={plan.root} compact={compact} onOpen={onOpen} />
      <span className="min-w-0 pl-3"><Blocks row={r} compact={compact} /></span>
      <Word row={r} className={`whitespace-nowrap pl-3 ${size}`} />
      <span data-release-col="wait" className="hidden min-w-0 @[520px]/plan:block">{r.wait && <WaitFor wait={r.wait} compact={compact} />}</span>
      <span data-release-col="citime" className="hidden @[760px]/plan:block">
        {r.ciTime && <span data-release-citime title={r.ciTime.title} className={`num block whitespace-nowrap pl-3 text-right ${size} ${r.ciTime.tone === 'warn' ? 'text-warn' : 'text-fg-muted'}`}>{r.ciTime.text}</span>}
      </span>
      <span data-release-col="ci" className="hidden @[680px]/plan:block">{r.ci && <OSDots dots={r.ci} />}</span>
      <span data-release-col="cost" className="hidden @[600px]/plan:block">
        <span data-release-cost title={r.cost.title} className={`num block whitespace-nowrap pl-3 text-right ${size} ${r.cost.known ? 'text-fg-muted' : 'text-fg-faint'}`}>{r.cost.text}</span>
      </span>
      <span data-release-col="age" className="hidden @[840px]/plan:block">
        {r.age && <span data-release-age title={r.age.title} className={`num block whitespace-nowrap pl-3 text-right text-fg-faint ${size}`}>{r.age.text}</span>}
      </span>
    </li>
  )
  return (
    <div className="@container/plan min-w-0">
      <ul data-release-rows className={`grid min-w-0 items-center ${compact
        ? 'grid-cols-[minmax(0,2.2fr)_minmax(60px,1fr)_auto] gap-y-[3px] text-[12px] @[520px]/plan:grid-cols-[minmax(0,2.2fr)_minmax(60px,1fr)_repeat(2,auto)] @[600px]/plan:grid-cols-[minmax(0,2.2fr)_minmax(60px,1fr)_repeat(3,auto)] @[680px]/plan:grid-cols-[minmax(0,2.2fr)_minmax(60px,1fr)_repeat(4,auto)] @[760px]/plan:grid-cols-[minmax(0,2.2fr)_minmax(60px,1fr)_repeat(5,auto)] @[840px]/plan:grid-cols-[minmax(0,2.2fr)_minmax(60px,1fr)_repeat(6,auto)]'
        : 'grid-cols-[minmax(0,1.4fr)_minmax(88px,1fr)_auto] gap-y-1 text-[13px] @[520px]/plan:grid-cols-[minmax(0,1.4fr)_minmax(88px,1fr)_repeat(2,auto)] @[600px]/plan:grid-cols-[minmax(0,1.4fr)_minmax(88px,1fr)_repeat(3,auto)] @[680px]/plan:grid-cols-[minmax(0,1.4fr)_minmax(88px,1fr)_repeat(4,auto)] @[760px]/plan:grid-cols-[minmax(0,1.4fr)_minmax(88px,1fr)_repeat(5,auto)] @[840px]/plan:grid-cols-[minmax(0,1.4fr)_minmax(88px,1fr)_repeat(6,auto)]'}`}>
        {plan.rows.map(row)}
        {plan.later.map((g) => [
          <li key={`later:${g.key}`} data-release-later={g.key}
            className={`col-span-full pt-1.5 font-semibold uppercase tracking-[0.08em] text-fg-faint ${compact ? 'text-[10px]' : 'text-[10.5px]'}`}>
            Later · {g.label}
          </li>,
          ...g.rows.map(row),
        ])}
      </ul>
    </div>
  )
}

/** What a row waits for now, cut to its column; the whole of it and where it comes from on hover. */
function WaitFor({ wait: w, compact }: { wait: Wait; compact: boolean }) {
  return (
    <span data-release-wait title={w.title}
      className={`block max-w-[18rem] truncate pl-3 ${compact ? 'text-[11px]' : 'text-[12px]'} ${w.tone === 'danger' ? 'text-danger' : w.tone === 'warn' ? 'text-warn' : 'text-fg-muted'}`}>
      {w.text}
    </span>
  )
}

const DOT_TONE: Record<OSDot['state'], string> = { pass: 'bg-ok', fail: 'bg-danger', running: 'bg-accent release-step-pulse' }

/** A dot per OS its checks ran on, macOS · Linux · Windows, each named on hover. */
function OSDots({ dots }: { dots: OSDot[] }) {
  return (
    <span data-release-ci role="img" aria-label={`CI: ${dots.map((d) => d.title).join('; ')}`} className="flex items-center gap-[5px] pl-3">
      {dots.map((d) => <span key={d.os} data-os={d.os} data-os-state={d.state} title={d.title} className={`h-[7px] w-[7px] rounded-full ${DOT_TONE[d.state]}`} />)}
    </span>
  )
}

/**
 * The phone's rows: one per piece of work, its title on the first line (cut,
 * the whole of it on the second line's hover) and the bar, the stage word
 * and what it waits for (cut) on the second, so the bars stand in one column
 * at the left edge at any width. A pull request row is a link to it on GitHub, the whole row its target.
 */
function PhoneRows({ plan }: { plan: ReleasePlanData }) {
  const row = (r: PlanRow) => {
    const body = (
      <>
        <span className="flex min-w-0 items-baseline text-[14px] leading-[1.3]">
          {r.number ? <span className="num mr-1.5 shrink-0 text-fg-muted">#{r.number}</span> : null}
          <span className="min-w-0 truncate text-fg">{r.title}</span>
        </span>
        <span className="flex min-w-0 items-center gap-2.5">
          <Blocks row={r} phone />
          <Word row={r} className="shrink-0 whitespace-nowrap text-[12.5px]" />
          {r.wait && <span data-release-wait title={r.wait.title} className={`min-w-0 truncate text-[12.5px] ${r.wait.tone === 'danger' ? 'text-danger' : r.wait.tone === 'warn' ? 'text-warn' : 'text-fg-faint'}`}>{r.wait.text}</span>}
        </span>
      </>
    )
    const cls = 'grid min-h-11 min-w-0 content-center gap-1 px-3 py-2'
    return (
      <li key={r.key} data-release-row={r.number ?? r.key} data-stage={r.stage} className="min-w-0 border-b border-border last:border-b-0">
        {r.url
          ? <a href={r.url} target="_blank" rel="noopener noreferrer" title={extTitle(r.title)} className={`${cls} text-fg no-underline active:bg-panel-2`}>{body}</a>
          : <div title={r.title} className={cls}>{body}</div>}
      </li>
    )
  }
  return (
    <ul data-release-phone className="-mx-3 min-w-0 border-t border-border">
      {plan.rows.map(row)}
      {plan.later.map((g) => [
        <li key={`later:${g.key}`} data-release-later={g.key}
          className="border-b border-border px-3 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-faint last:border-b-0">
          Later · {g.label}
        </li>,
        ...g.rows.map(row),
      ])}
    </ul>
  )
}

/** The stage word, in the colour its step is drawn in. */
function Word({ row: r, className }: { row: PlanRow; className: string }) {
  return (
    <span data-release-word title={r.wordTitle}
      className={`${className} ${r.red ? 'font-medium text-danger' : r.warn ? 'font-medium text-warn' : r.stage === 'merged' ? 'text-merged' : 'text-fg-muted'}`}>
      {r.word}
    </span>
  )
}

function Title({ row: r, root, compact, onOpen }: { row: PlanRow; root: string; compact: boolean; onOpen?: (n: number) => void }) {
  const text = (
    <>
      {r.number ? <span className="num mr-1.5 text-fg-muted">#{r.number}</span> : null}
      <span className="text-fg">{r.title}</span>
    </>
  )
  const cls = `min-w-0 text-left no-underline hover:[&>span:last-child]:text-accent ${compact ? 'truncate' : '[overflow-wrap:anywhere]'}`
  if (!r.number) return <span className={compact ? 'min-w-0 truncate' : 'min-w-0 [overflow-wrap:anywhere]'} title={r.title}>{text}</span>
  if (onOpen) return <button type="button" onClick={() => onOpen(r.number!)} title={r.title} className={cls}>{text}</button>
  return <a href={pipelineHref(root, r.number)} title={r.title} className={cls}>{text}</a>
}

const STEP_NAME: Record<(typeof STEPS)[number], string> = { agent: 'Agent', PR: 'Pull request', CI: 'CI', merged: 'Merged', released: 'Released' }
const STEP_SAYS: Record<StepState, string> = { done: 'done', now: 'under way', red: 'failed', warn: 'waits on you', off: 'to come' }
export type StepState = 'done' | 'now' | 'red' | 'warn' | 'off'

/** Each step's state on a row's bar: done up to the one it is on, that one red, amber or under way when it is. */
export function stepStates(r: Pick<PlanRow, 'filled' | 'red' | 'warn' | 'running'>): StepState[] {
  const on = Math.round(r.filled / (BLOCKS / STEPS.length))
  return STEPS.map((_, i) => {
    if (i >= on) return 'off'
    if (i < on - 1) return 'done'
    return r.red ? 'red' : r.warn ? 'warn' : r.running ? 'now' : 'done'
  })
}

/**
 * A segment per step (agent, PR, CI, merged, released), each named on hover:
 * filled to the step it is on, that step red when it failed, amber when a
 * landing label waits on the person, pulsing softly while it is under way
 * (CI running, an agent at work); merged rows in the merged colour. On a
 * page it fills its column, so it grows with the row; on the phone it is a
 * fixed width.
 */
export function Blocks({ row: r, compact = false, phone = false }: { row: PlanRow; compact?: boolean; phone?: boolean }) {
  const states = stepStates(r)
  const tone = r.stage === 'merged' ? 'bg-merged' : 'bg-accent'
  const on = states.filter((s) => s !== 'off').length
  return (
    <span data-release-bar role="img" aria-label={`${on} of ${STEPS.length} steps: ${r.word}`}
      className={`flex items-center gap-[3px] ${phone ? 'shrink-0' : 'w-full'}`}>
      {STEPS.map((step, i) => {
        const s = states[i]!
        const color = s === 'off' ? 'bg-border-strong' : s === 'red' ? 'bg-danger' : s === 'warn' ? 'bg-warn' : tone
        return <span key={step} data-step={step} data-step-state={s} title={`${STEP_NAME[step]}: ${STEP_SAYS[s]}${s === 'off' || s === 'done' ? '' : ` — ${r.word}`}`}
          className={`${phone ? 'h-[10px] w-[16px]' : compact ? 'h-[7px] min-w-[8px] flex-1' : 'h-[9px] min-w-[12px] flex-1'} rounded-[2px] ${color}${s === 'now' ? ' release-step-pulse' : ''}`} />
      })}
    </span>
  )
}

/**
 * The Pipeline page's *Next release* panel, under Flow: the repository on
 * the page, from the page's own Pipeline answer and the Work answer (read
 * while the page is in front, again on GitHub news only). A row opens its
 * pull request beside the list, as the list's rows do.
 */
export function PipelineRelease({ root, stats, run, visible, now, onOpen }: { root: string; stats?: SessionCIStats; run?: ReleaseCI; visible: boolean; now: number; onOpen?: (n: number) => void }) {
  const work = useWork({ on: visible, changes: changesRelease })
  const plan = useMemo(() => planForRepo(work.data, root, stats, now), [work.data, root, stats, now])
  const repo = work.data?.repos?.find((r) => r.root === root)
  const ref = repo?.unreleased?.ref
  const status = useMemo(() => {
    const board = asBoard(stats?.board)
    return releaseStatus({
      lastTag: repo?.tags?.last, unreleased: repo?.unreleased, merged: plan.rows.filter((r) => r.stage === 'merged').length,
      prs: stats?.prs ?? [], cards: board?.cards, releases: board?.releases ?? [], run,
    })
  }, [repo, plan.rows, stats, run])
  return (
    <Panel title="Next release" fold="pipeline-next-release"
      right={<span title="Pull requests from GitHub; agents, tags and changelog entries from this machine, as of your last fetch">{ref ? `changelog on ${ref}` : 'this machine'}</span>}>
      <div data-pipeline-release className="px-3 py-2.5">
        <ReleasePlan plan={plan} onOpen={onOpen} status={status} now={now} empty="Nothing merged since the last tag, no pull request open and no agent at work here." />
      </div>
    </Panel>
  )
}

/**
 * The right panel's *Release* section: the session's repository's next
 * release, compact. It asks GitHub nothing: it draws the Pipeline answer the
 * CI section, the Pipeline page or the Work page last read for that
 * repository (lib/deckCache), and the Work answer, read while the section is
 * unfolded and again only on GitHub news (changesRelease) — never on every
 * turn of the agent beside it. Folded, the version and the count are its line.
 */
export function CockpitRelease({ sessionId, repoRoot }: { sessionId: string; repoRoot?: string }) {
  const folded = useFolded()
  const stats = useDeckAnswer<SessionCIStats>(`stats:${repoRoot || sessionId}`)
  const work = useWork({ on: !folded && !!repoRoot, changes: changesRelease })
  const now = useNow(60_000)
  const plan = useMemo(() => (repoRoot ? planForRepo(work.data, repoRoot, stats.d, now) : undefined), [work.data, repoRoot, stats.d, now])
  if (!plan || (!folded && planEmpty(plan))) return null
  const n = plan.rows.length
  return (
    <section aria-label="Release" data-cockpit-release className="grid gap-2">
      <SectionLabel right={folded && (
        <span data-fold-only className="num flex min-w-0 items-baseline gap-1.5 text-fg-muted">
          {plan.next?.version && <span className="font-medium text-fg">{plan.next.version}</span>}
          <span>{n} in work</span>
        </span>
      )}>Release</SectionLabel>
      <ReleasePlan plan={plan} compact />
    </section>
  )
}
