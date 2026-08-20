/**
 * Projects — per-repo spend, the first thing a user recognises as their own
 * money. Cost per project already existed in the summary but was buried in
 * History; this puts it on the landing screen, answering both halves of the
 * real question: what does this repo cost, and who is working in it right now.
 *
 * Every number here is measured from captured events at API list price — never
 * modelled, never extrapolated (rule 6).
 */
import { useState } from 'react'
import { api, type ProjectShare, type SessionSummary } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtTokens, fmtUSD } from '@/lib/format'
import { Panel, Skeleton } from '@/components/ui'

type Range = 'today' | '7d' | '30d' | 'all'

const RANGES: { key: Range; label: string }[] = [
  { key: 'today', label: 'today' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: 'all', label: 'all' },
]

export function ProjectsPanel({ sessions }: { sessions: SessionSummary[] }) {
  // 30d is the default: "today" is near-empty most mornings and would make the
  // panel look broken on first open, which is exactly the wrong first impression.
  const [range, setRange] = useState<Range>('30d')
  const [expanded, setExpanded] = useState(false)
  const summary = useApi(() => api.summary(range), [range], { intervalMs: 30000 })

  const all = summary.data?.projects ?? []
  const total = all.reduce((sum, p) => sum + p.cost_usd, 0)
  const shown = expanded ? all : all.slice(0, 6)

  // Projects with a session that is live right now — the "who is in it" signal.
  const liveProjects = new Set(
    sessions.filter((s) => s.status !== 'ended').map((s) => s.project).filter(Boolean),
  )

  return (
    <Panel
      title="Projects"
      right={
        <span className="flex items-center gap-2">
          <span className="num text-fg text-[13px]">{fmtUSD(total)} total</span>
          <span className="inline-flex border border-border rounded-sm overflow-hidden">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className={`px-1.5 py-0.5 text-[11px] mono ${
                  range === r.key ? 'bg-panel-2 text-fg' : 'text-fg-faint hover:text-fg-muted'
                }`}
              >
                {r.label}
              </button>
            ))}
          </span>
        </span>
      }
    >
      {!summary.data ? (
        <Skeleton rows={5} />
      ) : all.length === 0 ? (
        <div className="px-3 py-4 text-[12px] text-fg-muted">
          No spend captured in this range yet.
        </div>
      ) : (
        <div className="grid">
          {shown.map((p) => (
            <ProjectRow key={p.project || '(unknown)'} p={p} max={all[0]!.cost_usd} live={liveProjects.has(p.project)} />
          ))}
          {all.length > 6 && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-[11px] text-fg-faint hover:text-fg-muted px-3 py-1.5 text-left border-t border-border"
            >
              {expanded ? 'show less' : `show all ${all.length} projects`}
            </button>
          )}
        </div>
      )}
    </Panel>
  )
}

function ProjectRow({ p, max, live }: { p: ProjectShare; max: number; live: boolean }) {
  // Bar is share-of-the-largest, so the top repo always fills the row and the
  // rest read as a proportion of it at a glance.
  const pct = max > 0 ? (100 * p.cost_usd) / max : 0
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-1.5 border-t border-border first:border-t-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {live && <span className="inline-block w-1.5 h-1.5 rounded-full bg-ok shrink-0" title="a session is live in this project" />}
          <span className="truncate text-[14px]">{p.project || 'unknown project'}</span>
          <span className="text-[11px] text-fg-faint num shrink-0">
            {p.sessions} {p.sessions === 1 ? 'session' : 'sessions'}
          </span>
        </div>
        <div className="h-1 mt-1 bg-panel-2 rounded-sm overflow-hidden">
          <div className="h-full bg-accent/70" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="num text-[17px] font-semibold leading-tight text-accent">{fmtUSD(p.cost_usd)}</div>
        <div className="num text-[11px] text-fg-faint">{fmtTokens(p.tokens)}</div>
      </div>
    </div>
  )
}
