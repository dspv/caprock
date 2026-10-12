/**
 * The plan a session is set against: its account's own, when the user stated
 * one in Settings → Plan & licence, else the main plan.
 *
 * A tester, 2026-10-12 (translated): "Plan & licence then also needs redoing
 * per account — I have different plans on the accounts and it's unclear what
 * to choose here." So each subscription (ADR-048) may carry its own plan, and
 * the main plan — the one the header chip sets — stays the plan of the user's
 * own sign-in and of every session no other plan is known for. Caprock still
 * never guesses a plan (rule 6): an account without one says it uses the main.
 */
import { useState } from 'react'
import type { RateLimits, Settings, Subscription, SubscriptionPlan } from '@/lib/api'
import { api, errText } from '@/lib/api'
import { fmtUSD } from '@/lib/format'
import { hasSubscriptions } from '@/lib/subscriptions'
import { PlanOptions, usePlan } from './PlanPicker'
import { subscriptionsChanged, subscriptionsFor, useSubscriptionList } from './SubscriptionPicker'

type PlanFields = Pick<Settings, 'plan_kind' | 'plan_label' | 'plan_usd_per_month'>

/** A sign-in's plan in the shape the cost helpers read (Settings' three fields). */
export function planFields(p: SubscriptionPlan): PlanFields {
  return { plan_kind: p.kind, plan_label: p.label ?? '', plan_usd_per_month: p.usd_per_month ?? 0 }
}

/** The reverse: what PlanOptions picked, as a sign-in's plan; null for "not stated". */
export function asSubscriptionPlan(patch: Partial<Settings>): SubscriptionPlan | null {
  if (patch.plan_kind !== 'flat' && patch.plan_kind !== 'metered') return null
  return { kind: patch.plan_kind, label: patch.plan_label ?? '', usd_per_month: patch.plan_usd_per_month ?? 0 }
}

/** The plan that applies to a sign-in: its own, else the main one. */
export function planFor(sub: Subscription | undefined, main: Settings | undefined): Settings | undefined {
  if (!sub || sub.default || !sub.plan) return main
  return { ...(main ?? { update_checks: false, plan_kind: '', plan_label: '', plan_usd_per_month: 0 }), ...planFields(sub.plan) }
}

/** "Max 20× · $200.00/mo", "API · billed per token", or "" when not stated. */
export function planText(p: Partial<PlanFields> | undefined, fmt: (n: number) => string): string {
  if (p?.plan_kind === 'metered') return `${p.plan_label || 'API'} · billed per token`
  if (p?.plan_kind === 'flat') return `${p.plan_label || 'plan'} · ${fmt(p.plan_usd_per_month ?? 0)}/mo`
  return ''
}

/** Save a sign-in's own plan; null clears it, and the main one stands for it. */
export async function saveSubscriptionPlan(id: string, plan: SubscriptionPlan | null): Promise<void> {
  await api.updateSubscription(id, { plan })
  subscriptionsChanged()
}

/** A subscription's last windows in the shape the cockpit's bars read. */
export function windowsOf(sub: Subscription | undefined): RateLimits | undefined {
  if (!sub) return undefined
  const out: RateLimits = {}
  for (const w of sub.windows) out[w.window] = { used_percentage: w.used_percentage, resets_at: w.resets_at, observed_at: w.observed_at }
  return out.five_hour || out.seven_day ? out : undefined
}

export interface SessionPlan {
  /** The plan this session is set against. */
  plan: Settings | undefined
  /** Changes that plan where it lives: the account's own, or the main one. */
  save: (patch: Partial<Settings>) => void
  /** The account, when the session ran on one of the user's subscriptions. */
  account?: Subscription
  /** Whether the plan shown is the account's own rather than the main one. */
  own: boolean
}

/**
 * The plan for a session of `agent` on `subscription` ("" or absent: the
 * user's own sign-in, whose plan is the main one).
 */
export function useSessionPlan(agent: string | undefined, subscription: string | undefined): SessionPlan {
  const [main, saveMain] = usePlan()
  const onSub = !!subscription && hasSubscriptions(agent ?? 'claude')
  const { all } = useSubscriptionList(onSub)
  const account = onSub ? subscriptionsFor(all, agent ?? 'claude').find((s) => s.id === subscription) : undefined
  if (!account || account.default) return { plan: main, save: saveMain, account, own: false }
  return {
    plan: planFor(account, main),
    save: (patch) => { void saveSubscriptionPlan(account.id, asSubscriptionPlan(patch)).catch(() => { /* the chip shows the stored plan */ }) },
    account,
    own: !!account.plan,
  }
}

/**
 * Settings → Plan & licence with more than one Claude Code sign-in: a row per
 * account — its name and e-mail, the plan that applies, a way to change it.
 * The own sign-in's row is the main plan.
 */
export function AccountPlans({ list, main, saveMain }: { list: readonly Subscription[]; main: Settings; saveMain: (patch: Partial<Settings>) => void }) {
  return (
    <ul className="grid gap-1.5" aria-label="Plan per account">
      {list.map((s) => <AccountPlanRow key={s.id} sub={s} main={main} saveMain={saveMain} />)}
    </ul>
  )
}

function AccountPlanRow({ sub, main, saveMain }: { sub: Subscription; main: Settings; saveMain: (patch: Partial<Settings>) => void }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const own = sub.default
  const applies = own ? main : sub.plan ? planFields(sub.plan) : main
  const text = planText(applies, fmtUSD) || 'not set'
  const save = (patch: Partial<Settings>) => {
    setOpen(false)
    setError('')
    if (own) { saveMain(patch); return }
    saveSubscriptionPlan(sub.id, asSubscriptionPlan(patch)).catch((e) => setError(errText(e)))
  }
  return (
    <li className="grid gap-1.5 rounded-[8px] border border-border px-3 py-2" data-account={sub.id}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[13px] font-medium text-fg">{sub.label}</span>
        <span className="min-w-0 truncate text-[12px] text-fg-muted">{sub.account || (sub.signed_in ? 'signed in' : 'not signed in')}</span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`Plan for ${sub.label}`}
          className={`mono ml-auto rounded-sm border px-1.5 py-0.5 text-[11.5px] ${applies.plan_kind ? 'border-border-strong bg-panel-2 text-fg' : 'border-accent/50 text-accent'}`}
        >
          {text}
        </button>
      </div>
      <p data-keep className="text-[11.5px] text-fg-faint">
        {own
          ? 'The main plan: also used for sessions with no plan of their own account.'
          : sub.plan ? 'Its own plan.' : 'No plan of its own: the main plan stands for it.'}
      </p>
      {open && (
        <div className="max-w-sm rounded-md border border-border p-1.5">
          <PlanOptions plan={own || sub.plan ? applies : undefined} onSave={save} useMain={own ? undefined : !sub.plan} />
        </div>
      )}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </li>
  )
}
