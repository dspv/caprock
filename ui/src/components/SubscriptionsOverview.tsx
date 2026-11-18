/**
 * Every sign-in's plan limits in one place (owner approved the mockup
 * "Overview V1", 2026-11-18): the Plan limits panel on Now and Cost, once an
 * agent has more than one sign-in, lists each one grouped by agent — its
 * name, plan, *default* badge and how old its figures are; the 5-hour and
 * weekly windows as bars of what is LEFT, with the reset; seven days of
 * spend at API price and sessions; how many sessions Caprock started run on
 * it; and, while Settings → When a limit is reached is automatic, its place
 * in that order.
 *
 * It is information for the user's own choice (ADR-048): the user picks the
 * subscription a session uses in New agent, Quick chat or the phone's Who
 * works; nothing here picks, rotates or switches anything.
 *
 * Only what `GET /v1/subscriptions` and `GET /v1/settings` serve. A window
 * whose reset has passed since its last reading has reopened and says so
 * ("reopened 11:40", a dashed bar) — never 0% or 100% left, because what is
 * used now is not known until a session on it reports again.
 */
import type { ReactNode } from 'react'
import { isPairedDevice, type RateLimits, type Settings, type Subscription, type SubscriptionWindow } from '@/lib/api'
import { leftPct, reopened, signIns } from '@/lib/subscriptions'
import { countdown, resetClock } from '@/lib/limitclock'
import { AgentCharacter } from '@/components/Characters'
import { openSettingsAt } from '@/components/Pairing'
import { forecastLine } from '@/components/PlanLimits'
import { fmtUSD } from '@/lib/format'

/** The agents the overview groups by, in its order. */
const AGENTS: { agent: 'claude' | 'codex'; name: string }[] = [
  { agent: 'claude', name: 'Claude Code' },
  { agent: 'codex', name: 'Codex' },
]

/** True once any agent has more than one sign-in: then the panel lists them. */
export function manySignIns(all: readonly Subscription[]): boolean {
  return AGENTS.some(({ agent }) => signIns(all.filter((s) => s.agent === agent)).length > 1)
}

/** Calm with plenty left, amber at 40% or less, red at 15% or less: the
 *  gauge's thresholds (60% / 85% used), read from the other side. */
function tone(left: number): string {
  return left < 15 ? 'var(--color-danger)' : left <= 40 ? 'var(--color-warn)' : 'var(--color-ok)'
}

/** "just now", "14 min ago", "2 h 5 min ago". */
export function ageText(ms: number, now: number): string {
  return now - ms < 60_000 ? 'just now' : `${countdown(now - ms)} ago`
}

/** The newest reading among a sign-in's windows, in ms; 0 when none. */
function observedAt(s: Subscription): number {
  return s.windows.reduce((a, w) => Math.max(a, w.observed_at || 0), 0)
}

/** Its plan as the user named it: its own, or, for the own Claude sign-in, the main plan in Settings. */
function planOf(s: Subscription, settings: Settings | undefined): string {
  if (s.plan?.label) return s.plan.label
  if (s.default && s.agent === 'claude' && settings?.plan_kind && settings.plan_label) return settings.plan_label
  return ''
}

/**
 * Its place in the on-a-limit order, while that is automatic: 1-based, or
 * 0 when it is not in the order; undefined when the setting is not on or the
 * sign-in cannot be a target (an added Codex one — the order names Codex by
 * its own sign-in only).
 */
export function limitPlace(s: Subscription, settings: Settings | undefined): number | undefined {
  if (settings?.limit_action !== 'auto') return undefined
  const target = s.agent === 'codex' ? (s.default ? 'codex' : '') : s.id
  if (!target) return undefined
  return (settings.limit_fallbacks ?? []).indexOf(target) + 1
}

