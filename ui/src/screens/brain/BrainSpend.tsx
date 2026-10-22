/**
 * What Second Brain spends (#/brain, the strip on top; owner-approved mockup
 * 2026-10-22): the reads' tokens of the last 24 hours against the daily
 * limit, as a line and a thin silver bar, and their share of every Claude
 * token Caprock recorded in the same 24 hours. While a catch-up runs, a
 * second line says how far it is. A click opens the last 14 days: tokens
 * per day against the limit, and per project the reads, tokens and memories.
 *
 * Every figure is a count from GET /v1/brain/status and GET
 * /v1/brain/spend (03-contracts.md § Second Brain). The one estimate, the
 * catch-up's days left, says *about*. Dollars follow the rest of the app:
 * what claude reported, labelled API list price, with the note that on a
 * subscription the tokens come out of the plan's limits instead.
 */
import { useEffect, useId, useState } from 'react'
import { api, type BrainAutoStatus, type BrainCatchUp, type BrainSpend as Spend } from '@/lib/api'
import { tokensShort } from '@/lib/brain'
import { fmtTokens, fmtUSD } from '@/lib/format'
import { everyWhileVisible } from '@/lib/visible'
import { dayName } from '@/components/BarChart'

/** The days the detail shows. */
export const SPEND_DAYS = 14

const SUBSCRIPTION_NOTE = 'What Claude Code reported the reads cost, at API list price; on a subscription the tokens come out of your plan’s limits instead'

/**
 * The Brain's share of all Claude tokens in the last 24 hours, as the chip
 * says it, or null when there is nothing to compare with (no session tokens
 * recorded, or the figures are not in yet).
 */
export function spendShare(s: Pick<Spend, 'spent_24h' | 'claude_tokens_24h'> | null | undefined): string | null {
  if (!s || !(s.claude_tokens_24h > 0)) return null
  const all = s.claude_tokens_24h + Math.max(0, s.spent_24h)
  const pct = (Math.max(0, s.spent_24h) / all) * 100
  if (pct > 0 && pct < 1) return '<1%'
  return `${Math.round(pct)}%`
}

/** The catch-up line, or null without one: *Catching up on skipped text: 12 / 40 reads, about 3 days left*. */
export function catchUpLine(c: BrainCatchUp | null | undefined): string | null {
  if (!c || c.total <= 0 || c.done >= c.total) return null
  const what = c.kind === 'skipped' ? 'Catching up on skipped text' : c.kind === 'backfill' ? 'Catching up on earlier sessions' : 'Catching up'
  const left = c.days_left ? `, about ${c.days_left} ${c.days_left === 1 ? 'day' : 'days'} left` : ''
  return `${what}: ${c.done} / ${c.total}${c.truncated ? '+' : ''} reads${left}`
}

/** Tokens against the limit, a thin bar; warm once the limit is reached. */
function LimitBar({ spent, limit }: { spent: number; limit: number }) {
  const share = limit > 0 ? Math.max(0, Math.min(1, spent / limit)) : 0
  const pct = Math.round(share * 100)
  return (
    <div role="progressbar" aria-label="Tokens used of the daily limit" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
      className="h-[3px] overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--color-fg-muted)_16%,transparent)]" data-brain-spend-bar>
      <div className={`h-full rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none ${share >= 1 ? 'bg-warn' : 'bg-[var(--wisp-core)]'}`}
        style={{ width: `${pct}%` }} />
    </div>
  )
}

/** Tokens per day, today the last, with the daily limit as a dashed line. */
function DayChart({ days, limit }: { days: Spend['days']; limit: number }) {
  const max = Math.max(limit, ...days.map((d) => d.tokens), 1) * 1.08
  const limitAt = limit > 0 ? (limit / max) * 100 : null
  return (
    <figure className="grid gap-1" data-brain-spend-chart>
      <div className="relative h-[96px]" role="img"
        aria-label={`Second Brain tokens per day, last ${days.length} days, against the daily limit of ${tokensShort(limit)}`}>
        {limitAt !== null && (
          <div className="pointer-events-none absolute inset-x-0 border-t border-dashed border-fg-muted/60" style={{ bottom: `${limitAt}%` }} data-brain-spend-limit>
            <span className="absolute right-0 -translate-y-full pb-0.5 text-[10.5px] leading-none text-fg-muted">limit {tokensShort(limit)}</span>
          </div>
        )}
        <div className="absolute inset-0 flex items-end gap-[3px]">
          {days.map((d, i) => {
            const h = d.tokens > 0 ? Math.max(2, (d.tokens / max) * 100) : 0
            const today = i === days.length - 1
            return (
              <div key={d.day} className="flex h-full min-w-0 flex-1 items-end" data-brain-spend-day={d.day}
                title={`${dayName(d.day)}${today ? ' (today, so far)' : ''}: ${fmtTokens(d.tokens)} tokens, ${d.reads} ${d.reads === 1 ? 'read' : 'reads'}`}>
                <div className={`w-full rounded-t-[2px] ${d.tokens > limit && limit > 0 ? 'bg-warn' : 'bg-[var(--wisp-core)]'} ${today ? 'opacity-60' : 'opacity-90'}`}
                  style={{ height: `${h}%` }} />
              </div>
            )
          })}
        </div>
      </div>
      <div className="flex gap-[3px] text-[10px] leading-none text-fg-muted" aria-hidden>
        {days.map((d, i) => (
          <span key={d.day} className="min-w-0 flex-1 text-center">{i === days.length - 1 ? 'now' : Number(d.day.slice(8))}</span>
        ))}
      </div>
    </figure>
  )
}

