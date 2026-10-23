/**
 * What Second Brain spends (#/brain, the strip on top; owner-approved mockup
 * 2026-10-22): the reads' tokens of the last 24 hours against the daily
 * limit, as a line and a thin silver bar, and their share of every Claude
 * token Caprock recorded in the same 24 hours. While a catch-up runs, a
 * second line says how far it is. A click opens the last 14 days: tokens
 * per day against the limit, each day stacked by the projects that spent
 * it, and per project the reads, tokens (with a bar against the largest)
 * and memories.
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

/** The re-tag line while no catch-up has one to show, or null:
 *  *Adding keywords to older memories: 40 / 120*. */
export function retagLine(r: BrainAutoStatus['retag']): string | null {
  if (!r || r.total <= 0 || r.done >= r.total) return null
  return `Adding keywords to older memories: ${r.done} / ${r.total}`
}

/** What a row of the per-project table is called. */
export const RETAG_ROW = 'Keywords for older memories'

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

/** How many projects get a colour of their own in the stacks; the rest are
 *  one grey *Other*. Three, because the validator passes three hues on
 *  every pair (the table's swatches are compared across rows, not only
 *  neighbours) and not four. */
export const STACK_SLOTS = 3

/** The colour of a stack slot, 0 the largest; -1 is *Other*. */
export const slotColor = (slot: number) => (slot >= 0 && slot < STACK_SLOTS ? `var(--spend-${slot + 1})` : 'var(--spend-other)')

/** What a project row, a day's part or a stack segment is keyed by: the
 *  re-tag batches are no project and never share the "" of reads without one. */
export const spendKey = (p: { project: string; retag?: boolean }) => (p.retag ? ':retag' : p.project)

/** One part of a day's bar, bottom first. */
export interface StackSegment { key: string; slot: number; tokens: number }

/** The days as stacks: the keys that got a colour, largest first, and per
 *  day its segments in slot order with *Other* (slot -1, key '') on top. */
export interface SpendStacks { top: string[]; days: StackSegment[][] }

/**
 * Groups the days' parts into stacks: the STACK_SLOTS projects with the most
 * tokens over the whole window each keep their own segment, in the same
 * order every day (the largest at the bottom), and everything else — the
 * re-tag batches always among it — sums into one *Other*. A tie goes by
 * name, so the colours do not swap between reads. Null when a day has no
 * parts listed (an older daemon), and the chart draws plain bars.
 */
export function spendStacks(days: Spend['days']): SpendStacks | null {
  if (days.length === 0 || days.some((d) => !Array.isArray(d.projects))) return null
  const sums = new Map<string, number>()
  for (const d of days) {
    for (const p of d.projects!) {
      if (p.retag || !(p.tokens > 0)) continue
      sums.set(p.project, (sums.get(p.project) ?? 0) + p.tokens)
    }
  }
  const top = [...sums.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, STACK_SLOTS).map(([k]) => k)
  return {
    top,
    days: days.map((d) => {
      const parts = top.map((key, slot): StackSegment => ({ key, slot, tokens: 0 }))
      let other = 0
      for (const p of d.projects!) {
        if (!(p.tokens > 0)) continue
        const slot = p.retag ? -1 : top.indexOf(p.project)
        if (slot < 0) other += p.tokens
        else parts[slot]!.tokens += p.tokens
      }
      const segs = parts.filter((s) => s.tokens > 0)
      if (other > 0) segs.push({ key: '', slot: -1, tokens: other })
      return segs
    }),
  }
}

/** Each row's tokens over the largest row's, 0–1: the leader is the full
 *  bar. A row that spent anything is drawn at least as a sliver (RowBar). */
export function rowShares(rows: Pick<Spend['projects'][number], 'tokens'>[]): number[] {
  const max = Math.max(0, ...rows.map((r) => r.tokens))
  return rows.map((r) => (max > 0 && r.tokens > 0 ? r.tokens / max : 0))
}

