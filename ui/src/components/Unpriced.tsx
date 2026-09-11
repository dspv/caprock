import type { BackgroundUsage, Unpriced } from '@/lib/api'
import { fmtTokens } from '@/lib/format'

const INTERNAL_NAMES: Record<string, string> = {
  'codex-auto-review': 'Codex Auto Review',
}

/** A prefilled issue is the one useful action for a genuinely unknown model.
 * Opening it transmits nothing; the user reviews and submits it themselves. */
export function unpricedIssueURL(models: string[]): string {
  const named = models.filter(Boolean)
  const label = named.join(', ') || 'unknown model id'
  const q = new URLSearchParams({
    title: `[pricing] Unknown model: ${label}`,
    body: `Caprock could not price usage reported as:\n\n${named.length ? named.map((m) => `- \`${m}\``).join('\n') : '- no model id'}\n\nNo project names, prompts, paths, tokens, or costs are attached.`,
  })
  return `https://github.com/dspv/caprock/issues/new?${q.toString()}`
}

/** Unknown public models and known internal machinery are different states:
 * one makes the estimate partial and can be reported; the other is measured
 * background usage which is not an error and asks nothing of the user. */
export function UnpricedNote({
  u,
  background,
  className = '',
}: {
  u?: Unpriced
  background?: BackgroundUsage
  className?: string
}) {
  const showUnknown = !!u && u.turns > 0
  const showBackground = !!background && background.turns > 0
  if (!showUnknown && !showBackground) return null
  return (
    <div className={`grid gap-1.5 ${className}`}>
      {showUnknown && (
        <div className="border border-warn/50 bg-warn/10 px-3 py-2 text-[12px] rounded-[var(--radius-panel)] flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-warn font-medium">Partial estimate</span>
          <span className="text-fg-muted">
            {fmtTokens(u.tokens)} tokens not included ·{' '}
            <span className="mono text-fg">{u.models.filter(Boolean).join(', ') || 'unknown model'}</span>
          </span>
          <a
            className="ml-auto text-[11px] text-fg-muted hover:text-fg border border-border px-1.5 py-0.5 rounded-sm no-underline"
            href={unpricedIssueURL(u.models)}
            target="_blank"
            rel="noreferrer"
          >
            report model
          </a>
        </div>
      )}
      {showBackground && (
        <div className="border border-border bg-panel-2/40 px-3 py-1.5 text-[11px] rounded-[var(--radius-panel)] text-fg-faint">
          Background usage · <span className="num text-fg-muted">{fmtTokens(background.tokens)} tokens</span> ·{' '}
          {background.models.map((m) => INTERNAL_NAMES[m] ?? m).join(', ')} · public price unavailable
        </div>
      )}
    </div>
  )
}
