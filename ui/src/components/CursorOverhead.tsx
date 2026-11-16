import { api, type SessionOverhead } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtTokens } from '@/lib/format'
import { Panel } from '@/components/ui'

/** The sentence for one chat's estimate, as plain parts so it is tested. */
export function overheadSentence(o: SessionOverhead): { lead: string; parts: string[]; compare?: string } {
  const lead = `Cursor's first measured request was ${fmtTokens(o.request_tokens)} tokens; about ${fmtTokens(Math.max(0, o.overhead_tokens))} of it was not the conversation.`
  const parts = [
    `you typed ~${fmtTokens(o.typed_tokens)}`,
    `the conversation before it ~${fmtTokens(o.visible_tokens)}`,
  ]
  // Older chats name no model calls; a count of none would read as a fact.
  if (o.model_calls > 0) parts.push(`${o.model_calls} model ${o.model_calls === 1 ? 'call' : 'calls'} in that turn`)
  const fam = o.cursor_family
  const cc = o.claude_family
  let compare: string | undefined
  if (fam && fam.clean > 0) {
    compare = `Cursor's median for ${o.family}: ~${fmtTokens(fam.median_tokens)} over ${fam.clean} ${fam.clean === 1 ? 'chat' : 'chats'}`
    if (cc && cc.clean > 0) compare += `; Claude Code's first request for the same model: ~${fmtTokens(cc.median_tokens)} over ${cc.clean} ${cc.clean === 1 ? 'session' : 'sessions'}`
    compare += ' (last 90 days).'
  }
  return { lead, parts, compare }
}

/**
 * What Cursor added to this chat's first request beyond the words in it — its
 * system prompt, tool definitions, rules and the context it attached itself
 * (ADR-095). An estimate, said as one, with how it is read on hover. Shown on
 * a Cursor chat that has one.
 */
export function CursorOverheadPanel({ sessionId, className = '' }: { sessionId: string; className?: string }) {
  const o = useApi(() => api.sessionOverhead(sessionId), [sessionId], { live: false })
  if (!o.data) return null
  const s = overheadSentence(o.data)
  return (
    <Panel className={className}>
      <div className="px-3 py-2 text-[12.5px] text-fg-muted" title={o.data.method}>
        <span className="text-fg">{s.lead}</span>{' '}
        <span className="text-fg-faint">
          Estimate: {s.parts.join(' · ')}{o.data.clean ? '' : ' — a long first turn, so this one is not counted in the medians'}.
        </span>
        {s.compare && <div className="mt-0.5 text-fg-faint">{s.compare}</div>}
      </div>
    </Panel>
  )
}
