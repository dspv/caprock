/**
 * Live Orchestration Graph — the "wow" view (Phase 3 delight). A fixed radial
 * layout: the orchestrator pinned dead-center, workers on a stable ring, and
 * tasks flowing along fixed edges through a verify gate that turns green only
 * after the tests pass. Driven by the same live event stream as the rest of the
 * dashboard. Never force-directed; nodes never reshuffle.
 */
import { useEffect, useRef, useState } from 'react'
import { Graph, SessionRing, type RingSession } from './orchestration/Graph'
import { hasOrchestration, useGraphModel } from './orchestration/useGraphModel'
import type { Viewport } from './orchestration/layout'
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { shortId } from '@/lib/format'

export function OrchestrationScreen() {
  const model = useGraphModel()
  const sessionsQ = useApi(() => api.sessions(true), [], { intervalMs: 4000 })
  const host = useRef<HTMLDivElement>(null)
  const [vp, setVp] = useState<Viewport>({ width: 900, height: 560 })

  // Track the container size — geometry only recomputes on resize, never on data.
  useEffect(() => {
    if (!host.current) return
    const el = host.current
    const ro = new ResizeObserver(() => {
      setVp({ width: el.clientWidth, height: Math.max(420, el.clientHeight) })
    })
    ro.observe(el)
    setVp({ width: el.clientWidth, height: Math.max(420, el.clientHeight) })
    return () => ro.disconnect()
  }, [])

  const live = hasOrchestration(model)
  const ringSessions: RingSession[] = (sessionsQ.data ?? [])
    .filter((s) => s.status !== 'ended')
    .map((s) => ({ id: s.session_id, label: shortId(s.session_id), health: s.activity.health }))

  // The headline: what this screen is actually claiming, in numbers.
  const tasks = Array.from(model.tasks.values())
  const verified = tasks.filter((t) => t.status === 'done').length
  const inFlight = tasks.filter((t) => ['assigned', 'in_progress', 'verifying'].includes(t.status)).length

  return (
    <div className="grid gap-2">
      {live && (
        <div className="flex items-baseline gap-6 border border-border bg-panel rounded-[var(--radius-panel)] px-4 py-3">
          <span className="flex items-baseline gap-2">
            <span className="num text-2xl text-ok">{verified}</span>
            <span className="text-[12px] text-fg-muted">verified — tests passed, not just claimed</span>
          </span>
          <span className="flex items-baseline gap-2">
            <span className="num text-2xl text-accent">{inFlight}</span>
            <span className="text-[12px] text-fg-muted">in flight</span>
          </span>
          <span className="flex items-baseline gap-2">
            <span className="num text-2xl text-fg">{model.workers.size}</span>
            <span className="text-[12px] text-fg-muted">workers</span>
          </span>
        </div>
      )}
      <div className="flex items-center gap-2 text-[11px] text-fg-faint px-0.5">
        <Legend orchestration={live} />
        <span className="ml-auto">
          {live ? (
            'live · the orchestrator assigns work; a task turns green only after its tests pass'
          ) : (
            <>your live sessions — start an orchestrator with <span className="mono text-fg-muted">caprock up --hive &lt;dir&gt;</span> to see the verified team</>
          )}
        </span>
      </div>
      <div ref={host} className="relative w-full h-[70vh] rounded-[var(--radius-panel)] border border-border bg-panel/40 overflow-hidden">
        {live ? <Graph model={model} viewport={vp} /> : <SessionRing sessions={ringSessions} viewport={vp} />}
      </div>
    </div>
  )
}

function Legend({ orchestration }: { orchestration: boolean }) {
  const item = (color: string, label: string) => (
    <span className="inline-flex items-center gap-1">
      <span className="inline-block w-2 h-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
  return (
    <span className="inline-flex items-center gap-3">
      {orchestration ? (
        <>
          {item('var(--color-accent)', 'in flight')}
          {item('var(--color-ok)', 'verified')}
          {item('var(--color-warn)', 'needs you')}
          {item('var(--color-danger)', 'failed')}
        </>
      ) : (
        <>
          {item('var(--color-ok)', 'working')}
          {item('var(--color-warn)', 'waiting on you')}
          {item('var(--color-danger)', 'loop / error')}
          {item('var(--color-fg-muted)', 'idle')}
        </>
      )}
    </span>
  )
}
