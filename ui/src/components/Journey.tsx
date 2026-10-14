/**
 * A pull request's four steps, drawn two ways from lib/journey: pills on the
 * Pipeline page's rows, a thin four-part bar in the cockpit. The step it is
 * on is coloured — its CI's colour on the CI step — the ones behind it are
 * muted, the ones ahead faint.
 */
import type { JourneyStep, StepTone } from '@/lib/journey'

const PILL: Record<StepTone, string> = {
  ok: 'border-ok/45 bg-ok/10 text-ok',
  fail: 'border-danger/45 bg-danger/10 text-danger',
  pending: 'border-warn/45 bg-warn/10 text-warn',
  merged: 'border-merged/45 bg-merged/10 text-merged',
  accent: 'border-accent/50 bg-accent/10 text-accent',
  muted: 'border-[var(--app-hairline-strong)] text-fg-muted',
  faint: 'border-[var(--app-hairline)] text-fg-faint',
}

const BAR: Record<StepTone, string> = {
  ok: 'bg-ok', fail: 'bg-danger', pending: 'bg-warn', merged: 'bg-merged', accent: 'bg-accent', muted: 'bg-fg-muted', faint: 'bg-[var(--app-hairline-strong)]',
}

export function JourneyPills({ steps }: { steps: JourneyStep[] }) {
  return (
    <span data-journey className="flex min-w-0 items-center gap-1 text-[11px]">
      {steps.map((s, i) => (
        <span key={s.key} className="flex items-center gap-1">
          {i > 0 && <span aria-hidden className={`text-[10px] ${s.state === 'todo' ? 'text-fg-faint/60' : 'text-fg-faint'}`}>→</span>}
          <span data-journey-step={s.key} data-step-state={s.state} title={s.title}
            className={`inline-flex h-[19px] items-center whitespace-nowrap rounded-full border px-1.5 ${
              s.state === 'current' || s.state === 'closed' ? `${PILL[s.tone]} font-medium` : s.state === 'done' ? 'border-transparent text-fg-muted' : 'border-transparent text-fg-faint/70'}`}>
            {s.state === 'done' && <span aria-hidden className="mr-0.5 text-[10px]">✓</span>}
            {s.state === 'current' && s.tone === 'pending' && <span aria-hidden className="ci-spin mr-1 inline-block h-[7px] w-[7px] rounded-full" />}
            {s.text}
          </span>
        </span>
      ))}
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
