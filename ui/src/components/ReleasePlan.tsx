/**
 * The release plan (.ai/04-ui.md § Release plan; lib/releaseplan.ts): a
 * repository's next version as a heading — its hover says how it was
 * predicted — then a row per piece of work: its number and title, a bar of
 * ten blocks filled to its step, the stage word; then what comes later. The
 * bars sit in one aligned column, as in the text report the owner asked to
 * see as a view (2026-10-15):
 *
 *   0.120.0
 *     #656 brain: agents → shared brain   ▓▓▓▓▓▓▓▓░░  merged
 *     #659 sidebar footer edge            ▓▓▓▓▓▓░░░░  CI
 *     Second Brain live build             ▓▓░░░░░░░░  agent
 *
 * Drawn on the Pipeline page, in the right panel (`compact`) and as the Work
 * page's Release view. It reads nothing itself.
 */
import { useMemo, type ReactNode } from 'react'
import type { SessionCIStats } from '@/lib/api'
import { BLOCKS, planEmpty, planForRepo, type PlanRow, type ReleasePlanData } from '@/lib/releaseplan'
import { changesRelease, useWork } from '@/lib/useWork'
import { useNow } from '@/lib/useNow'
import { pipelineHref, STEPS } from '@/lib/work'
import { SectionLabel, useFolded } from './Cockpit'
import { useDeckAnswer } from './CockpitCI'
import { Panel } from './ui'

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
}

export function ReleasePlan({ plan, compact = false, showRepo = false, onOpen, empty }: ReleasePlanProps) {
  const nothing = plan.rows.length === 0 && plan.later.length === 0
  if (nothing && !plan.next && !empty) return null
  const v = plan.next?.version
  return (
    <section data-release-plan={plan.name} aria-label={`${plan.name}: next release`} className="grid min-w-0 gap-1.5">
      <header className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <h3 data-release-version={v ?? ''} title={plan.next?.title ?? 'No changelog entries read for this repository, so no version is predicted.'}
          className={`num cursor-help font-semibold text-fg ${compact ? 'text-[13px]' : 'text-[16px] tracking-[-0.01em]'}`}>
          {v ?? 'Next release'}
        </h3>
        {v && <span className={`text-fg-faint ${compact ? 'text-[10.5px]' : 'text-[11px] uppercase tracking-[0.1em]'}`}>{compact ? 'next' : 'next release'}</span>}
        {showRepo && <span className="min-w-0 truncate text-[13px] font-medium text-fg-muted" title={plan.root}>{plan.name}</span>}
        {plan.since && (
          <span data-release-since title={plan.since.title} className={`num min-w-0 text-fg-muted [overflow-wrap:anywhere] ${compact ? 'basis-full text-[11px]' : 'text-[12.5px]'}`}>{plan.since.text}</span>
        )}
      </header>
      {nothing ? (
        <p className={`text-fg-muted ${compact ? 'text-[11.5px]' : 'text-[12.5px]'}`}>{empty ?? 'Nothing waiting for a release.'}</p>
      ) : (
        <Rows plan={plan} compact={compact} onOpen={onOpen} />
      )}
    </section>
  )
}

/**
 * Every row, the next release's and later's, in one grid, so every bar and
 * word lines up whatever the title's length: the bars stand right after the
 * longest title, as in the text report, and in the narrow right panel the
 * titles take what is left and are cut.
 */
function Rows({ plan, compact, onOpen }: { plan: ReleasePlanData; compact: boolean; onOpen?: (n: number) => void }) {
  const row = (r: PlanRow) => (
    <li key={r.key} data-release-row={r.number ?? r.key} data-stage={r.stage} className="col-span-3 grid min-w-0 grid-cols-subgrid items-center">
      <Title row={r} root={plan.root} compact={compact} onOpen={onOpen} />
      <Blocks row={r} compact={compact} />
      <span data-release-word title={r.wordTitle}
        className={`whitespace-nowrap ${compact ? 'text-[11px]' : 'text-[12px]'} ${r.red ? 'font-medium text-danger' : r.warn ? 'font-medium text-warn' : r.stage === 'merged' ? 'text-merged' : 'text-fg-muted'}`}>
        {r.word}
      </span>
    </li>
  )
  return (
    <ul className={`grid min-w-0 items-center gap-x-3 ${compact ? 'grid-cols-[minmax(0,1fr)_auto_auto] gap-y-[3px] text-[12px]' : 'w-fit max-w-full grid-cols-[minmax(0,max-content)_auto_auto] gap-y-1 text-[13px]'}`}>
      {plan.rows.map(row)}
      {plan.later.map((g) => [
        <li key={`later:${g.key}`} data-release-later={g.key}
          className={`col-span-3 pt-1.5 font-semibold uppercase tracking-[0.08em] text-fg-faint ${compact ? 'text-[10px]' : 'text-[10.5px]'}`}>
          Later · {g.label}
        </li>,
        ...g.rows.map(row),
      ])}
    </ul>
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

/**
 * Ten blocks, two per step (agent, PR, CI, merged, released): filled to the
 * step it is on, the step's two red when it failed, amber when a landing
 * label waits on the person; merged rows in the merged colour.
 */
export function Blocks({ row: r, compact = false }: { row: PlanRow; compact?: boolean }) {
  const per = BLOCKS / STEPS.length
  const stepStart = r.filled - per
  const tone = r.stage === 'merged' ? 'bg-merged' : 'bg-accent'
  return (
    <span data-release-bar role="img" aria-label={`${r.filled / per} of ${STEPS.length} steps: ${r.word}`}
      title={`${STEPS.join(' → ')}: ${r.word}`} className="flex shrink-0 items-center gap-[2px]">
      {Array.from({ length: BLOCKS }, (_, i) => {
        const on = i < r.filled
        const last = on && i >= stepStart
        const color = !on ? 'bg-border-strong' : last && r.red ? 'bg-danger' : last && r.warn ? 'bg-warn' : tone
        return <span key={i} data-block={on ? (last && r.red ? 'red' : last && r.warn ? 'warn' : 'on') : 'off'} className={`${compact ? 'h-[8px] w-[5px]' : 'h-[10px] w-[7px]'} rounded-[1.5px] ${color}`} />
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
export function PipelineRelease({ root, stats, visible, now, onOpen }: { root: string; stats?: SessionCIStats; visible: boolean; now: number; onOpen?: (n: number) => void }) {
  const work = useWork({ on: visible, changes: changesRelease })
  const plan = useMemo(() => planForRepo(work.data, root, stats, now), [work.data, root, stats, now])
  const ref = work.data?.repos?.find((r) => r.root === root)?.unreleased?.ref
  return (
    <Panel title="Next release" fold="pipeline-next-release"
      right={<span title="Pull requests from GitHub; agents, tags and changelog entries from this machine, as of your last fetch">{ref ? `changelog on ${ref}` : 'this machine'}</span>}>
      <div data-pipeline-release className="px-3 py-2.5">
        <ReleasePlan plan={plan} onOpen={onOpen} empty="Nothing merged since the last tag, no pull request open and no agent at work here." />
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
