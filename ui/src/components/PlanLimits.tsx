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
import { Panel, Stat, usePanelOpen } from '@/components/ui'
import { ShareWith } from '@/components/PanelShare'
import { mdTable } from '@/lib/panelShare'
import { Ring } from '@/components/Donut'
import { PlanOptions, usePlan } from '@/components/PlanPicker'
import { AgentCharacter, type Character } from '@/components/Characters'
import { countdown, resetClock } from '@/lib/limitclock'
import { Banner, BannerButton } from '@/components/Banner'

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

export function LimitGauge({ label, w, now, source }: { label: string; w: RateWindow | undefined; now: number; source: string }) {
  // A window the agent has not reported keeps its place, so both cards stay
  // the same shape (owner, 2026-10-11: "asymmetric"); it says so instead.
  if (!w) {
    return (
      <div className="flex min-w-0 items-center gap-3" data-limit-empty>
        <Ring value={0} size={76} width={8} dim ariaLabel={`${source} ${label}: not reported`}>
          <span className="num text-[20px] font-semibold text-fg-faint">—</span>
        </Ring>
        <div className="min-w-0 leading-snug">
          <div className="text-[15px] font-semibold text-fg-muted">{label}</div>
          <div className="text-[13px] text-fg-faint">not reported by {source}</div>
        </div>
      </div>
    )
  }
  const r = readWindow(w, now)
  const resetMs = w.resets_at * 1000
  const clock = r.resetsAt ? resetClock(resetMs, now) : null
  const color = gaugeColor(r.pct)
  const fc = r.stale ? null : forecastLine(w, now)
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Ring value={r.pct / 100} size={76} width={8} color={color} dim={r.stale}
        marker={fc ? { to: 1, color: fc.urgent ? 'var(--color-danger)' : 'var(--color-warn)' } : undefined}
        ariaLabel={`${source} ${label}: ${r.pct}% used${r.stale ? ', reading is stale' : clock ? `, resets ${clock}` : ''}${fc ? `. ${fc.text}` : ''}`}>
        <span className={`num text-[21px] font-semibold ${r.stale ? 'text-fg-faint' : ''}`} style={r.stale ? undefined : { color }}>{r.pct}%</span>
      </Ring>
      <div className="min-w-0 leading-snug">
        <div className="text-[15px] font-semibold text-fg">{label}</div>
        {r.stale ? (
          <div className="text-[13px] text-fg-faint" title={`${source} has not refreshed this window recently, so the reset time and the percentage are old`}>
            not reported lately
          </div>
        ) : clock ? (
          <>
            <div className="text-[13px] text-fg-muted">resets <span className="num text-fg">{clock}</span></div>
            <div className="text-[13px] text-fg-faint">in {countdown(resetMs - now)}</div>
          </>
        ) : null}
        {fc && <div className={`text-[12.5px] ${fc.urgent ? 'text-danger' : 'text-warn'}`}>{fc.text}</div>}
      </div>
    </div>
  )
}

/** One agent's windows: its character and name, then 5 hours and the week side by side. */
function LimitCard({ who, name, note, l, now, source }: { who: Character; name: string; note?: ReactNode; l: RateLimits | undefined; now: number; source: string }) {
  return (
    <section className="min-w-0 rounded-xl border border-border bg-panel-2/40 p-3" data-limit-card={source}>
      <div className="mb-3 flex items-center gap-2.5">
        <AgentCharacter who={who} size={30} />
        <span className="text-[15px] font-semibold text-fg">{name}</span>
        {note && <span className="ml-auto text-[12px] text-fg-faint">{note}</span>}
      </div>
      <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        <LimitGauge label="5 hours" w={l?.five_hour} now={now} source={source} />
        <LimitGauge label="Week" w={l?.seven_day} now={now} source={source} />
      </div>
    </section>
  )
}

/**
 * Asks for the plan until it is set, and says why: Caprock cannot detect it,
 * and the plan is what makes spend at API prices mean something (owner,
 * 2026-10-11: "always ask with a banner to set your plan and explain why").
 */
function SetPlanBanner({ onSave }: { onSave: (patch: Partial<Settings>) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mx-3 mb-3" role="note" data-set-plan data-share-skip>
      <Banner
        id="plan"
        art="plan"
        title="Which plan are you on?"
        line="Caprock can't detect it. With it, Cost compares what you used at API prices with what the plan costs you."
        actions={<BannerButton onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? 'Close' : 'Set my plan'}</BannerButton>}
      >
        {open && <div className="mt-2 max-w-[320px] rounded-md border border-border bg-panel p-2"><PlanOptions onSave={(p) => { onSave(p); setOpen(false) }} /></div>}
      </Banner>
    </div>
  )
}

/** What the one-line explainer leaves out. */
function EXPLAIN(codex: boolean): string {
  return 'Anthropic caps how much a Pro or Max plan can use in each rolling 5-hour window and each week. ' +
    "Caprock reads them from Claude Code's status line" + (codex ? "; Codex's come from its own session files, as it last wrote them" : '') + '. ' +
    'A forecast appears only when your pace would reach 100% before the reset' + (codex ? '; Codex is never forecast' : '') + '.'
}

