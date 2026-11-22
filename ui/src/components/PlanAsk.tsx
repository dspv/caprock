/**
 * PlanAsk — the plan question asked where the cost is misread, and the words
 * a hero cost carries once the plan is known.
 *
 * A user on Pro ($20) read "Cost $29.14 · at API list price" as $29 charged
 * (2026-11-22). Caprock cannot know the plan — Claude Code does not report it
 * and inferring one would be an invented claim (rule 6) — so the question it
 * needs answered is asked under the figure that raises it, not only in the
 * header chip or Settings, which that user never opened:
 *
 *   How do you pay for Claude?   [Pro $20] [Max $100] [Ultra $200] [API key]   Not now
 *
 * A chip saves exactly what Settings → Plan & licence and the header chip save
 * (the same presets, components/PlanPicker), through the same settings PUT.
 * Under the chips, only when Claude Code's status line has reported the 5-hour
 * or weekly window — which exist only for subscription sign-ins — a hint says
 * so. It is a hint: nothing is chosen for the user. "Not now" hides the
 * question in this browser for good (localStorage); the header chip and
 * Settings still set the plan. A paired device reads (ADR-029), so it is
 * never asked there.
 *
 * Once stated, a flat plan's hero says what covered it (CostHeroSub) and a
 * metered one keeps "≈ your bill" (components/CostBasis).
 */
import { useEffect, useState, type ReactNode } from 'react'
import { isPairedDevice, type RateLimits, type Settings } from '@/lib/api'
import { PLAN_PRESETS } from './PlanPicker'

/** `off` once "Not now" was pressed in this browser. */
export const PLAN_ASK_KEY = 'caprock.app.plan-ask'
const PLAN_ASK_EVENT = 'caprock:plan-ask'

function readDismissed(): boolean {
  try { return localStorage.getItem(PLAN_ASK_KEY) === 'off' } catch { return false }
}

/** Whether the viewer said "Not now", shared by every place that asks. */
export function usePlanAskDismissed(): [boolean, () => void] {
  const [off, setOff] = useState(readDismissed)
  useEffect(() => {
    const on = () => setOff(readDismissed())
    window.addEventListener(PLAN_ASK_EVENT, on)
    return () => window.removeEventListener(PLAN_ASK_EVENT, on)
  }, [])
  const dismiss = () => {
    try { localStorage.setItem(PLAN_ASK_KEY, 'off') } catch { /* private window: for this page only */ }
    setOff(true)
    window.dispatchEvent(new Event(PLAN_ASK_EVENT))
  }
  return [off, dismiss]
}

/**
 * Whether the hero cost figures are asking right now: the plan has loaded and
 * is unstated, "Not now" was not pressed, and this is not a paired device.
 * While they ask, the other plan prompts on Home and Cost (Plan limits'
 * "Which plan are you on?" card, Plan value's invitation) stay out of sight,
 * so a new user is asked once (owner, 2026-11-22).
 */
export function usePlanAskShowing(plan?: Settings): [boolean, () => void] {
  const [dismissed, dismiss] = usePlanAskDismissed()
  return [!!plan && !plan.plan_kind && !dismissed && !isPairedDevice(), dismiss]
}

export interface PlanAskChoice {
  chip: string
  patch: Pick<Settings, 'plan_kind' | 'plan_label' | 'plan_usd_per_month'>
}

/** The four chips, read from the plan picker's presets so a name or a price
 *  is changed in one place (its source and date are there). */
export const PLAN_ASK_CHOICES: readonly PlanAskChoice[] = ['Pro', 'Max', 'Ultra', 'API / Bedrock'].flatMap((label) => {
  const p = PLAN_PRESETS.find((x) => x.label === label)
  if (!p) return []
  return [{
    chip: p.kind === 'metered' ? 'API key' : `${p.label} $${p.usd}`,
    patch: { plan_kind: p.kind, plan_label: p.label, plan_usd_per_month: p.usd },
  }]
})

/** True when Claude Code's status line has reported a plan window: those
 *  exist only for a subscription sign-in, never on API billing. */
export function hasPlanWindows(limits?: RateLimits | null): boolean {
  return !!(limits?.five_hour || limits?.seven_day)
}

export function PlanAsk({ onSave, limits, onDismiss }: {
  onSave: (patch: Partial<Settings>) => void
  limits?: RateLimits | null
  onDismiss: () => void
}) {
  return (
    <div data-plan-ask className="mt-1.5 text-[12px] whitespace-normal">
      <div className="text-fg">How do you pay for Claude?</div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {PLAN_ASK_CHOICES.map((c) => (
          <button
            key={c.chip}
            type="button"
            data-plan-ask-chip={c.patch.plan_label}
            onClick={() => onSave(c.patch)}
            className="mono text-[11px] px-1.5 py-0.5 rounded-sm border border-border text-fg hover:border-border-strong hover:bg-panel-2"
          >
            {c.chip}
          </button>
        ))}
        <button
          type="button"
          data-plan-ask-dismiss
          onClick={onDismiss}
          title="Hide this question in this browser. The plan chip in the header still sets it."
          className="text-[11px] px-1 py-0.5 text-fg-faint hover:text-fg"
        >
          Not now
        </button>
      </div>
      {hasPlanWindows(limits) && (
        <div data-plan-ask-hint className="mt-1 text-[11px] text-fg-faint">
          Claude shows you plan limits, so it looks like a subscription.
        </div>
      )}
    </div>
  )
}

/** "Claude Code work is covered by your Pro plan." and its caveat, for a flat plan's hero. */
export function CostCovered({ plan }: { plan: Settings }) {
  return (
    <span data-cost-covered className="block whitespace-normal">
      <span className="block text-ok">Claude Code work is covered by your {plan.plan_label || 'flat'} plan.</span>
      <span className="block text-[10.5px] text-fg-faint">Nothing extra was charged unless you turned on extra usage.</span>
    </span>
  )
}

/**
 * The line under a hero cost: the basis, the plan question while the plan is
 * unstated, or what covered the work on a flat plan.
 *
 * `basis` is what the tile said before (costBasis, or "nothing measured yet"):
 * kept for unstated and metered plans. Until the plan has loaded, nothing is
 * asked — a question that flashes and vanishes reads as a glitch.
 */
export function CostHeroSub({ plan, onSave, limits, basis, measured }: {
  plan?: Settings
  onSave: (patch: Partial<Settings>) => void
  limits?: RateLimits | null
  basis: ReactNode
  measured: boolean
}) {
  const [ask, dismiss] = usePlanAskShowing(plan)
  if (plan?.plan_kind === 'flat' && measured) return <CostCovered plan={plan} />
  return (
    <>
      {basis}
      {ask && <PlanAsk onSave={onSave} limits={limits} onDismiss={dismiss} />}
    </>
  )
}
