import { useState } from 'react'
import type { BackgroundUsage, ModelShare, Unpriced } from '@/lib/api'
import { fmtTokens, fmtUSD } from '@/lib/format'
import { extTitle } from '@/lib/externalLinks'

const INTERNAL_NAMES: Record<string, string> = {
  'codex-auto-review': 'Codex Auto Review',
}

/** Cursor's names for work it did not attribute to one model. "default" is
 * what Cursor stores for Auto. */
const CURSOR_AUTO = new Set(['default', 'auto'])
/** Cursor's own models with no per-token price on cursor.com/docs/models
 * (read 2026-11-21): composer-1, composer-1.5, code-supernova-*. Composer 2.5
 * has one, so it gets the general reason: a Cursor chat is never priced from
 * the table either way. */
const CURSOR_OWN = /^(composer-1(\.5)?|code-supernova)(-|$)/

/** What one unpriced Cursor name is, in plain words: the short label the
 * note shows and the sentence its hover says. Every one shares the reason the
 * tokens are unpriced — Cursor recorded no cost for the chat, and Caprock does
 * not guess Cursor's bill from list prices (ADR-095) — so none of them is a
 * model Caprock failed to learn. */
export function cursorUnpricedReason(model: string): { label: string; title: string } {
  const why = 'Cursor recorded no cost for these chats, most often because your Cursor plan covers them, and Caprock does not estimate Cursor’s bill from list prices'
  const m = model.trim().toLowerCase()
  if (CURSOR_AUTO.has(m)) {
    return { label: 'Cursor’s Auto', title: `Cursor’s Auto (stored as “${model}”): Cursor does not say which model ran. ${why}.` }
  }
  if (m === '') {
    return { label: 'no model named', title: 'Cursor recorded neither the model nor a cost for these turns.' }
  }
  if (CURSOR_OWN.test(m)) {
    return { label: model, title: `${model}: Cursor’s own model, with no per-token price Cursor publishes. ${why}.` }
  }
  return { label: model, title: `${model}: ${why}.` }
}

/** How a model-mix row's cost reads: priced throughout, unpriced throughout,
 * or partly priced — Cursor records a cost for some chats and not others
 * (ADR-095), so one model can be both. A partly priced row used to read
 * "unpriced" alone and hid the money Cursor did record ($153.13 of
 * claude-4-sonnet on the owner's machine, 2026-11-21). The unpriced part is
 * never estimated; it is named, with its tokens, beside the priced figure.
 * A daemon from before `unpriced_tokens` names the model in `unpriced` only,
 * which reads as unpriced throughout, as it did then. */
export type ModelCostState = 'priced' | 'partly' | 'unpriced'

export function modelCostState(m: ModelShare, u?: Unpriced): ModelCostState {
  const some = (m.unpriced_tokens ?? 0) > 0 || (u?.models ?? []).includes(m.model)
  if (!some) return 'priced'
  return m.cost_usd > 0 && (m.unpriced_tokens ?? 0) > 0 ? 'partly' : 'unpriced'
}

/** Why a model's tokens are unpriced, in one sentence. */
function unpricedWhy(m: ModelShare, u?: Unpriced): string {
  return (u?.cursor ?? []).includes(m.model)
    ? cursorUnpricedReason(m.model).title
    : 'This model is not in the pricing table for these turns, so their cost is unknown.'
}

/** The cost cell's text for a copied table: "$153.13 + unpriced". */
export function modelCostText(m: ModelShare, u?: Unpriced): string {
  const st = modelCostState(m, u)
  const word = unpricedWord(m, u)
  return st === 'unpriced' ? word : st === 'partly' ? `${fmtUSD(m.cost_usd)} + ${word}` : fmtUSD(m.cost_usd)
}

/** What the unpriced part is called. A Cursor chat with no cost is most often
 * one the user's Cursor plan covers (Cursor's usage export marks such rows
 * "Included"), so it reads "in Cursor plan" rather than "unpriced", which
 * looked like a price Caprock failed to learn (owner, 2026-11-21). */