/** What a segment is called. */
const segmentName = (s: StackSegment) => (s.slot < 0 ? 'Other' : s.key || 'No project')

/** The thin bar after a row's tokens: its share of the largest row's. */
function RowBar({ share }: { share: number }) {
  return (
    <div className="h-[4px] w-full overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--color-fg-muted)_12%,transparent)]" aria-hidden data-brain-spend-rowbar={share.toFixed(3)}>
      {share > 0 && <div className="h-full rounded-full bg-[color-mix(in_srgb,var(--color-fg-muted)_55%,transparent)]" style={{ width: `max(3px, ${(share * 100).toFixed(1)}%)` }} />}
    </div>
  )
}

/** The square before a project's name: the colour its tokens wear in the bars. */
function Swatch({ slot }: { slot: number }) {
  return <span aria-hidden className="mr-1.5 inline-block h-[8px] w-[8px] shrink-0 rounded-[2px] align-[0.5px]" style={{ background: slotColor(slot) }} data-brain-spend-swatch={slot} />
}

/** Tokens per day, today the last, with the daily limit as a dashed line;
 *  each day a stack of the projects that spent it when the daemon lists
 *  them, else one silver bar. */
function DayChart({ days, limit, stacks }: { days: Spend['days']; limit: number; stacks: SpendStacks | null }) {
  const max = Math.max(limit, ...days.map((d) => d.tokens), 1) * 1.08
  const limitAt = limit > 0 ? (limit / max) * 100 : null
  // What the tooltip says: a segment under the pointer, or the day under
  // the focus with each of its parts.
  const [tip, setTip] = useState<{ i: number; seg?: StackSegment } | null>(null)
  const over = (d: Spend['days'][number]) => limit > 0 && d.tokens > limit
  const dayLabel = (d: Spend['days'][number], i: number) =>
    `${dayName(d.day)}${i === days.length - 1 ? ' (today, so far)' : ''}: ${fmtTokens(d.tokens)} tokens, ${d.reads} ${d.reads === 1 ? 'read' : 'reads'}${over(d) ? ', over the daily limit' : ''}`
  const tipText = (() => {
    if (!tip) return null
    const d = days[tip.i]
    if (!d) return null
    if (tip.seg) return [`${segmentName(tip.seg)} · ${dayName(d.day)} · ${tokensShort(tip.seg.tokens)} tokens`]
    const lines = [dayLabel(d, tip.i)]
    for (const s of [...(stacks?.days[tip.i] ?? [])].reverse()) lines.push(`${segmentName(s)} · ${tokensShort(s.tokens)}`)
    return lines
  })()
  return (
    <figure className="grid gap-1" data-brain-spend-chart={stacks ? 'stacked' : 'plain'}>
      <div className="relative h-[96px]" role="group" onMouseLeave={() => setTip(null)}
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
            const segs = stacks?.days[i]
            return (
              <div key={d.day} className="relative flex h-full min-w-0 flex-1 items-end rounded-[3px] focus:outline-none focus-visible:ring-1 focus-visible:ring-fg-muted"
                data-brain-spend-day={d.day} data-brain-spend-over={over(d) ? '' : undefined}
                tabIndex={0} aria-label={dayLabel(d, i)} title={stacks ? undefined : dayLabel(d, i)}
                onFocus={() => setTip({ i })} onBlur={() => setTip(null)}>
                {segs ? (
                  <div className={`relative flex w-full flex-col-reverse gap-[2px] ${today ? 'opacity-70' : ''}`} style={{ height: `${h}%` }}>
                    {segs.map((s, j) => (
                      <div key={s.slot} className={`min-h-[1px] w-full ${j === segs.length - 1 ? 'rounded-t-[2px]' : ''}`}
                        style={{ flex: `${s.tokens} 1 0px`, background: slotColor(s.slot) }}
                        data-brain-spend-seg={s.slot < 0 ? 'other' : s.key}
                        onMouseEnter={() => setTip({ i, seg: s })} />
                    ))}
                    {over(d) && (
                      // Over the limit: a warn dot over the stack, the stack
                      // keeping its colours (and the tooltip saying so).
                      <span aria-hidden className="absolute left-1/2 top-[-9px] h-[6px] w-[6px] -translate-x-1/2 rounded-full bg-warn" data-brain-spend-overmark />
                    )}
                  </div>
                ) : (
                  <div className={`w-full rounded-t-[2px] ${over(d) ? 'bg-warn' : 'bg-[var(--wisp-core)]'} ${today ? 'opacity-60' : 'opacity-90'}`}
                    style={{ height: `${h}%` }} />
                )}
              </div>
            )
          })}
        </div>
        {tipText && tip && (
          <div role="tooltip" data-brain-spend-tip
            className="pointer-events-none absolute bottom-full z-10 mb-1 max-w-[240px] whitespace-nowrap rounded-[6px] border border-border bg-panel-2 px-2 py-1 text-[11.5px] leading-snug text-fg shadow-panel"
            style={tip.i < days.length / 2 ? { left: `${(tip.i / days.length) * 100}%` } : { right: `${((days.length - 1 - tip.i) / days.length) * 100}%` }}>
            {tipText.map((l, k) => <div key={k} className={k > 0 ? 'text-fg-muted' : ''}>{l}</div>)}
          </div>
        )}
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
  const stacks = spendStacks(spend.days)
  const shares = rowShares(spend.projects)
  return (
    <div id={id} className="grid min-w-0 gap-3 rounded-[10px] border border-border bg-panel px-3.5 py-3" data-brain-spend-detail>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h3 className="text-[11px] font-medium uppercase tracking-[0.06em] text-fg-muted">Last {spend.days.length} days</h3>
        <span className="text-[12.5px] text-fg"><span className="num">{fmtTokens(total)}</span> tokens</span>
        <span className="text-[12px] text-fg-muted" title={SUBSCRIPTION_NOTE} data-brain-spend-cost><span className="num">{fmtUSD(cost)}</span> at API list price</span>
      </div>
      <DayChart days={spend.days} limit={spend.daily_tokens} stacks={stacks} />
      {spend.projects.length > 0 ? (
        <table className="w-full table-fixed text-[12.5px]" data-brain-spend-projects>
          <thead>
            <tr className="text-[11px] uppercase tracking-[0.06em] text-fg-muted">
              <th scope="col" className="pb-1 text-left font-medium">Project</th>
              <th scope="col" className="w-[52px] pb-1 text-right font-medium">Reads</th>
              <th scope="col" className="w-[64px] pb-1 text-right font-medium">Tokens</th>
              <th scope="col" className="w-[40px] pb-1 sm:w-[22%]"><span className="sr-only">Share of the largest</span></th>
              <th scope="col" className="w-[78px] pb-1 text-right font-medium">Memories</th>
            </tr>
          </thead>
          <tbody>
            {spend.projects.map((p, i) => (
              <tr key={p.retag ? ':retag' : p.project || '-'} className="border-t border-border" data-brain-spend-project={p.retag ? undefined : p.project} data-brain-spend-retag={p.retag ? '' : undefined}>
                <td className={`truncate py-1 pr-2 ${p.retag ? 'text-fg-muted' : 'text-fg'}`}
                  title={p.retag ? 'Batches that gave memories kept before keywords existed their keywords; Memories is how many got them' : p.project}>
                  {stacks && <Swatch slot={stacks.top.indexOf(spendKey(p))} />}
                  {p.retag ? RETAG_ROW : p.project || 'No project'}
                </td>
                <td className="num py-1 text-right text-fg-muted">{p.reads}</td>
                <td className="num py-1 text-right text-fg" title={`${fmtTokens(p.tokens)} tokens · ${fmtUSD(p.cost_usd)} at API list price`}>{tokensShort(p.tokens)}</td>
                <td className="py-1 pl-2"><RowBar share={shares[i]!} /></td>
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
  const catchUp = catchUpLine(auto.catch_up) ?? retagLine(auto.retag)
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
