import { useState } from 'react'
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
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const showUnknown = !!u && u.turns > 0
  const showBackground = !!background && background.turns > 0
  if (!showUnknown && !showBackground) return null
  const models = u?.models.filter(Boolean) ?? []
  const modelLabel = models.join(', ') || 'unknown model'

  async function copyModels() {
    try {
      await navigator.clipboard?.writeText(models.join('\n') || 'unknown model id')
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard access is optional on localhost and must not turn a useful
      // diagnostic into an error state.
    }
  }

  return (
    <div className={`grid gap-1.5 ${className}`}>
      {showUnknown && (
        <div className="border border-warn/50 bg-warn/10 px-3 py-1.5 text-[12px] rounded-[var(--radius-panel)]">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-warn font-medium">Partial cost</span>
            <span className="text-fg-muted">{fmtTokens(u.tokens)} tokens not priced</span>
            <span className="mono text-fg truncate max-w-full" title={modelLabel}>{modelLabel}</span>
            <div className="ml-auto flex items-center gap-1">
              <button
                className="text-[11px] text-fg-muted hover:text-fg border border-border px-1.5 py-0.5 rounded-sm"
                onClick={() => void copyModels()}
                type="button"
              >
                {copied ? 'copied' : 'copy model'}
              </button>
              <a
                className="text-[11px] text-fg-muted hover:text-fg border border-border px-1.5 py-0.5 rounded-sm no-underline"
                href={unpricedIssueURL(u.models)}
                target="_blank"
                rel="noreferrer"
              >
                report
              </a>
              <button
                className="text-[11px] text-fg-muted hover:text-fg px-1.5 py-0.5"
                onClick={() => setDetailsOpen((open) => !open)}
                type="button"
                aria-expanded={detailsOpen}
              >
                why?
              </button>
            </div>
          </div>
          {detailsOpen && (
            <div className="mt-1.5 border-t border-warn/20 pt-1.5 text-[11px] text-fg-muted leading-[1.4]">
              Caprock has no public price for this model, so the total above is a lower bound. There is no manual price to enter; update Caprock when its pricing table learns the model. Reporting sends only the model id when you submit the issue.
            </div>
          )}
        </div>
      )}
      {showBackground && (
        <div className="border border-border bg-panel-2/40 px-3 py-1.5 text-[11px] rounded-[var(--radius-panel)] text-fg-faint">
          Background usage · <span className="num text-fg-muted">{fmtTokens(background.tokens)} tokens</span> ·{' '}
          {background.models.map((m) => INTERNAL_NAMES[m] ?? m).join(', ')}
        </div>
      )}
    </div>
  )
}