/** Every window as a Markdown table: how much is used and when it resets. */
export function limitsText(groups: [string, [string, RateWindow][]][], now: number): string {
  const rows = groups.flatMap(([who, ws]) => ws.map(([label, w]) => {
    const r = readWindow(w, now)
    return [who, label, `${r.pct}%`, r.stale ? 'not current' : r.resetsAt ? `${r.resetsAt} (in ${countdown(w.resets_at * 1000 - now)})` : '–']
  }))
  return `Your plan's limits, per 5 hours and per week.\n\n${mdTable(['Agent', 'Window', 'Used', 'Resets'], rows)}`
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
 * One window in the folded header: its short name, a thin bar, the
 * percentage and when it resets, coloured as the gauge is (calm under 60%,
 * amber to 85%, red above). Narrow, the reset goes first and the name
 * next; the bar and the percentage always stay. The whole reading is on
 * hover and for a screen reader.
 */
function FoldedWindow({ label, name, w, now, source, wide }: { label: string; name: string; w: RateWindow; now: number; source: string; wide: { name: string; reset: string } }) {
  const r = readWindow(w, now)
  const clock = r.resetsAt ? resetClock(w.resets_at * 1000, now) : null
  const color = gaugeColor(r.pct)
  const said = `${source} ${name}: ${r.pct}% used${r.stale ? ', reading is stale' : clock ? `, resets ${clock}` : ''}`
  return (
    <span data-folded-window={`${source} ${name}`} title={said} role="img" aria-label={said}
      className="flex min-w-0 shrink items-center gap-1.5 text-[11.5px] normal-case tracking-normal">
      <span aria-hidden className={`hidden shrink-0 text-fg-muted ${wide.name}`}>{label}</span>
      <span aria-hidden className="relative h-[5px] w-[28px] min-w-[12px] shrink overflow-hidden rounded-full" style={{ background: 'color-mix(in srgb, var(--color-fg) 14%, transparent)' }}>
        <span className="block h-full rounded-full" style={{ width: `${Math.max(4, Math.min(100, r.pct))}%`, background: r.stale ? 'var(--color-fg-faint)' : color }} />
      </span>
      <span aria-hidden className={`num shrink-0 font-medium ${r.stale ? 'text-fg-faint' : ''}`} style={r.stale ? undefined : { color }} data-stale={r.stale || undefined}>{r.pct}%</span>
      {clock && <span aria-hidden className={`num hidden shrink-0 text-fg-faint ${wide.reset}`}>{clock}</span>}
    </span>
  )
}

/**
 * The folded panel's header row: every window the panel shows, one small bar
 * each, so folding it leaves a glance rather than an empty row (owner,
 * 2026-10-29). The breakpoints are the slot's own width (Panel `folded`, a
 * size container), set per how many windows share it: names and resets
 * appear only where they fit, and the line never wraps.
 */
function FoldedLimits({ claude, cdx, now }: { claude: [string, RateWindow][]; cdx: [string, RateWindow][]; now: number }) {
  const many = claude.length + cdx.length > 2
  // Tailwind sees whole class names only, so both tiers are spelled out.
  const wide = many
    ? { name: '@[32rem]:inline', reset: '@[44rem]:inline', agent: '@[32rem]:inline' }
    : { name: '@[13rem]:inline', reset: '@[21rem]:inline', agent: '' }
  const short = (l: string) => (l === 'Weekly' ? 'Week' : '5h')
  const group = (who: string, source: string, ws: [string, RateWindow][], tag: boolean) => ws.length === 0 ? null : (
    <span className="flex min-w-0 shrink items-center gap-2.5" data-folded-agent={who}>
      {tag && <span aria-hidden className={`hidden shrink-0 text-[11px] normal-case tracking-normal text-fg-faint ${wide.agent}`}>{who}</span>}
      {ws.map(([l, w]) => <FoldedWindow key={l} label={short(l)} name={l === 'Weekly' ? 'Week' : '5 hours'} w={w} now={now} source={source} wide={wide} />)}
    </span>
  )
  return (
    <div className="flex min-w-0 items-center gap-4" data-folded-limits>
      {group('Claude', 'Claude Code', claude, cdx.length > 0)}
      {group('Codex', 'Codex', cdx, true)}
    </div>
  )
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
  const [plan, savePlan] = usePlan()
  const [more, setMore] = useState(false)
  const open = usePanelOpen('plan-limits')
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
      <Panel fold="plan-limits" title="Plan limits" share="Plan limits"
        folded={open ? undefined : <FoldedLimits claude={claude} cdx={cdx} now={now} />}>
        <ShareWith toText={() => limitsText([['Claude', claude], ['Codex', cdx]], now)} />
        <div className={`grid gap-3 px-3 py-3 ${cdx.length > 0 ? 'lg:grid-cols-2' : ''}`}>
          <LimitCard who="lead" name={planName(plan)} l={limits} now={now} source="Claude Code" />
          {cdx.length > 0 && (
            <LimitCard who="codex" name="Codex" l={codex} now={now} source="Codex"
              note={observed ? <>as of {fmtObserved(observed, now)}</> : undefined} />
          )}
        </div>
        {plan && !plan.plan_kind && <SetPlanBanner onSave={savePlan} />}
        {advice && (
          <div className="mx-3 mb-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12.5px] text-fg" role="note">{advice}</div>
        )}
        {/* One line, because the long explainer was the thing the owner
          * skipped; the details are a click (or a hover) away. */}
        <div className="border-t border-border px-3 py-2 text-[11.5px] leading-relaxed text-fg-muted" title={EXPLAIN(cdx.length > 0)}>
          Your plan's limits, per 5 hours and per week — not Caprock's. At 100% the agent pauses until the reset.{' '}
          <button type="button" data-share-skip onClick={() => setMore((v) => !v)} aria-expanded={more} className="text-fg-faint underline-offset-2 hover:text-fg hover:underline">
            {more ? 'less' : 'more'}
          </button>
          {more && <p className="mt-1 text-fg-faint">{EXPLAIN(cdx.length > 0)}</p>}
        </div>
      </Panel>
    </div>
  )
}