function ordinal(n: number): string {
  const t = n % 100
  if (t >= 11 && t <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

/** One window: its name, what is left and a bar of it, then the reset. */
function WindowCell({ name, w, now, forecast }: { name: string; w: SubscriptionWindow | undefined; now: number; forecast?: ReactNode }) {
  if (!w) {
    return (
      <span className="grid min-w-0 gap-1" data-window={name}>
        <span className="flex items-baseline justify-between gap-2 text-[12px]"><span className="text-fg-muted">{name}</span><span className="text-fg-faint">—</span></span>
        <span aria-hidden className="block h-[5px] w-full rounded-full bg-panel-2" />
        <span className="truncate text-[11px] text-fg-faint">not reported</span>
      </span>
    )
  }
  const resetMs = w.resets_at * 1000
  if (reopened(w, now / 1000)) {
    const at = resetClock(resetMs, now)
    return (
      <span className="grid min-w-0 gap-1" data-window={name} data-reopened
        title={`Its reset at ${at} has passed since this sign-in last reported: the window has reopened, and how much is used now is not known until a session on it reports again`}>
        <span className="flex flex-wrap items-baseline justify-between gap-x-2 text-[12px]">
          <span className="whitespace-nowrap text-fg-muted">{name}</span>
          <span className="num whitespace-nowrap text-fg-faint">reopened {at}</span>
        </span>
        <span aria-hidden className="block h-[5px] w-full rounded-full border border-dashed border-fg-faint/70" />
        <span className="truncate text-[11px] text-fg-faint">no reading since</span>
      </span>
    )
  }
  const left = leftPct(w)
  const color = tone(left)
  const said = `${name}: ${left}% left, resets ${resetClock(resetMs, now)}`
  return (
    <span className="grid min-w-0 gap-1" data-window={name}>
      <span className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="whitespace-nowrap text-fg-muted">{name}</span>
        <span className="num whitespace-nowrap font-medium" style={{ color: left <= 40 ? color : 'var(--color-fg)' }}>{left}% left</span>
      </span>
      <span role="img" aria-label={said} className="relative block h-[5px] w-full overflow-hidden rounded-full bg-panel-2">
        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${left}%`, background: color }} />
      </span>
      <span className="text-[11px] leading-snug text-fg-faint">resets <span className="num">{resetClock(resetMs, now)}</span> · in {countdown(resetMs - now)}</span>
      {forecast}
    </span>
  )
}

function Row({ s, settings, now, own }: { s: Subscription; settings: Settings | undefined; now: number; own?: RateLimits }) {
  const plan = planOf(s, settings)
  const seen = observedAt(s)
  const five = s.windows.find((w) => w.window === 'five_hour')
  const week = s.windows.find((w) => w.window === 'seven_day')
  // A week with no five-hour window is a plan without one (verified Ultra):
  // no empty slot for a limit that does not exist.
  const weekOnly = !five && !!week && s.agent === 'claude'
  const place = limitPlace(s, settings)
  // The own Claude sign-in's windows are the summary's, which carry the
  // daemon's forecast; an added sign-in's are never forecast.
  const fc = (w: RateLimits['five_hour']) => {
    const f = w ? forecastLine(w, now) : null
    return f ? <span className={`text-[11px] leading-snug ${f.urgent ? 'text-danger' : 'text-warn'}`}>{f.text}</span> : undefined
  }
  const owner = !isPairedDevice()
  return (
    <li data-sub-row={`${s.agent}:${s.id}`} className="grid gap-x-5 gap-y-2 px-3 py-2.5 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.9fr)] md:items-start">
      <span className="flex min-w-0 items-center gap-2.5">
        <AgentCharacter who={s.agent === 'codex' ? 'codex' : 'lead'} size={26} />
        <span className="grid min-w-0">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-[13px] font-medium text-fg" title={s.account}>{s.label}</span>
            {plan && <span className="shrink-0 text-[11px] text-fg-muted">{plan}</span>}
            {s.preferred && <span className="shrink-0 rounded-full border border-border-strong px-1.5 text-[10.5px] leading-[16px] text-fg-muted" title="New sessions of this agent start here when you pick none">default</span>}
          </span>
          <span className="truncate text-[11px] text-fg-faint">
            {!s.signed_in ? 'not signed in' : seen ? `as of ${ageText(seen, now)}` : 'no figures yet'}
          </span>
        </span>
      </span>
      {s.signed_in ? (
        <>
          <span className="grid min-w-0 grid-cols-2 gap-x-5 gap-y-2 md:col-span-2">
            {weekOnly
              ? <span className="col-span-2 md:col-span-1"><WindowCell name="Weekly" w={week} now={now} forecast={s.default ? fc(own?.seven_day) : undefined} /></span>
              : <>
                <WindowCell name="5-hour" w={five} now={now} forecast={s.default && s.agent === 'claude' ? fc(own?.five_hour) : undefined} />
                <WindowCell name="Weekly" w={week} now={now} forecast={s.default && s.agent === 'claude' ? fc(own?.seven_day) : undefined} />
              </>}
          </span>
          <span className="flex min-w-0 items-baseline justify-between gap-3 md:contents">
            <span className="grid text-[12px] md:text-right">
              <span><span className="num">{fmtUSD(s.cost_7d_usd)}</span> <span className="text-fg-faint">at API price</span></span>
              <span className="text-[11px] text-fg-faint">{s.sessions_7d} {s.sessions_7d === 1 ? 'session' : 'sessions'} · 7 days</span>
            </span>
            <span className="grid text-right text-[12px]">
              <span title="Sessions Caprock started that are running on it">
                {s.running > 0 ? <span className="text-ok">● {s.running} running</span> : <span className="text-fg-faint">none running</span>}
              </span>
              {place !== undefined && (
                <span className="text-[11px] text-fg-faint" data-limit-place title="Settings → When a limit is reached: the order Caprock continues a session in">
                  {place > 0 ? <>on a limit: <span className="text-fg-muted">{ordinal(place)}</span></> : 'not in the on-a-limit order'}
                </span>
              )}
            </span>
          </span>
        </>
      ) : (
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[12px] text-fg-muted md:col-span-4">
          <span>Not signed in: no figures until it is and a session runs on it.</span>
          {owner
            ? <button type="button" data-share-skip onClick={() => openSettingsAt('subscriptions')} className="text-accent underline-offset-2 hover:underline">Sign in</button>
            : <span className="text-fg-faint">Sign in on your computer: Settings → Subscriptions.</span>}
        </span>
      )}
    </li>
  )
}

/**
 * The list itself. `own` is the summary's Claude windows, for the own
 * sign-in's forecast; `settings` names the main plan and the on-a-limit order.
 */
export function SubscriptionsOverview({ all, settings, now, own }: { all: readonly Subscription[]; settings: Settings | undefined; now: number; own?: RateLimits }) {
  return (
    <div data-subscriptions-overview>
      {AGENTS.map(({ agent, name }) => {
        const list = signIns(all.filter((s) => s.agent === agent))
        if (list.length === 0) return null
        return (
          <div key={agent} data-sub-agent={agent} className="border-t border-border first:border-t-0">
            <div className="px-3 pb-1 pt-2.5 text-[11px] uppercase tracking-[0.1em] text-fg-muted">{name}</div>
            <ul className="[&>li+li]:border-t [&>li+li]:border-border">
              {list.map((s) => <Row key={s.id} s={s} settings={settings} now={now} own={s.default && agent === 'claude' ? own : undefined} />)}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

/** The footer line under the list: where the figures come from and what they leave out. */
export const OVERVIEW_SOURCE =
  "Figures come from each sign-in's own sessions — Claude Code's status line, Codex's session files — so they arrive only while a session runs on it. " +
  "Use elsewhere, on claude.ai or another computer, draws on the same limits and isn't seen here. Spend is at API list price, not your bill."
