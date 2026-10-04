/**
 * A tool's row, opened: what its calls were about.
 *
 * Bash by the command each call ran, Read and Edit by file, WebFetch by
 * domain, WebSearch by query, an MCP tool by its action. The groups and their
 * calls and shares are free. What came back, how often each group failed, a
 * trend per group and the hints are Premium; the daemon leaves those figures
 * out without a licence, so the locked view draws placeholders under glass —
 * never a made-up number — and shows the one strongest hint in full, which
 * the daemon sends either way.
 */
import { useState } from 'react'
import { api, type DrillRow, type ToolDrill as Drill } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtBytes } from '@/lib/format'
import { PremiumModal } from './PremiumModal'

type Range = 'today' | '7d' | '30d' | 'all'

const GROUP_LABEL: Record<string, string> = {
  command: 'command', file: 'file', domain: 'domain', query: 'query', action: 'action',
  pattern: 'pattern', subagent: 'subagent', call: 'call',
}

function share(n: number, total: number): string {
  if (total <= 0) return '—'
  const p = (100 * n) / total
  return p < 1 ? '<1%' : `${Math.floor(p)}%`
}

function failRate(r: DrillRow): string {
  if (!r.results) return '—'
  const p = (100 * (r.failures ?? 0)) / r.results
  return p === 0 ? '0%' : p < 1 ? '<1%' : `${Math.round(p)}%`
}

/** Eight columns of calls over the window, the tallest full height. Plain boxes. */
function Trend({ values }: { values: number[] }) {
  const max = Math.max(...values, 1)
  return (
    <span className="inline-flex h-3.5 items-end gap-[2px]" aria-hidden>
      {values.map((v, i) => (
        <span key={i} className={v > 0 ? 'bg-accent/80' : 'bg-border'} style={{ width: 3, height: v > 0 ? Math.max(2, Math.round((v / max) * 14)) : 1 }} />
      ))}
    </span>
  )
}

export function ToolDrill({ tool, range, agent }: { tool: string; range: Range; agent?: string }) {
  const d = useApi(() => api.toolDrill(tool, range, agent), [tool, range, agent], { live: false })
  const [premium, setPremium] = useState(false)
  if (d.error && !d.data) return <p className="px-3 py-2 text-[12px] text-fg-muted">Could not read this tool's calls: {d.error.message}</p>
  if (!d.data) return <p className="px-3 py-2 text-[12px] text-fg-faint" role="status">Reading {tool}'s calls…</p>
  const x: Drill = d.data
  if (x.calls === 0) return <p className="px-3 py-2 text-[12px] text-fg-muted">No calls in this range.</p>
  const locked = x.locked
  const maxCalls = Math.max(...x.rows.map((r) => r.calls), 1)
  const by = GROUP_LABEL[x.group_by] ?? x.group_by
  const hints = locked ? (x.teaser ? [x.teaser] : []) : (x.hints ?? [])

  return (
    <div className="border-y border-border bg-panel-2/40 px-3 py-2.5">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-fg-muted">
        <span>{x.calls.toLocaleString('en-US')} calls · by {by}</span>
        {!locked && x.results ? (
          <span className="num">
            {fmtBytes(x.bytes ?? 0)} returned · {failRate({ key: '', calls: x.calls, results: x.results, failures: x.failures })} failed
          </span>
        ) : null}
        {locked && (
          <button type="button" onClick={() => setPremium(true)}
            className="ml-auto rounded-full border border-accent/60 px-2 py-[1px] text-[10.5px] font-medium uppercase tracking-[0.1em] text-accent hover:bg-accent/10">
            Premium
          </button>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-[0.08em] text-fg-faint">
              <th className="pb-1 pr-2 text-left font-normal">{by}</th>
              <th className="pb-1 px-2 text-right font-normal">calls</th>
              <th className="pb-1 px-2 text-left font-normal w-[22%]">share</th>
              <th className="pb-1 px-2 text-right font-normal">returned</th>
              <th className="pb-1 px-2 text-right font-normal">failed</th>
              <th className="pb-1 pl-2 text-right font-normal">trend</th>
            </tr>
          </thead>
          <tbody>
            {x.rows.map((r) => (
              <tr key={r.key} className="border-t border-border/60">
                <td className="py-[3px] pr-2 mono truncate max-w-[18rem]" title={r.key}>{r.key}</td>
                <td className="py-[3px] px-2 num text-right">{r.calls.toLocaleString('en-US')}</td>
                <td className="py-[3px] px-2">
                  <span className="flex items-center gap-1.5">
                    <span className="hidden h-1.5 flex-1 rounded-sm bg-panel-2 sm:block"><span className="block h-full rounded-sm bg-accent/70" style={{ width: `${(100 * r.calls) / maxCalls}%` }} /></span>
                    <span className="num ml-auto w-8 text-right text-fg-muted">{share(r.calls, x.calls)}</span>
                  </span>
                </td>
                {locked ? (
                  // Placeholders, blurred: the shape of what Premium shows,
                  // with no figure in it to mistake for a measurement.
                  <td colSpan={3} className="py-[3px] pl-2" aria-label="Premium">
                    <span className="block select-none blur-[3px] text-right text-fg-faint" aria-hidden>▇▇▇ · ▇▇ · ▁▃▅▂▇▁</span>
                  </td>
                ) : (
                  <>
                    <td className="py-[3px] px-2 num text-right text-fg-muted">{r.bytes ? fmtBytes(r.bytes) : '—'}</td>
                    <td className={`py-[3px] px-2 num text-right ${(r.results ?? 0) >= 20 && (r.failures ?? 0) / (r.results ?? 1) >= 0.1 ? 'text-danger' : 'text-fg-muted'}`}>{failRate(r)}</td>
                    <td className="py-[3px] pl-2 text-right">{r.trend ? <Trend values={r.trend} /> : null}</td>
                  </>
                )}
              </tr>
            ))}
            {x.other > 0 && (
              <tr className="border-t border-border/60 text-fg-muted">
                <td className="py-[3px] pr-2">other</td>
                <td className="py-[3px] px-2 num text-right">{x.other.toLocaleString('en-US')}</td>
                <td className="py-[3px] px-2 num text-right" colSpan={4}>{share(x.other, x.calls)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {hints.length > 0 && (
        <ul className="mt-2 grid gap-1 text-[12px] leading-snug">
          {hints.map((h) => (
            <li key={h.kind + h.key} className="flex gap-2">
              <span aria-hidden className="text-accent">→</span>
              <span className="text-fg">{h.text.split('`').map((part, i) => (i % 2 ? <code key={i} className="mono text-[11.5px]">{part}</code> : part))}</span>
            </li>
          ))}
          {locked && (
            <li className="text-[11.5px] text-fg-muted">
              Output, failure rates, trends and the rest of the hints for every {by} are{' '}
              <button type="button" onClick={() => setPremium(true)} className="text-accent underline-offset-2 hover:underline">in Premium</button>.
            </li>
          )}
        </ul>
      )}
      {locked && hints.length === 0 && (
        <p className="mt-2 text-[11.5px] text-fg-muted">
          Output, failure rates and trends per {by} are{' '}
          <button type="button" onClick={() => setPremium(true)} className="text-accent underline-offset-2 hover:underline">in Premium</button>.
        </p>
      )}
      {premium && <PremiumModal feature="drill" onClose={() => setPremium(false)} />}
    </div>
  )
}
