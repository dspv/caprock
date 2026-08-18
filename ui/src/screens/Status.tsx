import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtDuration } from '@/lib/format'
import { Empty, Panel } from '@/components/ui'

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
    ['dashboard', s.ui_built ? 'embedded build' : 'dev server / placeholder'],
  ]
  if (s.hooks) rows.push(['hooks', `${(s.hooks.installed ?? []).length}/${(s.hooks.installed ?? []).length + (s.hooks.missing ?? []).length} events registered in ${s.hooks.settings_path}${s.hooks.shim_exists ? '' : ' (shim missing)'}`])
  if (s.ingest) rows.push(['ingest', `${s.ingest.files_known} transcripts · ${s.ingest.events_stored} events stored · ${s.ingest.events_deduped} deduped · ${s.ingest.lines_malformed} malformed lines · backfill ${s.ingest.backfill_done ? 'done' : 'running'}`])
  return (
    <div className="grid gap-3 max-w-3xl">
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
