/**
 * A pull request's four steps, drawn two ways from lib/journey: pills on the
 * Pipeline page's rows, a thin four-part bar in the cockpit. The step it is
 * on is coloured — its CI's colour on the CI step — the ones behind it are
 * checked, the ones ahead outlined.
 */
import type { CSSProperties } from 'react'
import { RELEASED_MEANS, STEP_NAME, stepKeys, type JourneyPillStep, type JourneyStep, type StepTone } from '@/lib/journey'
import type { ShipsBy } from '@/lib/prboard'

const PILL: Record<StepTone, string> = {
  ok: 'border-ok/55 bg-ok/15 text-ok',
  fail: 'border-danger/60 bg-danger/15 text-danger',
  pending: 'border-warn/55 bg-warn/15 text-warn',
  merged: 'border-merged/55 bg-merged/15 text-merged',
  accent: 'border-accent/60 bg-accent/15 text-accent',
  muted: 'border-border-strong bg-panel-2 text-fg',
  faint: 'border-border-strong text-fg-muted',
}

const BAR: Record<StepTone, string> = {
  ok: 'bg-ok', fail: 'bg-danger', pending: 'bg-warn', merged: 'bg-merged', accent: 'bg-accent', muted: 'bg-fg-muted', faint: 'bg-[var(--app-hairline-strong)]',
}

/**
 * The four steps as pills, each state told by its shape as well as its
 * colour (owner, 2026-10-15: the stages must read at a glance — done,
 * current, waiting, failed): a step passed is plain text with a green ✓; the
 * step it is on is a filled pill in its colour, a ✗ when it failed, a turning
 * ring while CI runs; a step still ahead is a dashed outline, and one
 * nothing read can place (`unknown`) a dotted outline with a "?". Also draws
 * a release's stages (components/ReleaseStatus), with `label` naming the list.
 */
export function JourneyPills({ steps, label }: { steps: readonly JourneyPillStep[]; label?: string }) {
  return (
    <span data-journey role={label ? 'list' : undefined} aria-label={label} className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 text-[12px]">
      {steps.map((s, i) => {
        const now = s.state === 'current' || s.state === 'closed'
        return (
          <span key={s.key} className="flex items-center gap-1" role={label ? 'listitem' : undefined}>
            {i > 0 && <span aria-hidden className={`text-[11px] ${s.state === 'todo' ? 'text-fg-faint' : 'text-fg-muted'}`}>→</span>}
            <span data-journey-step={s.key} data-step-state={s.state} data-step-unknown={s.unknown ? '' : undefined} title={s.title}
              className={`inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-full border px-2 ${
                now ? `${PILL[s.tone]} font-semibold` : s.state === 'done' ? 'border-transparent px-1 text-fg-muted' : s.unknown ? 'border-dotted border-border-strong text-fg-faint' : 'border-dashed border-border-strong text-fg-faint'}`}>
              {s.state === 'done' && <span aria-hidden className="text-[11px] text-ok">✓</span>}
              {now && s.tone === 'fail' && <span aria-hidden className="text-[11px]">✗</span>}
              {now && s.tone === 'pending' && <span aria-hidden className="ci-spin inline-block h-[8px] w-[8px] rounded-full" />}
              {s.text}
              {s.unknown && <span aria-hidden className="text-[11px]">?</span>}
            </span>
          </span>
        )
      })}
    </span>
  )
}

/**
 * One word for where a step is, for a segment's tooltip: done, running,
 * failed, waiting — and stopped for a pull request closed there. The step it
 * is on reads as done when it got there whole (CI green, merged, released),
 * as waiting when nothing has happened on it yet (a draft, no checks).
 */
export function stepStateWord(s: JourneyStep): 'done' | 'running' | 'failed' | 'waiting' | 'stopped' | 'not known' {
  if (s.unknown) return 'not known'
  if (s.state === 'done') return 'done'
  if (s.state === 'todo') return 'waiting'
  if (s.state === 'closed') return 'stopped'
  if (s.tone === 'pending') return 'running'
  if (s.tone === 'fail') return 'failed'
  return s.tone === 'muted' || s.tone === 'faint' ? 'waiting' : 'done'
}

/** A segment's tooltip: the step's name and state, what it says, and a landing label on the step it is on. */
export function segmentTitle(s: JourneyStep, landing?: string): string {
  const name = STEP_NAME[s.key]
  const word = s.text !== name ? ` — ${s.text}` : ''
  const lands = landing && (s.state === 'current' || s.state === 'closed') ? ` · ${landing}` : ''
  return `${name}: ${stepStateWord(s)}${word}${lands}. ${s.title}`
}

/** A grid of n equal columns: the bar and its legend, three steps or four. */
const cols = (n: number): CSSProperties => ({ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` })

/**
 * Thin segments, one per step (three where the repository ships on merge):
 * done ones muted, the current one in its colour, the rest a hairline, one
 * nothing read can place dotted. Each segment has its own tooltip
 * (`segmentTitle`), and a hover target taller than the 4px it draws, which
 * takes no room.
 */
export function JourneyBar({ steps, landing, className = '' }: { steps: JourneyStep[]; landing?: string; className?: string }) {
  return (
    <span data-journey-bar role="img" aria-label={steps.map((s) => `${STEP_NAME[s.key]} ${stepStateWord(s)}${s.text !== STEP_NAME[s.key] ? ` (${s.text})` : ''}`).join(', ') + (landing ? `, ${landing}` : '')}
      className={`grid gap-[3px] ${className}`} style={cols(steps.length)}>
      {steps.map((s) => (
        <span key={s.key} data-journey-seg={s.key} data-step-state={s.state} data-step-unknown={s.unknown ? '' : undefined} title={segmentTitle(s, landing)}
          className={`relative h-[4px] rounded-full before:absolute before:inset-x-0 before:-inset-y-[5px] before:content-[''] ${s.state === 'current' || s.state === 'closed' ? `${BAR[s.tone]} ${s.tone === 'pending' ? 'animate-pulse motion-reduce:animate-none' : ''}` : s.state === 'done' ? 'bg-fg-faint/70' : s.unknown ? 'bg-[repeating-linear-gradient(90deg,var(--app-hairline-strong)_0_3px,transparent_3px_6px)]' : 'bg-[var(--app-hairline)]'}`} />
      ))}
    </span>
  )
}

/**
 * The step names over the bars' columns, once above the rows (owner,
 * 2026-10-15, translated: "it's not clear what the stages are"): the same
 * grid as JourneyBar, in the faint caption style, so each word sits over its
 * segment and no row grows. No *released* where the repository ships on
 * merge; where it is, its hover says what it means.
 */
export function JourneyLegend({ ships, className = '' }: { ships?: ShipsBy; className?: string }) {
  const keys = stepKeys(ships)
  return (
    <span data-journey-legend aria-hidden className={`grid gap-[3px] text-[10px] leading-[12px] text-fg-faint ${className}`} style={cols(keys.length)}>
      {keys.map((k) => <span key={k} data-journey-legend-step={k} title={k === 'released' ? RELEASED_MEANS : undefined} className="truncate">{k === 'ci' ? 'CI' : STEP_NAME[k].toLowerCase()}</span>)}
    </span>
  )
}
