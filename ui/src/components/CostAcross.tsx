/**
 * Cost across computers (ADR-067, Phase 3; owner's pick 2026-11-07, variant
 * A): a *This Mac / All computers* toggle beside the Cost screen's range,
 * offered only on this machine itself with another computer linked. *All
 * computers* asks the same summary with `?machines=all` and shows one row per
 * computer and the total of those that answered. A computer that did not
 * answer is named with why and counted as nothing at all — not as $0 (rule 6)
 * — and the total says how many of how many it holds. Each computer priced
 * its own sessions with its own pricing table, which its row names; the rest
 * of the screen stays this machine's.
 */
import { useState } from 'react'
import { isPairedDevice, type Summary } from '@/lib/api'
import { fmtTokens, fmtUSD } from '@/lib/format'
import { machineLook, useMachines } from '@/lib/machines'
import { machinePageId } from '@/lib/machinepage'
import { Panel, Skeleton } from './ui'
import { thisComputer } from './RemoteAgentSheet'

export type CostScope = 'this' | 'all'

const SCOPE_KEY = 'caprock.cost.machines'

function readScope(): CostScope {
  try {
    return localStorage.getItem(SCOPE_KEY) === 'all' ? 'all' : 'this'
  } catch {
    return 'this'
  }
}

/**
 * Which machines the Cost screen counts, remembered in this browser, and
 * whether *All computers* can be offered here at all: on this machine's own
 * window (never a paired phone or a computer's machine page, which the
 * daemon refuses anyway: not transitive), with another computer linked.
 */
export function useCostScope(): [CostScope, (s: CostScope) => void, boolean] {
  const [scope, set] = useState<CostScope>(readScope)
  const own = !isPairedDevice() && !machinePageId()
  const machines = useMachines(60_000)
  const can = own && (machines.data?.length ?? 0) > 0
  const setScope = (s: CostScope) => {
    set(s)
    try {
      localStorage.setItem(SCOPE_KEY, s)
    } catch {
      /* private window: this view only */
    }
  }
  return [scope, setScope, can]
}

export function CostScopeToggle({ scope, onChange }: { scope: CostScope; onChange: (s: CostScope) => void }) {
  const opt = (s: CostScope, label: string) => (
    <button
      type="button"
      aria-pressed={scope === s}
      onClick={() => onChange(s)}
      className={`px-2 py-1 text-[12px] ${scope === s ? 'bg-panel-2 text-accent' : 'text-fg-muted hover:text-fg'}`}
    >
      {label}
    </button>
  )
  return (
    <div role="group" aria-label="Which computers" className="ml-2 inline-flex shrink-0 whitespace-nowrap rounded-sm border border-border overflow-hidden">
      {opt('this', thisComputer())}
      {opt('all', 'All computers')}
    </div>
  )
}

/** The word for a computer that did not answer. */
function missingWord(status: string, name: string, error?: string): string {
  if (status === 'error') return 'did not answer'
  return machineLook({ name, status: status as never, error }).label
}

export function CostAcrossPanel({ summary: s, range }: { summary?: Summary; range: string }) {
  const title = `All computers · ${range}`
  if (!s) {
    return (
      <Panel title={title}>
        <Skeleton rows={3} />
      </Panel>
    )
  }
  const all = s.all
  const machines = s.machines ?? []
  const missing = machines.filter((m) => m.cost_usd === undefined)
  const unpriced = [...(s.unpriced ? [thisComputer()] : []), ...machines.filter((m) => m.unpriced).map((m) => m.name)]
  return (
    <Panel title={title}>
      <table className="w-full text-[13px]" data-testid="cost-across">
        <tbody>
          <tr className="border-b border-border">
            <td className="px-3 py-1.5">{thisComputer()} <span className="text-fg-faint text-[11px]">· this one · table {s.pricing_version}</span></td>
            <td className="px-3 py-1.5 text-right text-fg-muted tabular-nums">{s.sessions} sessions · {fmtTokens(s.tokens_in + s.tokens_out + s.cache_read + s.cache_write)}</td>
            <td className="px-3 py-1.5 text-right tabular-nums">{fmtUSD(s.cost_usd)}</td>
          </tr>
          {machines.map((m) =>
            m.cost_usd !== undefined ? (
              <tr key={m.id} className="border-b border-border">
                <td className="px-3 py-1.5">{m.name} {m.pricing_version && <span className="text-fg-faint text-[11px]">· table {m.pricing_version}</span>}</td>
                <td className="px-3 py-1.5 text-right text-fg-muted tabular-nums">{m.sessions ?? 0} sessions · {fmtTokens(m.tokens ?? 0)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtUSD(m.cost_usd)}</td>
              </tr>
            ) : (
              <tr key={m.id} className="border-b border-border text-fg-muted italic" title={m.error || undefined}>
                <td className="px-3 py-1.5" colSpan={2}>{m.name} — {missingWord(m.status, m.name, m.error)}, not counted</td>
                <td className="px-3 py-1.5 text-right not-italic">—</td>
              </tr>
            ),
          )}
          {all && (
            <tr className="font-medium">
              <td className="px-3 py-1.5" colSpan={2}>Total ({all.answered} of {all.of})</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{fmtUSD(all.cost_usd)}</td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="px-3 pb-2 pt-1 text-[11px] text-fg-faint grid gap-0.5">
        {missing.length > 0 && (
          <div className="text-warn">
            The total leaves out {missing.map((m) => m.name).join(', ')}: what {missing.length === 1 ? 'it' : 'they'} spent is unknown here, not $0.
          </div>
        )}
        {unpriced.length > 0 && <div>Some turns on {unpriced.join(', ')} have no price in that computer's table: the total is what could be priced.</div>}
        <div>Each computer counts the range by its own clock and prices its sessions with its own table. The rest of this screen is {thisComputer()}'s.</div>
      </div>
    </Panel>
  )
}
