/**
 * A pull request's four steps, drawn two ways from lib/journey: pills on the
 * Pipeline page's rows, a thin four-part bar in the cockpit. The step it is
 * on is coloured — its CI's colour on the CI step — the ones behind it are
 * checked, the ones ahead outlined.
 */
import type { JourneyStep, StepTone } from '@/lib/journey'

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
 * ring while CI runs; a step still ahead is a dashed outline.
 */
export function JourneyPills({ steps }: { steps: JourneyStep[] }) {
  return (
    <span data-journey className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 text-[12px]">
      {steps.map((s, i) => {
        const now = s.state === 'current' || s.state === 'closed'
        return (
          <span key={s.key} className="flex items-center gap-1">
            {i > 0 && <span aria-hidden className={`text-[11px] ${s.state === 'todo' ? 'text-fg-faint' : 'text-fg-muted'}`}>→</span>}
            <span data-journey-step={s.key} data-step-state={s.state} title={s.title}
              className={`inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-full border px-2 ${
                now ? `${PILL[s.tone]} font-semibold` : s.state === 'done' ? 'border-transparent px-1 text-fg-muted' : 'border-dashed border-border-strong text-fg-faint'}`}>
              {s.state === 'done' && <span aria-hidden className="text-[11px] text-ok">✓</span>}
              {now && s.tone === 'fail' && <span aria-hidden className="text-[11px]">✗</span>}
              {now && s.tone === 'pending' && <span aria-hidden className="ci-spin inline-block h-[8px] w-[8px] rounded-full" />}
              {s.text}
            </span>
          </span>
        )
      })}
    </span>
  )
}

/** Four thin segments: done ones muted, the current one in its colour, the rest a hairline. */
export function JourneyBar({ steps, className = '' }: { steps: JourneyStep[]; className?: string }) {
  const now = steps.find((s) => s.state === 'current' || s.state === 'closed')
  return (
    <span data-journey-bar role="img" aria-label={steps.map((s) => `${s.text}${s.state === 'current' ? ' (now)' : s.state === 'done' ? ' (done)' : ''}`).join(', ')}
      title={now ? `${now.text}: ${now.title}` : undefined} className={`grid grid-cols-4 gap-[3px] ${className}`}>
      {steps.map((s) => (
        <span key={s.key} data-journey-seg={s.key} data-step-state={s.state}
          className={`h-[4px] rounded-full ${s.state === 'current' || s.state === 'closed' ? `${BAR[s.tone]} ${s.tone === 'pending' ? 'animate-pulse motion-reduce:animate-none' : ''}` : s.state === 'done' ? 'bg-fg-faint/70' : 'bg-[var(--app-hairline)]'}`} />
      ))}
    </span>
  )
}