function unpricedWord(m: ModelShare, u?: Unpriced): string {
  return (u?.cursor ?? []).includes(m.model) ? 'in Cursor plan' : 'unpriced'
}

/** The model-mix cost cell (Cost, History): the priced figure, and a quiet
 * "+ unpriced" when part of the model's volume has no cost, its hover naming
 * the tokens and why. The share bar, the order and the totals use the priced
 * part alone, and the hover says so. */
export function ModelCost({ m, u }: { m: ModelShare; u?: Unpriced }) {
  const st = modelCostState(m, u)
  if (st === 'priced') return <>{fmtUSD(m.cost_usd)}</>
  const why = unpricedWhy(m, u)
  const word = unpricedWord(m, u)
  if (st === 'unpriced') return <span className="text-warn" title={why}>{word}</span>
  const title = `${fmtUSD(m.cost_usd)} is the priced part. ${fmtTokens(m.unpriced_tokens ?? 0)} more tokens have no cost. ${why.replace(/\.$/, '')}. The share, the order and the total count the priced part alone.`
  return (
    <span title={title} aria-label={`${fmtUSD(m.cost_usd)} plus a part ${word === 'unpriced' ? 'with no price' : 'in the Cursor plan'}`}>
      {fmtUSD(m.cost_usd)}<span className="ml-1 text-[11px] text-warn">+ {word}</span>
    </span>
  )
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
  // Cursor's names are not missing from the table (ADR-095): they are said
  // apart, with why, and are neither copied nor reported as unknown models.
  const cursorSet = new Set(u?.cursor ?? [])
  const cursorModels = (u?.models ?? []).filter((m) => cursorSet.has(m))
  const unknown = (u?.models ?? []).filter((m) => !cursorSet.has(m))
  const models = unknown.filter(Boolean)
  const modelLabel = models.join(', ') || 'unknown model'
  const showModels = unknown.length > 0

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
            {showModels && <span className="mono text-fg truncate max-w-full" title={modelLabel}>{modelLabel}</span>}
            <div className="ml-auto flex items-center gap-1">
              {showModels && <>
              <button
                className="text-[11px] text-fg-muted hover:text-fg border border-border px-1.5 py-0.5 rounded-sm"
                onClick={() => void copyModels()}
                type="button"
              >
                {copied ? 'copied' : 'copy model'}
              </button>
              <a
                className="text-[11px] text-fg-muted hover:text-fg border border-border px-1.5 py-0.5 rounded-sm no-underline"
                href={unpricedIssueURL(unknown)}
                target="_blank" title={extTitle()}
                rel="noreferrer"
              >
                report
              </a>
              </>}
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
          {cursorModels.length > 0 && (
            <div className="mt-1 text-[11px] text-fg-muted leading-[1.4]">
              <span>In your Cursor plan, no cost recorded: </span>
              {cursorModels.map((m, i) => {
                const r = cursorUnpricedReason(m)
                return (
                  <span key={m || '(none)'}>
                    {i > 0 && ', '}
                    <span className="mono text-fg" title={r.title}>{r.label}</span>
                  </span>
                )
              })}
            </div>
          )}
          {detailsOpen && (
            <div className="mt-1.5 border-t border-warn/20 pt-1.5 text-[11px] text-fg-muted leading-[1.4] grid gap-1">
              {showModels && <span>Caprock has no public price for this model, so the total above is a lower bound. There is no manual price to enter; update Caprock when its pricing table learns the model. Reporting sends only the model id when you submit the issue.</span>}
              {cursorModels.length > 0 && <span>Cursor keeps a cost for some chats and not others. A chat with none is most often one your Cursor plan covers. Caprock counts its tokens and leaves them out of the total rather than guess: list prices over Cursor’s token counts were off by half to double against the chats Cursor did price. Auto (“default”) does not say which model ran, and Cursor publishes no per-token price for its older models such as composer-1 or code-supernova. This is not a missing price in Caprock, and nothing needs reporting.</span>}
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
