import { useState } from 'react'
import { api, type CursorCost, type CursorHooksStatus, type OverheadReport, type OverheadRow } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtTokens, fmtUSD } from '@/lib/format'
import { Panel, Stat } from '@/components/ui'
import { AgentGlyph } from './AgentMarks'
import { doesntRecord } from '@/lib/gaps'

/** A list rate per million tokens put on a token count: the dollars it is
 *  at that rate. */
export function atRate(tokens: number, perMillion: number): number {
  return (tokens * perMillion) / 1e6
}

/** "~14.2k (n=7)" — the median of the clean samples, or a dash. */
export function overheadCell(r?: OverheadRow): string {
  if (!r || r.clean === 0) return '—'
  return `~${fmtTokens(r.median_tokens)}`
}

/** "7 of 14" or "8,407" — the samples column, its unit in the header. */
export function samplesCount(r?: OverheadRow): string {
  if (!r) return ''
  const n = (v: number) => v.toLocaleString('en-US')
  return r.clean === r.samples ? n(r.samples) : `${n(r.clean)} of ${n(r.samples)}`
}

/** The rows of the comparison: every family either agent has, Cursor's
 *  first, then by how many samples stand behind them. */
export function overheadRows(rep?: OverheadReport): { family: string; cursor?: OverheadRow; claude?: OverheadRow; input?: number; cacheRead?: number }[] {
  if (!rep) return []
  const by = new Map<string, { family: string; cursor?: OverheadRow; claude?: OverheadRow; input?: number; cacheRead?: number }>()
  for (const r of rep.cursor ?? []) by.set(r.family, { family: r.family, cursor: r })
  for (const r of rep.claude ?? []) by.set(r.family, { ...(by.get(r.family) ?? { family: r.family }), claude: r })
  for (const rate of rep.rates ?? []) {
    const row = by.get(rate.family)
    if (row) Object.assign(row, { input: rate.input, cacheRead: rate.cache_read })
  }
  const weight = (x: { cursor?: OverheadRow; claude?: OverheadRow }) => (x.cursor ? 1e6 : 0) + (x.cursor?.clean ?? 0) * 1000 + (x.claude?.samples ?? 0)
  return [...by.values()].filter((x) => (x.cursor?.clean ?? 0) > 0 || (x.claude?.samples ?? 0) > 0).sort((a, b) => weight(b) - weight(a))
}

/**
 * Cursor on the Cost screen (ADR-095), in Cursor's own terms:
 *
 * - the cost Cursor recorded per chat and model — Cursor keeps one for some
 *   chats and none for others, and a chat with none is shown with its
 *   tokens and no price rather than one from Caprock's table;
 * - what Cursor sends beyond what was typed, per model, beside Claude
 *   Code's first request for the same model where there is one — an
 *   estimate, with how it is read;
 * - the switch for Cursor's hooks, which is how Caprock sees cursor-agent
 *   chats, installed only on this click.
 *
 * Rendered when the range has Cursor turns, or the machine has Cursor.
 */
