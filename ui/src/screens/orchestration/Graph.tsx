/**
 * SVG renderer for the orchestration graph. Presentational: takes the model +
 * geometry and draws the orchestrator center, fixed worker spokes, verify gates,
 * worker nodes, and task dots at their resting positions. Colors come straight
 * from the theme CSS vars, so light/dark work for free. No motion here — the
 * traveling-dot animation lands in a later commit; this is the correct static
 * frame everything animates around.
 */
import { geometry, phaseT, pointOnSpoke, ringPositions, type Geometry, type NodePos, type Viewport } from './layout'
import { ORCHESTRATOR, tasksByWorker, type GraphModel, type GraphTask } from './useGraphModel'

// Map a task status to a theme color var. done = the "verified" green (the money
// shot); needs_you = amber (waiting on you); failed = red; in-flight = accent.
export function statusColor(status: string): string {
  switch (status) {
    case 'done':
      return 'var(--color-ok)'
    case 'needs_you':
      return 'var(--color-warn)'
    case 'failed':
      return 'var(--color-danger)'
    case 'verifying':
    case 'in_progress':
    case 'assigned':
      return 'var(--color-accent)'
    default:
      return 'var(--color-fg-muted)'
  }
}

// A worker is "busy" if any of its tasks is still in flight (not done/failed).
function workerBusy(tasks: GraphTask[]): boolean {
  return tasks.some((t) => t.status !== 'done' && t.status !== 'failed')
}

export function Graph({ model, viewport, centerLabel = 'orchestrator' }: {
  model: GraphModel
  viewport: Viewport
  centerLabel?: string
}) {
  const g: Geometry = geometry(viewport)
  const nodes = ringPositions(model.registry, model.workers, g)
  const byWorker = tasksByWorker(model)

  return (
    <svg width={viewport.width} height={viewport.height} className="block" role="img" aria-label="orchestration graph">
      {/* Spokes (fixed edges) + verify gates — drawn first, under the nodes. */}
      {nodes.map((n) => (
        <Spoke key={`spoke-${n.id}`} node={n} g={g} />
      ))}

      {/* Task dots at their resting positions along each worker's spoke. */}
      {nodes.map((n) => (byWorker.get(n.id) ?? []).map((t, i) => {
        const p = pointOnSpoke(n, g, phaseT(t.status))
        // Fan multiple dots on the same spoke slightly so they don't overlap.
        const off = (i - ((byWorker.get(n.id)!.length - 1) / 2)) * 9
        const nx = -(n.y - g.cy)
        const ny = n.x - g.cx
        const len = Math.hypot(nx, ny) || 1
        return (
          <circle
            key={`task-${t.id}`}
            cx={p.x + (nx / len) * off}
            cy={p.y + (ny / len) * off}
            r={5}
            fill={statusColor(t.status)}
          >
            <title>{`${t.title} · ${t.status}`}</title>
          </circle>
        )
      }))}

      {/* Worker nodes on the ring. */}
      {nodes.map((n) => {
        const tasks = byWorker.get(n.id) ?? []
        const busy = workerBusy(tasks)
        return (
          <g key={`node-${n.id}`} transform={`translate(${n.x},${n.y})`}>
            <circle r={g.nodeR} fill="var(--color-panel)" stroke={busy ? 'var(--color-accent)' : 'var(--color-border-strong)'} strokeWidth={busy ? 2 : 1.5} />
            <text textAnchor="middle" dy="0.32em" fontSize="10" fill="var(--color-fg-muted)" className="mono">{shortWorker(n.id)}</text>
          </g>
        )
      })}

      {/* Orchestrator center node — pinned, on top. */}
      <g transform={`translate(${g.cx},${g.cy})`}>
        <circle r={g.nodeR + 6} fill="var(--color-panel-2)" stroke="var(--color-accent)" strokeWidth={2} />
        <text textAnchor="middle" dy="0.32em" fontSize="10" fill="var(--color-fg)" className="mono">{centerLabel === ORCHESTRATOR ? 'orch' : centerLabel}</text>
      </g>
    </svg>
  )
}

function Spoke({ node, g }: { node: NodePos; g: Geometry }) {
  const gate = pointOnSpoke(node, g, g.gateT)
  return (
    <g>
      <line x1={g.cx} y1={g.cy} x2={node.x} y2={node.y} stroke="var(--color-border)" strokeWidth={1.5} />
      {/* verify gate — a small diamond checkpoint on the spoke */}
      <rect
        x={gate.x - 4}
        y={gate.y - 4}
        width={8}
        height={8}
        transform={`rotate(45 ${gate.x} ${gate.y})`}
        fill="var(--color-bg)"
        stroke="var(--color-border-strong)"
        strokeWidth={1.5}
      >
        <title>verify gate — a task turns green only after its tests pass</title>
      </rect>
    </g>
  )
}

// shortWorker turns "worker-3" into "w3", "verifier" into "vfy", else first 4.
function shortWorker(id: string): string {
  const m = /^worker-(\d+)$/.exec(id)
  if (m) return `w${m[1]}`
  if (id === 'verifier') return 'vfy'
  return id.slice(0, 4)
}
