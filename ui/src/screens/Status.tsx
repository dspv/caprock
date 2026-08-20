import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtDuration, fmtUSD } from '@/lib/format'
import { Empty, Panel } from '@/components/ui'
import { usePlan } from '@/components/PlanPicker'

export function StatusScreen() {
  const st = useApi(() => api.status(), [], { live: false, intervalMs: 5000 })
  const s = st.data
  if (st.error && !s) return <Empty title="Cannot reach the daemon">{st.error.message}</Empty>
  if (!s) return <div className="text-fg-muted">loading…</div>
  const rows: [string, string][] = [
    ['version', s.version],
    ['url', s.url],
    ['pid', String(s.pid)],
    ['uptime', fmtDuration(s.uptime_s * 1000)],
    ['data dir', s.data_dir],
    ['pricing', `${s.pricing.version} · ${s.pricing.models} models · fetched ${s.pricing.fetched_at}${s.pricing.user_override ? ' · user override' : ''}`],
    ['pricing source', s.pricing.source],
    ['loop rule', `≥ ${s.loop_k} same-tool calls in ${s.loop_t_minutes} min · ${s.active_loops} active`],
    ['events stored', `${s.events.toLocaleString()}${s.retention_days > 0 ? ` · pruned after ${s.retention_days}d` : ' · kept forever (set retention_days to cap DB growth)'}`],
    ['orchestration', s.orchestration ? 'on (--hive)' : 'off'],
    ['dashboard', s.ui_built ? 'embedded build' : 'dev server / placeholder'],
  ]
  if (s.hooks) rows.push(['hooks', `${(s.hooks.installed ?? []).length}/${(s.hooks.installed ?? []).length + (s.hooks.missing ?? []).length} events registered in ${s.hooks.settings_path}${s.hooks.shim_exists ? '' : ' (shim missing)'}`])
  if (s.desktop) {
    // Percentages of a plan window, not tokens or cost — the file holds nothing
    // else, and implying otherwise would be an invented number. The app only
    // samples while it is running, so a stale reading says so.
    const d = s.desktop
    rows.push([
      'claude desktop',
      `${d.five_hour_pct}% of the 5-hour window · ${d.seven_day_pct}% of the 7-day${d.stale ? ' · last seen ' + new Date(d.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ', app closed since' : ' · now'}`,
    ])
  }
  if (s.ingest) rows.push(['ingest', `${s.ingest.files_known} transcripts · ${s.ingest.events_stored} events stored · ${s.ingest.events_deduped} deduped · ${s.ingest.lines_malformed} malformed lines · backfill ${s.ingest.backfill_done ? 'done' : 'running'}`])
  return (
    <div className="grid gap-3 max-w-3xl">
      <SettingsPanel />
      <Panel title="Daemon">
        <table className="w-full text-[12px]">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k} className="border-b border-border/60 last:border-0">
                <td className="px-3 py-1 text-fg-muted w-32">{k}</td>
                <td className="px-3 py-1 mono break-all">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      {s.hooks && (s.hooks.missing ?? []).length > 0 && (
        <Panel title="Hooks not fully installed">
          <div className="px-3 py-2 text-[12px] text-fg-muted">
            Missing: <span className="mono">{(s.hooks.missing ?? []).join(', ')}</span>. Run <span className="mono">caprock hooks install</span> for real-time activity; transcript tailing keeps working with a few seconds of delay.
          </div>
        </Panel>
      )}
    </div>
  )
}

/**
 * The settings a user can actually change. This screen is what the header's
 * "status" link opens and the hooks banner sends people to, so it read as the
 * settings screen while offering nothing to set — the plan lived only in a
 * header chip, and release checks could only be turned on from a banner that
 * disappears once dismissed.
 */
function SettingsPanel() {
  const [plan, savePlan] = usePlan()
  if (!plan) return null
  return (
    <Panel title="Settings">
      <div className="grid gap-2 px-3 py-2.5 text-[12px]">
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            className="accent-[var(--color-accent)] mt-0.5"
            checked={plan.update_checks}
            onChange={(e) => savePlan({ ...plan, update_checks: e.target.checked })}
          />
          <span>
            <span className="text-fg">Check GitHub for new releases</span>
            <span className="block text-[11px] text-fg-muted">
              The only outbound call Caprock makes. No usage data is sent, and it
              is checked at most once a day.
            </span>
          </span>
        </label>
        <div className="flex items-baseline gap-2 border-t border-border pt-2">
          <span className="text-fg-muted w-28 shrink-0">Your plan</span>
          <span className="mono text-fg">
            {plan.plan_kind === 'metered'
              ? `${plan.plan_label || 'API'} · billed per token`
              : plan.plan_kind === 'flat'
                ? `${plan.plan_label || 'plan'} · ${fmtUSD(plan.plan_usd_per_month)}/mo`
                : 'not set'}
          </span>
          <span className="text-[11px] text-fg-faint ml-auto">change it in the header</span>
        </div>
      </div>
    </Panel>
  )
}
