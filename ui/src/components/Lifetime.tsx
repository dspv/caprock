/**
 * The lifetime line: everything Caprock has ever seen, in one row.
 *
 * These are the figures people quote — a hundred and twenty-nine sessions,
 * fifty-eight days, ten thousand dollars of usage — and they were behind a tab
 * called "History", which reads as a log you would scroll rather than a total
 * you would repeat. Someone who opens the dashboard daily could use it for
 * weeks without seeing the one number that says what all of this added up to.
 *
 * Not the whole screen copied up here: the tool table and the model mix are
 * genuinely a screen's worth of reading. This is the summary — the total, and
 * the three things that make it mean something (how long, how much of it was
 * working days, how many sessions) — with the rest one click away.
 */
import { useState } from 'react'
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtTool, fmtUSD } from '@/lib/format'
import { costBasis, costBasisLong } from '@/components/CostBasis'
import type { Settings } from '@/lib/api'

export function LifetimeStrip({ plan }: { plan?: Settings }) {
  // Lifetime totals move slowly; a minute is far more often than they change,
  // and this must never compete with the live panels below it for the socket.
  const h = useApi(() => api.history('all'), [], { intervalMs: 60000 })
  // Closed again. Open, it pushed Today and the live pulse below the fold —
  // and those are what the screen is opened for. The fix for "nobody found it"
  // was never to take the top of the screen; it was to make the control look
  // like one, which it now does.
  const [open, setOpen] = useState(false)
  const t = h.data?.totals
  if (!t || t.sessions === 0) return null

  // Sessions per active day, to one decimal — the figure that turns "58 days"
  // into a sense of how the work is shaped. Under 1.0 it reads oddly ("0.7
  // sessions a day"), so it is simply left out there.
  const perDay = t.days > 0 ? t.sessions / t.days : 0

  const tools = (h.data?.tools ?? []).slice(0, 6)
  const models = (h.data?.summary?.models ?? []).slice(0, 5)
  const topCalls = tools[0]?.count ?? 0
  const topCost = models[0]?.cost_usd ?? 0

  return (
    <div className="rounded-[var(--radius-panel)] border border-border bg-panel">
    <div
      className="flex flex-wrap items-baseline gap-x-6 gap-y-1 px-3 py-2.5"
    >
      <span className="text-[10px] uppercase tracking-[0.12em] text-fg-faint">all time</span>

      <span className="inline-flex items-baseline gap-2">
        <span className="num font-semibold tracking-[-0.01em] text-[22px] leading-none text-info">
          {fmtUSD(t.cost_usd)}
        </span>
        <span className="text-[11px] text-fg-faint" title={costBasisLong(plan)}>
          {costBasis(plan)}
        </span>
      </span>

      <Figure value={t.sessions.toLocaleString('en-US')} label="sessions" />
      <Figure value={t.days.toLocaleString('en-US')} label="active days" />
      <Figure value={t.turns.toLocaleString('en-US')} label="turns" />
      {perDay >= 1 && <Figure value={perDay.toFixed(1)} label="sessions a day" />}

      {/* Expands in place rather than sending you to another screen for the
        * two breakdowns people actually ask for. The Lifetime screen keeps the
        * full tables — this is the shape of them, where the total already is. */}
      <span className="ml-auto inline-flex items-baseline gap-4">
        {/* The one place in the product where a paid feature is offered against
          * a number that makes the case for it. Someone reading their own
          * lifetime total is, at that moment, the person most likely to want a
          * limit on it — and it stays a link at the weight of the one beside
          * it, because a dashboard is not a checkout. */}
        <a
          href="https://caprock.dev/premium"
          target="_blank"
          rel="noreferrer"
          className="text-[11px] text-fg-faint hover:text-accent no-underline"
          title="A daily spend cap — Caprock pauses its own sessions when the day passes a limit you set"
        >
          cap this →
        </a>
        <button
          onClick={() => setOpen((v) => !v)}
          className="rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-fg-muted hover:border-border-strong hover:text-fg"
        >
          {open ? 'hide' : 'tools and models ▾'}
        </button>
      </span>
    </div>

    {open && (
      <div className="grid gap-x-8 gap-y-4 border-t border-border px-3 py-3 md:grid-cols-2">
        <Bars
          title="Most-used tools"
          note="by calls"
          rows={tools.map((t) => ({
            key: t.tool,
            label: fmtTool(t.tool),
            value: t.count.toLocaleString('en-US'),
            frac: topCalls > 0 ? t.count / topCalls : 0,
          }))}
        />
        <Bars
          title="Where the money went"
          note="by cost"
          rows={models.map((m) => ({
            key: m.model,
            label: m.model || 'unknown',
            value: fmtUSD(m.cost_usd),
            frac: topCost > 0 ? m.cost_usd / topCost : 0,
          }))}
        />
        <a href="#/history" className="text-[11px] text-fg-faint hover:text-accent no-underline md:col-span-2">
          every tool, model and project →
        </a>
      </div>
    )}
    </div>
  )
}

/** A short ranked list — label, bar, figure — used for both breakdowns. */
function Bars({
  title,
  note,
  rows,
}: {
  title: string
  note: string
  rows: { key: string; label: string; value: string; frac: number }[]
}) {
  if (rows.length === 0) return null
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-[0.12em] text-fg-faint">{title}</span>
        <span className="text-[10px] text-fg-faint">{note}</span>
      </div>
      <div className="grid gap-1">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-2 text-[11px]">
            <span className="mono w-36 shrink-0 truncate text-fg-muted" title={r.label}>
              {r.label}
            </span>
            <span className="h-1.5 flex-1 rounded-full bg-panel-2">
              <span
                className="block h-full rounded-full bg-accent/70"
                style={{ width: `${Math.max(2, Math.round(r.frac * 100))}%` }}
              />
            </span>
            <span className="num w-20 shrink-0 text-right text-fg">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="num text-[13px] text-fg">{value}</span>
      <span className="text-[11px] text-fg-muted">{label}</span>
    </span>
  )
}