function Detail({ spend, id }: { spend: Spend | null; id: string }) {
  if (!spend) {
    return <div id={id} className="h-[120px] animate-pulse rounded-[10px] border border-border bg-panel" data-brain-spend-detail="loading" />
  }
  const total = spend.days.reduce((n, d) => n + d.tokens, 0)
  const cost = spend.days.reduce((n, d) => n + d.cost_usd, 0)
  return (
    <div id={id} className="grid min-w-0 gap-3 rounded-[10px] border border-border bg-panel px-3.5 py-3" data-brain-spend-detail>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h3 className="text-[11px] font-medium uppercase tracking-[0.06em] text-fg-muted">Last {spend.days.length} days</h3>
        <span className="text-[12.5px] text-fg"><span className="num">{fmtTokens(total)}</span> tokens</span>
        <span className="text-[12px] text-fg-muted" title={SUBSCRIPTION_NOTE} data-brain-spend-cost><span className="num">{fmtUSD(cost)}</span> at API list price</span>
      </div>
      <DayChart days={spend.days} limit={spend.daily_tokens} />
      {spend.projects.length > 0 ? (
        <table className="w-full table-fixed text-[12.5px]" data-brain-spend-projects>
          <thead>
            <tr className="text-[11px] uppercase tracking-[0.06em] text-fg-muted">
              <th scope="col" className="pb-1 text-left font-medium">Project</th>
              <th scope="col" className="w-[52px] pb-1 text-right font-medium">Reads</th>
              <th scope="col" className="w-[64px] pb-1 text-right font-medium">Tokens</th>
              <th scope="col" className="w-[78px] pb-1 text-right font-medium">Memories</th>
            </tr>
          </thead>
          <tbody>
            {spend.projects.map((p) => (
              <tr key={p.project || '-'} className="border-t border-border" data-brain-spend-project={p.project}>
                <td className="truncate py-1 pr-2 text-fg" title={p.project}>{p.project || 'No project'}</td>
                <td className="num py-1 text-right text-fg-muted">{p.reads}</td>
                <td className="num py-1 text-right text-fg" title={`${fmtTokens(p.tokens)} tokens · ${fmtUSD(p.cost_usd)} at API list price`}>{tokensShort(p.tokens)}</td>
                <td className="num py-1 text-right text-fg-muted">{p.memories}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-[12.5px] text-fg-muted">Nothing read in these days.</p>
      )}
      <p className="text-[11.5px] leading-snug text-fg-muted">On a Claude subscription these tokens come out of your plan’s limits; the dollars are what Claude Code reported, at API list price.</p>
    </div>
  )
}

export function BrainSpend({ auto }: { auto: BrainAutoStatus }) {
  const [open, setOpen] = useState(false)
  const [spend, setSpend] = useState<Spend | null>(null)
  const detailId = useId()
  // Read again when the reads have spent something new, and every minute
  // for the sessions' side of the share.
  useEffect(() => {
    let live = true
    const load = () => { api.brainSpend(SPEND_DAYS).then((s) => { if (live) setSpend(s) }, () => {}) }
    load()
    const stop = everyWhileVisible(load, 60_000)
    return () => { live = false; stop() }
  }, [auto.spent])
  const share = spendShare(spend)
  const catchUp = catchUpLine(auto.catch_up)
  const over = auto.daily_tokens > 0 && auto.spent >= auto.daily_tokens
  return (
    <section className="grid min-w-0 gap-2" aria-label="Second Brain tokens" data-brain-spend>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls={detailId} data-brain-spend-toggle
        className="grid min-w-0 gap-1.5 rounded-[10px] border border-border bg-panel px-3 py-2 text-left hover:border-border-strong">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13px] text-fg" data-brain-spend-line title="In the last 24 hours, against the daily limit">
            Today <span className={`num font-medium ${over ? 'text-warn' : ''}`}>{tokensShort(auto.spent)}</span> <span className="text-fg-muted">of <span className="num">{tokensShort(auto.daily_tokens)}</span> tokens</span>
          </span>
          {share && (
            <span className="rounded-full border border-border px-1.5 py-[1px] text-[11.5px] text-fg-muted" data-brain-spend-share
              title="Second Brain's tokens over every Claude token Caprock recorded in the last 24 hours, its own included">
              {share} of all your Claude tokens today
            </span>
          )}
          <svg aria-hidden viewBox="0 0 12 12" className={`ml-auto h-[10px] w-[10px] shrink-0 text-fg-muted transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
            fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M3 4.5 6 7.5 9 4.5" /></svg>
        </span>
        <LimitBar spent={auto.spent} limit={auto.daily_tokens} />
        {catchUp && <span className="text-[12px] text-fg-muted" data-brain-spend-catchup>{catchUp}</span>}
      </button>
      {open && <Detail spend={spend} id={detailId} />}
    </section>
  )
}