export function CursorSpendPanel({ c, range, present }: { c?: CursorCost; range: string; present: boolean }) {
  const overhead = useApi(() => api.cursorOverhead(range), [range], { active: present || !!c })
  if (!c && !present) return null
  const models = (c?.models ?? []).filter((m) => m.cost_usd > 0 || m.tokens > 0)
  const rows = overheadRows(overhead.data)
  return (
    <Panel
      fold="cost.cursor"
      share={`Cursor · ${range}`}
      title={<span className="inline-flex items-center gap-1.5"><AgentGlyph agent="cursor" />Cursor · {range}</span>}
      right={<span title="Cursor records a cost per chat and model for some chats; Caprock shows it as recorded">Cursor's own figures</span>}
    >
      {c ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-border">
          <Stat label="Cursor recorded" value={fmtUSD(c.total_usd)} sub="inside the total above" />
          <Stat label="Requests" value={c.requests.toLocaleString('en-US')} sub="as Cursor counted them" />
          <Stat
            label="Chats with a cost"
            value={`${c.priced_chats} of ${c.chats}`}
            hint="Cursor writes a cost into a chat's record for some chats and not others. A chat without one is shown with its tokens and no price: Caprock does not put its own table's figure beside Cursor's."
          />
          <Stat
            label="Tokens, no cost"
            value={fmtTokens(c.unpriced_tokens)}
            sub={doesntRecord('Cursor', 'a cost for these chats')}
            hint="Cursor writes one request's tokens per turn — the turn's last — so Cursor's token counts are a floor, not every request's."
          />
        </div>
      ) : (
        <p className="mx-3 my-2.5 text-[12px] text-fg-muted">No Cursor turns in this range.</p>
      )}
      {models.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-fg-faint text-left">
                <th className="px-3 py-1 font-normal">Cursor model</th>
                <th className="px-3 py-1 font-normal text-right">Requests</th>
                <th className="px-3 py-1 font-normal text-right">Tokens</th>
                <th className="px-3 py-1 font-normal text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.model} className="border-t border-border">
                  <td className="px-3 py-1 font-mono">{m.model || 'unknown'}</td>
                  <td className="px-3 py-1 text-right tabular-nums">{m.requests ? m.requests.toLocaleString('en-US') : '—'}</td>
                  <td className="px-3 py-1 text-right tabular-nums">{m.tokens ? fmtTokens(m.tokens) : '—'}</td>
                  <td className="px-3 py-1 text-right tabular-nums">{m.cost_usd > 0 ? fmtUSD(m.cost_usd) : <span className="text-fg-faint" title={m.priced ? "Cursor recorded a cost for these chats, but none under this model's name" : doesntRecord('Cursor', 'a cost for the chats this model was in')}>{m.priced ? 'not itemised' : 'none recorded'}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <OverheadTable rows={rows} method={overhead.data?.method} />
      <CursorHooks />
    </Panel>
  )
}

/** What Cursor sends beyond what was typed, beside Claude Code's first request. */
function OverheadTable({ rows, method }: { rows: ReturnType<typeof overheadRows>; method?: string }) {
  if (rows.length === 0) return null
  return (
    <div className="mt-1 border-t border-border">
      <div className="px-3 pt-2 text-[12px] text-fg-muted">
        Beyond what you type, per request — <span className="text-fg-faint">estimate, median of the first request in each chat</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-fg-faint text-left">
              <th className="px-3 py-1 font-normal">Model</th>
              <th className="px-3 py-1 font-normal text-right">Cursor adds</th>
              <th className="py-1 pr-3 font-normal text-right">chats</th>
              <th className="border-l border-border px-3 py-1 font-normal text-right">Claude Code adds</th>
              <th className="py-1 pr-3 font-normal text-right">sessions</th>
              <th className="border-l border-border px-3 py-1 font-normal text-right" title="Cursor's figure at the model's list input rate">At list price</th>
              <th className="py-1 pr-3 font-normal text-right" title="Cursor's figure at the model's cache-read rate">cached</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.family} className="border-t border-border">
                <td className="px-3 py-1 font-mono" title={[...(r.cursor?.models ?? []), ...(r.claude?.models ?? [])].join(', ')}>{r.family || 'unknown'}</td>
                <td className="px-3 py-1 text-right tabular-nums" title={r.cursor && r.cursor.clean > 0 ? `smallest ${fmtTokens(r.cursor.min_tokens)}` : undefined}>
                  {overheadCell(r.cursor)}
                </td>
                <td className="py-1 pr-3 text-right tabular-nums text-fg-faint">{samplesCount(r.cursor)}</td>
                <td className="border-l border-border px-3 py-1 text-right tabular-nums" title={r.claude ? `smallest ${fmtTokens(r.claude.min_tokens)}` : undefined}>
                  {overheadCell(r.claude)}
                </td>
                <td className="py-1 pr-3 text-right tabular-nums text-fg-faint">{samplesCount(r.claude)}</td>
                <td className="border-l border-border px-3 py-1 text-right tabular-nums text-fg-muted">
                  {r.cursor && r.cursor.clean > 0 && r.input !== undefined ? fmtUSD(atRate(r.cursor.median_tokens, r.input)) : '—'}
                </td>
                <td className="py-1 pr-3 text-right tabular-nums text-fg-faint">
                  {r.cursor && r.cursor.clean > 0 && r.input !== undefined ? fmtUSD(atRate(r.cursor.median_tokens, r.cacheRead ?? 0)) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {method && <p className="mx-3 mb-2.5 mt-1 text-[11px] text-fg-faint">{method}</p>}
    </div>
  )
}

/** The switch for Cursor's hooks: the way Caprock sees cursor-agent chats. */
/** How many events Caprock registers in Cursor's hooks.json
 *  (internal/cursor/hooks.go HookEvents). */
const CURSOR_HOOK_EVENTS = 12

/** Whether Caprock's Cursor hooks are on: all of them, some (an install
 *  from before the observational ones were added), or none. */
export function hooksState(h: Pick<CursorHooksStatus, 'installed' | 'missing'>): 'on' | 'partly' | 'off' {
  if (h.installed) return 'on'
  return (h.missing?.length ?? CURSOR_HOOK_EVENTS) < CURSOR_HOOK_EVENTS ? 'partly' : 'off'
}

function CursorHooks() {
  const st = useApi(() => api.cursorHooks(), [], { intervalMs: 0 })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [now, setNow] = useState<CursorHooksStatus | undefined>()
  const h = now ?? st.data
  if (!h) return null
  const act = async (action: 'install' | 'uninstall') => {
    setBusy(true)
    setErr('')
    try {
      setNow(await api.setCursorHooks(action))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  // An install from before the observational hooks were added holds some
  // of them: it is on, and pressing the button again adds the rest.
  const partial = hooksState(h) === 'partly'
  return (
    <div className="mx-3 mb-2.5 mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-border pt-2 text-[12px] text-fg-muted">
      <span>
        {h.installed ? 'Cursor hooks are on: ' : partial ? 'Cursor hooks are partly on: ' : 'Cursor hooks are off: '}
        {h.installed
          ? 'cursor-agent chats show here as they run.'
          : partial
            ? `${h.missing?.length} newer events are not added yet (a chat's start and end, subagents, shell output, file edits).`
            : 'turn them on to see cursor-agent chats here. Editor chats are read without them.'}
        <span className="text-fg-faint">
          {' '}{h.installed ? 'Caprock is in' : 'Adds Caprock to'} {h.path} for twelve events that decide nothing{h.others > 0 ? `, beside the ${h.others} ${h.others === 1 ? 'entry' : 'entries'} already there` : ''}. Nothing leaves this machine.
        </span>
      </span>
      <button type="button" className="rounded-[6px] border border-border px-2.5 py-1 text-[12px] text-fg hover:text-accent disabled:opacity-50 disabled:hover:text-fg" disabled={busy} onClick={() => act(h.installed ? 'uninstall' : 'install')}>
        {h.installed ? 'Remove Cursor hooks' : partial ? 'Add the newer Cursor hooks' : 'Turn on Cursor hooks'}
      </button>
      {err && <span className="text-warn">{err}</span>}
    </div>
  )
}
