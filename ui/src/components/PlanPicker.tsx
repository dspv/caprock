/**
 * PlanPicker — the plan chip in the header, and the small popover that sets it.
 *
 * Caprock cannot detect how you pay for Claude Code: Claude Code does not report
 * the plan, and inferring one from usage would be an invented number (rule 6).
 * So the user states it, it lives in the header where it is visible and one
 * click from being changed, and it is stored locally like everything else.
 *
 * The distinction that matters is not Pro-vs-Max but **flat vs metered**:
 *  - flat (Pro / Max / a Team seat): usage priced at API list is an
 *    *equivalent*, and comparing it to the fee says something real.
 *  - metered (API key, Bedrock, Vertex, Enterprise usage at API rates): the
 *    API-list figure IS roughly the bill. Framing it as a saving would be a
 *    lie, so the comparison is suppressed and the total is labelled as spend.
 */
import { useEffect, useRef, useState } from 'react'
import { api, type Settings } from '@/lib/api'
import { fmtUSD } from '@/lib/format'

/** The common flat plans, as published by Anthropic. The user can type any price. */
const PRESETS: { label: string; kind: 'flat' | 'metered'; usd: number; note: string }[] = [
  { label: 'Pro', kind: 'flat', usd: 20, note: '$20/mo' },
  { label: 'Max 5×', kind: 'flat', usd: 100, note: '$100/mo' },
  { label: 'Max 20×', kind: 'flat', usd: 200, note: '$200/mo' },
  { label: 'Team seat', kind: 'flat', usd: 30, note: '$30/seat/mo' },
  { label: 'API / Bedrock', kind: 'metered', usd: 0, note: 'billed per token' },
]

// The plan is read by the header chip and by any screen that prices usage, so
// it lives in one tiny store rather than being fetched per component — a stale
// chip beside a fresh number would be worse than either alone.
let cached: Settings | undefined
let inflight: Promise<void> | null = null
const subs = new Set<() => void>()

function emit() {
  for (const s of subs) s()
}

export function usePlan(): [Settings | undefined, (patch: Partial<Settings>) => void] {
  const [, force] = useState(0)
  useEffect(() => {
    const fn = () => force((v) => v + 1)
    subs.add(fn)
    if (!cached && !inflight) {
      inflight = api
        .settings()
        .then((s) => { cached = s })
        .catch(() => { cached = { update_checks: false, plan_kind: '', plan_label: '', plan_usd_per_month: 0 } })
        .finally(() => { inflight = null; emit() })
    }
    return () => { subs.delete(fn) }
  }, [])

  // Send only what changed.
  //
  // This used to PUT the whole Settings object, built from this module's
  // cached copy — so any control could overwrite a field it knew nothing
  // about with a value it read minutes ago. Two tabs were enough: change the
  // plan in one, click "check for updates" in the other, and the second wrote
  // the plan back to what its cache still held. The setting had saved; a stale
  // copy undid it, which reads as "it does not stick".
  //
  // The server has always been a patch — absent fields are left alone — so the
  // fix is to stop pretending otherwise on this side.
  const save = (patch: Partial<Settings>) => {
    cached = { ...(cached ?? ({} as Settings)), ...patch } // optimistic: the chip must never lag the click
    emit()
    void api.saveSettings(patch as Settings).catch(() => { /* stays local until the next load */ })
  }
  return [cached, save]
}

export function PlanChip({ plan, onSave }: { plan?: Settings; onSave: (patch: Partial<Settings>) => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const label = !plan?.plan_kind
    ? 'set plan'
    : plan.plan_kind === 'metered'
      ? plan.plan_label || 'API'
      : `${plan.plan_label || 'plan'} · ${fmtUSD(plan.plan_usd_per_month)}/mo`

  return (
    <div className="relative" ref={box}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`mono text-[11px] px-1.5 py-0.5 rounded-sm border ${
          plan?.plan_kind ? 'border-border text-fg-muted hover:text-fg' : 'border-accent/50 text-accent'
        }`}
        title="How you pay for Claude Code — Caprock cannot detect this, so you tell it"
      >
        {label}
      </button>
      {open && <PlanMenu plan={plan} onSave={(s) => { onSave(s); setOpen(false) }} />}
    </div>
  )
}

function PlanMenu({ plan, onSave }: { plan?: Settings; onSave: (patch: Partial<Settings>) => void }) {
  const [custom, setCustom] = useState(String(plan?.plan_usd_per_month || ''))
  // Carry every other setting through: changing the plan must not silently
  // reset an unrelated preference such as release checks.
  return (
    <div className="absolute right-0 top-7 z-20 w-[268px] border border-border-strong bg-panel rounded-[var(--radius-panel)] shadow-lg p-2">
      <div className="text-[11px] text-fg-muted px-1 pb-1.5">
        How do you pay for Claude Code? Caprock can&apos;t detect this and never guesses.
      </div>
      {PRESETS.map((p) => {
        const active = plan?.plan_label === p.label
        return (
          <button
            key={p.label}
            onClick={() => onSave({ plan_kind: p.kind, plan_label: p.label, plan_usd_per_month: p.usd })}
            className={`w-full flex items-baseline gap-2 px-1.5 py-1 rounded-sm text-left text-[12px] hover:bg-panel-2 ${
              active ? 'text-accent' : 'text-fg'
            }`}
          >
            <span>{p.label}</span>
            <span className="mono text-[11px] text-fg-faint ml-auto">{p.note}</span>
          </button>
        )
      })}
      <div className="border-t border-border mt-1.5 pt-1.5 px-1.5">
        <label className="text-[11px] text-fg-faint">Or a different monthly price</label>
        <div className="flex items-center gap-1.5 mt-1">
          <span className="mono text-[12px] text-fg-faint">$</span>
          <input
            className="input"
            inputMode="decimal"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="e.g. 150"
          />
          <button
            className="text-[11px] border border-border px-1.5 py-1 rounded-sm hover:border-border-strong"
            onClick={() => {
              const usd = Number(custom)
              if (!Number.isFinite(usd) || usd < 0) return
              onSave({ plan_kind: 'flat', plan_label: 'plan', plan_usd_per_month: usd })
            }}
          >
            set
          </button>
        </div>
      </div>
    </div>
  )
}
