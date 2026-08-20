/**
 * SVG renderer for the orchestration graph. Presentational: takes the model +
 * geometry and draws the orchestrator center, fixed worker spokes, verify gates,
 * worker nodes, and task dots at their resting positions. Colors come straight
 * from the theme CSS vars, so light/dark work for free. No motion here — the
 * traveling-dot animation lands in a later commit; this is the correct static
 * frame everything animates around.
 */
import { useEffect, useRef, useState } from 'react'
import { geometry, phaseT, pointOnSpoke, ringPositions, type Geometry, type NodePos, type Viewport } from './layout'
import { ORCHESTRATOR, tasksByWorker, type GraphModel, type GraphTask } from './useGraphModel'
import { DotMotion, startTicker } from './anim'

// useDotMotion runs one rAF loop that damps every task dot's t toward its
// status target, re-rendering only while something is moving (it idles when all
// dots have settled). Returns a getter for the current animated t of a task.
function useDotMotion(model: GraphModel): (id: string, status: string) => number {
  const motion = useRef(new DotMotion())
  const [, force] = useState(0)
  // Feed targets whenever the model changes.
  const alive = new Set(model.tasks.keys())
  for (const t of model.tasks.values()) motion.current.setTarget(t.id, phaseT(t.status))
  useEffect(() => {
    const ticker = startTicker((dt) => {
      const moving = motion.current.step(dt, alive)
      if (moving) force((v) => v + 1)
    })
    return () => ticker.stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (id, status) => motion.current.get(id) ?? phaseT(status)
}

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
  const tOf = useDotMotion(model)

  return (
    <svg width={viewport.width} height={viewport.height} className="block" role="img" aria-label="orchestration graph">
      {/* Spokes (fixed edges) + verify gates — drawn first, under the nodes. */}
      {nodes.map((n) => (
        <Spoke key={`spoke-${n.id}`} node={n} g={g} gateStatus={gateStatusFor(byWorker.get(n.id) ?? [])} />
      ))}

      {/* Task dots — glide along their spoke as status advances (damped rAF). */}
      {nodes.map((n) => (byWorker.get(n.id) ?? []).map((t, i) => {
        const p = pointOnSpoke(n, g, tOf(t.id, t.status))
        // Fan multiple dots on the same spoke slightly so they don't overlap.
        const off = (i - ((byWorker.get(n.id)!.length - 1) / 2)) * 9
        const nx = -(n.y - g.cy)
        const ny = n.x - g.cx
        const len = Math.hypot(nx, ny) || 1
        return (
          <TaskDot
            key={`task-${t.id}`}
            task={t}
            cx={p.x + (nx / len) * off}
            cy={p.y + (ny / len) * off}
          />
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

// TaskDot renders one task dot and fires the "verified" pop exactly on the
// verifying→done transition (the money shot). Color transitions smoothly via CSS
// (.graph-dot); the pop is a one-shot class we add for the animation duration.
function TaskDot({ task, cx, cy }: { task: GraphTask; cx: number; cy: number }) {
  const prev = useRef(task.status)
  const [pop, setPop] = useState(false)
  useEffect(() => {
    if (prev.current !== 'done' && task.status === 'done') {
      setPop(true)
      const id = setTimeout(() => setPop(false), 600)
      prev.current = task.status
      return () => clearTimeout(id)
    }
    prev.current = task.status
  }, [task.status])
  return (
    <circle
      className={`graph-dot${pop ? ' graph-verified' : ''}`}
      cx={cx}
      cy={cy}
      r={5}
      fill={statusColor(task.status)}
    >
      <title>{`${task.title} · ${task.status}`}</title>
    </circle>
  )
}

// gateStatusFor summarizes a worker's tasks into the gate's state: a passed task
// makes the gate green, a task at the gate makes it accent, else neutral.
export function gateStatusFor(tasks: GraphTask[]): 'done' | 'verifying' | 'idle' {
  if (tasks.some((t) => t.status === 'done')) return 'done'
  if (tasks.some((t) => t.status === 'verifying')) return 'verifying'
  return 'idle'
}

function Spoke({ node, g, gateStatus }: { node: NodePos; g: Geometry; gateStatus: 'done' | 'verifying' | 'idle' }) {
  const gate = pointOnSpoke(node, g, g.gateT)
  const fill = gateStatus === 'done' ? 'var(--color-ok)' : gateStatus === 'verifying' ? 'var(--color-accent)' : 'var(--color-bg)'
  const stroke = gateStatus === 'done' ? 'var(--color-ok)' : gateStatus === 'verifying' ? 'var(--color-accent)' : 'var(--color-border-strong)'
  return (
    <g>
      <line x1={g.cx} y1={g.cy} x2={node.x} y2={node.y} stroke="var(--color-border)" strokeWidth={1.5} />
      {/* verify gate — a small diamond checkpoint on the spoke; green once passed */}
      <rect
        className="graph-gate"
        x={gate.x - 4}
        y={gate.y - 4}
        width={8}
        height={8}
        transform={`rotate(45 ${gate.x} ${gate.y})`}
        fill={fill}
        stroke={stroke}
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
