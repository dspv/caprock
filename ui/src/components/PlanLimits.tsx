/**
 * How much of the plan's window is left.
 *
 * This lived only on the Cost screen, in the second column of the bottom row,
 * below a thirty-day chart — and a user who wanted it went looking and did not
 * find it. That is a placement problem, not a missing feature: Cost answers
 * "what has this cost me", and a limit answers "can I keep going", which is a
 * question about right now. So it also belongs on Now, beside the burn rate.
 *
 * The two screens share this file rather than each rendering their own rows.
 * The staleness rule below is subtle enough that two copies of it would drift,
 * and the copy that drifts is the one nobody is looking at.
 */
import { useState, type ReactNode } from 'react'
import type { RateLimits, RateWindow, Settings } from '@/lib/api'
import { Panel, Stat } from '@/components/ui'
import { Ring } from '@/components/Donut'
import { usePlan } from '@/components/PlanPicker'
import { countdown, resetClock } from '@/lib/limitclock'

/** A window's percentage, and whether its reset clock can be believed. */
export function readWindow(w: RateWindow, now: number) {
  const pct = Math.round(w.used_percentage)
  // These come from Claude Code's status line and go stale the moment a session
  // stops writing them. A reset already past, or implausibly far ahead, is a
  // stale sample rather than a fact — rendered as a clock, the 5-hour window
  // confidently announced a reset in 2030.
  const resetMs = (w.resets_at ?? 0) * 1000
  const plausible = resetMs > now && resetMs < now + 8 * 24 * 3600 * 1000
  return {
    pct,
    color: pct > 85 ? 'text-danger' : pct >= 60 ? 'text-warn' : 'text-fg',
    resetsAt: plausible
      ? new Date(resetMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : null,
    stale: w.resets_at ? !plausible : false,
  }
}

export function RateLimitRow({ label, w, now, source = 'Claude Code' }: { label: string; w: RateWindow; now: number; source?: string }) {
  const { pct, color, stale, resetsAt: clock } = readWindow(w, now)
  let resetsAt = clock
  // A weekly window resetting "at 14:03" does not say which day. Past a day
  // away the weekday is part of the answer.
  if (resetsAt && w.resets_at * 1000 - now > 24 * 3600 * 1000) {
    resetsAt = new Date(w.resets_at * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
  }
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-fg-muted">{label}</span>
      <span className="flex items-baseline gap-3">
        <span className={`font-mono tabular-nums ${color}`}>{pct}%</span>
        {resetsAt && <span className="text-fg-faint">resets {resetsAt}</span>}
        {stale && <span className="text-fg-faint" title={`${source} has not refreshed this window recently`}>reset time stale</span>}
        {w.forecast && <span className="text-warn">{w.forecast}</span>}
      </span>
    </div>
  )
}

/**
 * The compact form for Now: a cell in the Today row, not a band of its own.
 *
 * It was a full-width panel holding two percentages. On the owner's machine
 * both windows were stale — a 5-hour window claiming a reset in 2030 — so the
 * band spent its width on a sentence explaining that the two figures beside it
 * meant nothing, three rows above the money. "It looks strange and it is not
 * part of anything," which is what a lone panel around a reference figure
 * reads as.
 *
 * Now it sits in the Today grid with burn, sessions and cache hit: the same
 * question ("can I keep going") asked at the same size as its neighbours, and
 * when the numbers are stale it says the short version of why.
 */
export function PlanLimitsStat({ limits, now }: { limits: RateLimits | undefined; now: number }) {
  const windows: [string, RateWindow][] = []
  if (limits?.five_hour) windows.push(['5h', limits.five_hour])
  if (limits?.seven_day) windows.push(['7d', limits.seven_day])
  if (windows.length === 0) return null

  const read = windows.map(([label, w]) => ({ label, ...readWindow(w, now) }))
  // A window whose clock cannot be believed is not a small caveat on a
  // percentage — it means the percentage is old too, and 24% from an unknown
  // time ago is not a fact about anything.
  const live = read.filter((r) => !r.stale)
  const allStale = live.length === 0
  // The cell leads with whichever window is closest to its limit, because
  // that is the one that will stop the work.
  const lead = (live.length ? live : read).reduce((a, b) => (b.pct > a.pct ? b : a))
  const other = read.find((r) => r.label !== lead.label)

  return (
    <Stat
      label="Plan limits"
      value={<span className={allStale ? 'text-fg-faint' : lead.color}>{lead.pct}%</span>}
      sub={
        allStale ? (
          <span title="Claude Code writes these to its status line; they stop updating when no session is running">
            last reported a while ago
          </span>
        ) : (
          <span>
            {lead.label} window
            {lead.resetsAt ? ` · resets ${lead.resetsAt}` : ''}
            {other ? ` · ${other.label} ${other.pct}%` : ''}
          </span>
        )
      }
      tone={allStale ? undefined : lead.pct > 85 ? 'danger' : lead.pct >= 60 ? 'warn' : undefined}
      size="compact"
    />
  )
}

/**
 * Codex's windows on the Cost screen, under Codex's name.
 *
 * Codex writes these into its session transcripts rather than to a live feed,
 * so the figure is as of the last thing Codex wrote — which can be hours old
 * when no Codex session is running. The heading says when, so an old
 * percentage reads as old rather than as now. Which windows appear depends on
 * the plan: some ChatGPT plans have no five-hour window, and then there is no
 * row for one rather than an empty one.
 */
export function CodexLimits({ limits, now }: { limits: RateLimits; now: number }) {
  const observed = limits.five_hour?.observed_at ?? limits.seven_day?.observed_at
  return (
    <>
      <div className="flex items-baseline justify-between gap-3 px-3 pt-3 text-[11px] uppercase tracking-wide text-fg-faint">
        <span>Codex</span>
        {observed ? <span className="normal-case tracking-normal">as of {fmtObserved(observed, now)}</span> : null}
      </div>
      <div className="flex flex-col gap-2 px-3 pt-1">
        {limits.five_hour && <RateLimitRow label="5-hour window" w={limits.five_hour} now={now} source="Codex" />}
        {limits.seven_day && <RateLimitRow label="7-day window" w={limits.seven_day} now={now} source="Codex" />}
      </div>
    </>
  )
}

/** A time today, or a date and time otherwise. */
function fmtObserved(ms: number, now: number): string {
  const d = new Date(ms)
  if (d.toDateString() === new Date(now).toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export { countdown, resetClock }

/**
 * What the Claude heading calls the plan: the one the user picked ("Claude
 * Max 5×"), or just "Claude Code" when they have not said. Never guessed from
 * the percentages — the status line does not say which plan it is.
 */
export function planName(plan: Settings | undefined): string {
  const label = plan?.plan_kind === 'flat' ? plan.plan_label : ''
  return /^(pro|max)/i.test(label) ? `Claude ${label}` : 'Claude Code'
}

function gaugeColor(pct: number): string {
  return pct > 85 ? 'var(--color-danger)' : pct >= 60 ? 'var(--color-warn)' : 'var(--color-ok)'
}

/**
 * One window as a gauge and a sentence. The owner opened this from a "95%"
 * alert and could not tell what any of it meant, so every window now says it
 * in words: how much is used, when it resets and how long that is, and what
 * happens at 100%. The ring stays for the glance; the sentence is the answer.
 *
 * A reading whose reset clock cannot be believed is drawn grey and says so,
 * rather than counting down to a time that is not real.
 *
 * The ring reads at a glance: the filled arc is what is used, coloured by
 * level (calm under 60%, amber to 85%, red above), and the rest is an empty
 * neutral track. It once drew the forecast as a red dashed arc over the whole
 * remainder, so a window at 9% looked mostly red; the owner could not read it.
 * The forecast is the daemon's, never computed here, and exists only when the
 * measured pace would reach 100% before the reset. It is a hairline on the
 * outer edge plus one plain sentence — when 100% arrives and how long before
 * the reset that is — amber, red only when it is under half an hour away.
 * Codex is never forecast.
 */
export function forecastLine(w: RateWindow, now: number): { text: string; urgent: boolean } | null {
  if (!w.forecast) return null
  if (!w.limit_at || w.limit_at <= now) return { text: `At this pace: ${w.forecast.replace(/^~/, 'about ')}.`, urgent: false }
  const resetMs = w.resets_at * 1000
  const early = resetMs - w.limit_at
  const urgent = w.limit_at - now < 30 * 60_000
  return {
    text: `At this pace you'll hit 100% around ${resetClock(w.limit_at, now)}${early > 60_000 ? ` — about ${countdown(early)} before it resets` : ''}.`,
    urgent,
  }
}

export function LimitGauge({ label, w, now, source }: { label: string; w: RateWindow; now: number; source: string }) {
  const r = readWindow(w, now)
  const resetMs = w.resets_at * 1000
  const clock = r.resetsAt ? resetClock(resetMs, now) : null
  const color = gaugeColor(r.pct)
  const fc = r.stale ? null : forecastLine(w, now)
  return (
    <div className="flex items-center gap-3 min-w-0">
      <Ring value={r.pct / 100} size={92} width={9} color={color} dim={r.stale}
        marker={fc ? { to: 1, color: fc.urgent ? 'var(--color-danger)' : 'var(--color-warn)' } : undefined}
        ariaLabel={`${source} ${label}: ${r.pct}% used${r.stale ? ', reading is stale' : clock ? `, resets ${clock}` : ''}${fc ? `. ${fc.text}` : ''}`}>
        <span className={`num text-[22px] font-semibold ${r.stale ? 'text-fg-faint' : ''}`} style={r.stale ? undefined : { color }}>{r.pct}%</span>
        <span className="text-[9px] uppercase tracking-[0.1em] text-fg-faint mt-1">used</span>
      </Ring>
      <div className="min-w-0 text-[12.5px] leading-snug">
        <div className="font-medium text-fg">{label}: {r.pct}% used</div>
        {r.stale ? (
          <div className="text-fg-faint" title={`${source} has not refreshed this window recently, so the reset time and the percentage are old`}>
            Not a live reading — {source} has not reported it lately.
          </div>
        ) : clock ? (
          <>
            <div className="text-fg-muted">Resets <span className="num text-fg">{clock}</span> — in {countdown(resetMs - now)}.</div>
            <div className="text-fg-faint">At 100%, {source} pauses until then.</div>
          </>
        ) : null}
        {fc && <div className={fc.urgent ? 'text-danger' : 'text-warn'}>{fc.text}</div>}
      </div>
    </div>
  )
}

/** What the one-line explainer leaves out. */
function EXPLAIN(codex: boolean): string {
  return 'Anthropic caps how much a Pro or Max plan can use in each rolling 5-hour window and each week. ' +
    "Caprock reads them from Claude Code's status line" + (codex ? "; Codex's come from its own session files, as it last wrote them" : '') + '. ' +
    'A forecast appears only when your pace would reach 100% before the reset' + (codex ? '; Codex is never forecast' : '') + '.'
}

/** The live window closest to its limit, with what the gauge reads for it. */
function nearest(l: RateLimits | undefined, now: number) {
  let best: { pct: number; resetMs: number } | undefined
  for (const w of [l?.five_hour, l?.seven_day]) {
    if (!w) continue
    const r = readWindow(w, now)
    if (r.stale) continue
    if (!best || r.pct > best.pct) best = { pct: r.pct, resetMs: w.resets_at * 1000 }
  }
  return best
}

/**
 * PLAN LIMITS, on Now under Today and on Cost: every window, grouped by agent,
 * each as a ring and a plain sentence, then one line on what these limits
 * are and — when one is nearly spent — what to do about it.
 *
 * The Claude desktop app's own reading (`/v1/status.desktop`) is never shown
 * here: it is sampled only while the app runs and is often hours stale, and a
 * stale 10% beside a live 97% is exactly the confusion this panel exists to
 * end. It stays on the Status screen, labelled as last seen.
 */
export function PlanLimitsPanel({ limits, codex, now, id, empty, className = '' }: {
  limits: RateLimits | undefined
  codex: RateLimits | undefined
  now: number
  /** An anchor, so the plan-limit alert can land on this panel. */
  id?: string
  /** Shown instead of nothing when no window is known (the Cost screen says how to get them). */
  empty?: ReactNode
  /** For the wrapper: Cost spans it across its grid. */
  className?: string
}) {
  const [plan] = usePlan()
  const [more, setMore] = useState(false)
  const claude: [string, RateWindow][] = []
  if (limits?.five_hour) claude.push(['5-hour window', limits.five_hour])
  if (limits?.seven_day) claude.push(['Weekly', limits.seven_day])
  const cdx: [string, RateWindow][] = []
  if (codex?.five_hour) cdx.push(['5-hour window', codex.five_hour])
  if (codex?.seven_day) cdx.push(['Weekly', codex.seven_day])
  if (claude.length === 0 && cdx.length === 0) {
    return empty ? <div id={id} className={`scroll-mt-16 ${className}`}><Panel title="Plan limits">{empty}</Panel></div> : null
  }
  const observed = codex?.five_hour?.observed_at ?? codex?.seven_day?.observed_at
  const near = nearest(limits, now)
  const cdxNear = nearest(codex, now)
  const advice = near && near.pct >= 85
    ? (
      <>
        <b className="font-semibold">Claude is near its limit.</b> Wait for the reset at <span className="num">{resetClock(near.resetMs, now)}</span> (in {countdown(near.resetMs - now)})
        {cdxNear && cdxNear.pct < 85 ? <>, or switch to Codex — its {codex?.five_hour ? 'tightest window' : 'weekly window'} is at <span className="num">{cdxNear.pct}%</span>.</> : '.'}
      </>
    )
    : cdxNear && cdxNear.pct >= 85
      ? <><b className="font-semibold">Codex is near its limit.</b> Its window resets <span className="num">{resetClock(cdxNear.resetMs, now)}</span> (in {countdown(cdxNear.resetMs - now)}){near && near.pct < 85 ? <>; Claude is at <span className="num">{near.pct}%</span>.</> : '.'}</>
      : null
  return (
    <div id={id} className={`scroll-mt-16 ${className}`}>
      <Panel title="Plan limits">
        <div className="grid gap-x-8 gap-y-4 px-3 py-3 md:grid-cols-2">
          {claude.length > 0 && (
            <section className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.12em] text-fg-faint mb-2">{planName(plan)}</div>
              <div className="flex flex-wrap gap-x-8 gap-y-3">
                {claude.map(([l, w]) => <LimitGauge key={l} label={l} w={w} now={now} source="Claude Code" />)}
              </div>
            </section>
          )}
          {cdx.length > 0 && (
            <section className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.12em] text-fg-faint mb-2 flex gap-2">
                <span>Codex</span>
                {observed ? <span className="normal-case tracking-normal">as of {fmtObserved(observed, now)}</span> : null}
              </div>
              <div className="flex flex-wrap gap-x-8 gap-y-3">
                {cdx.map(([l, w]) => <LimitGauge key={l} label={l} w={w} now={now} source="Codex" />)}
              </div>
            </section>
          )}
        </div>
        {advice && (
          <div className="mx-3 mb-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12.5px] text-fg" role="note">{advice}</div>
        )}
        {/* One line, because the long explainer was the thing the owner
          * skipped; the details are a click (or a hover) away. */}
        <div className="border-t border-border px-3 py-2 text-[11.5px] leading-relaxed text-fg-muted" title={EXPLAIN(cdx.length > 0)}>
          Anthropic's plan limits, per 5-hour window and per week — not Caprock's.{' '}
          <button type="button" onClick={() => setMore((v) => !v)} aria-expanded={more} className="text-fg-faint underline-offset-2 hover:text-fg hover:underline">
            {more ? 'less' : 'more'}
          </button>
          {more && <p className="mt-1 text-fg-faint">{EXPLAIN(cdx.length > 0)}</p>}
        </div>
      </Panel>
    </div>
  )
}
