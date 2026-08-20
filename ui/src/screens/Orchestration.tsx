/**
 * Live Orchestration Graph — the "wow" view (Phase 3 delight). A fixed radial
 * layout: the orchestrator pinned dead-center, workers on a stable ring, and
 * tasks flowing along fixed edges through a verify gate that turns green only
 * after the tests pass. Driven by the same live event stream as the rest of the
 * dashboard. Never force-directed; nodes never reshuffle.
 */
import { useEffect, useRef, useState } from 'react'
import { Graph } from './orchestration/Graph'
import { hasOrchestration, useGraphModel } from './orchestration/useGraphModel'
import type { Viewport } from './orchestration/layout'

export function OrchestrationScreen() {
  const model = useGraphModel()
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

  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2 text-[11px] text-fg-faint px-0.5">
        <Legend />
        <span className="ml-auto">
          {live
            ? 'live · the orchestrator assigns work; a task turns green only after its tests pass'
            : 'no orchestrator running — start one with '}
          {!live && <span className="mono text-fg-muted">caprock up --hive &lt;dir&gt;</span>}
        </span>
      </div>
      <div ref={host} className="relative w-full h-[70vh] rounded-[var(--radius-panel)] border border-border bg-panel/40 overflow-hidden">
        <Graph model={model} viewport={vp} />
      </div>
    </div>
  )
}

function Legend() {
  const item = (color: string, label: string) => (
    <span className="inline-flex items-center gap-1">
      <span className="inline-block w-2 h-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
  return (
    <span className="inline-flex items-center gap-3">
      {item('var(--color-accent)', 'in flight')}
      {item('var(--color-ok)', 'verified')}
      {item('var(--color-warn)', 'needs you')}
      {item('var(--color-danger)', 'failed')}
    </span>
  )
}
