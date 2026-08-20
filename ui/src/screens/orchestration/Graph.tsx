/**
 * SVG renderer for the orchestration graph. Draws the orchestrator center, fixed
 * worker spokes, verify gates, worker nodes, and task dots. Task dots glide along
 * their spoke via a damped rAF loop (anim.ts); the verify gate + dot turn the
 * "verified" green on verifying→done (the money shot); active nodes breathe.
 * Colors come from the theme CSS vars, so light/dark work for free. Also exports
 * SessionRing — the empty-state graph when no orchestrator is running.
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
        const off = (i - ((byWorker.get(n.id)!.length - 1) / 2)) * 12
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

      {/* Worker nodes on the ring, with what they're working on beside them. */}
      {nodes.map((n) => {
        const tasks = byWorker.get(n.id) ?? []
        const busy = workerBusy(tasks)
        // Put the caption on the outside of the ring so it never overlaps a spoke.
        const outward = n.x >= g.cx ? 1 : -1
        const anchor = outward === 1 ? 'start' : 'end'
        const lx = outward * (g.nodeR + 10)
        const current = tasks.find((t) => t.status !== 'done' && t.status !== 'failed') ?? tasks[0]
        return (
          <g key={`node-${n.id}`} transform={`translate(${n.x},${n.y})`}>
            <circle className={busy ? 'graph-breathe' : undefined} r={g.nodeR} fill="var(--color-panel)" stroke={busy ? 'var(--color-accent)' : 'var(--color-border-strong)'} strokeWidth={busy ? 2.5 : 1.5} />
            <text textAnchor="middle" dy="0.32em" fontSize="13" fill="var(--color-fg)" className="mono">{shortWorker(n.id)}</text>
            {current && (
              <>
                <text x={lx} y={-4} textAnchor={anchor} fontSize="12" fill="var(--color-fg)">{truncate(current.title, 26)}</text>
                <text x={lx} y={12} textAnchor={anchor} fontSize="11" fill={statusColor(current.status)} className="mono">
                  {statusLabel(current.status)}
                </text>
              </>
            )}
          </g>
        )
      })}

      {/* Orchestrator center node — pinned, on top. */}
      <g transform={`translate(${g.cx},${g.cy})`}>
        <circle r={g.nodeR + 6} fill="var(--color-panel-2)" stroke="var(--color-accent)" strokeWidth={2} />
        <text textAnchor="middle" dy="0.32em" fontSize="12" fill="var(--color-fg)" className="mono">{centerLabel === ORCHESTRATOR ? 'orch' : centerLabel}</text>
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
      r={8}
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
        x={gate.x - 7}
        y={gate.y - 7}
        width={14}
        height={14}
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

// statusLabel is the human phrase shown under a worker's current task, so the
// graph reads without a legend: you see what the agent is actually doing.
function statusLabel(status: string): string {
  switch (status) {
    case 'assigned': return 'assigned'
    case 'in_progress': return 'working…'
    case 'verifying': return 'running tests…'
    case 'done': return '✓ verified'
    case 'needs_you': return 'needs you'
    case 'failed': return 'failed'
    default: return status
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

// shortWorker turns "worker-3" into "w3", "verifier" into "vfy", else first 4.
function shortWorker(id: string): string {
  const m = /^worker-(\d+)$/.exec(id)
  if (m) return `w${m[1]}`
  if (id === 'verifier') return 'vfy'
  return id.slice(0, 4)
}

// healthColor maps a session's activity health to a theme color (reused from the
// Now screen's semantics) for the empty-state session ring.
export function healthColor(health: string): string {
  switch (health) {
    case 'working':
      return 'var(--color-ok)'
    case 'waiting-on-you':
      return 'var(--color-warn)'
    case 'looping':
    case 'error':
      return 'var(--color-danger)'
    case 'ended':
      return 'var(--color-fg-faint)'
    default:
      return 'var(--color-fg-muted)'
  }
}

export interface RingSession {
  id: string
  label: string
  health: string
}

// SessionRing is the empty-state graph: no orchestrator/hive, so hand-started
// sessions sit on the same ring around a neutral caprock hub. Never a blank
// screen. Uses the identical layout math for stable, jitter-free slots.
export function SessionRing({ sessions, viewport }: { sessions: RingSession[]; viewport: Viewport }) {
  const g: Geometry = geometry(viewport)
  const ids = sessions.map((s) => s.id).sort()
  const nodes = ringPositions(ids, new Set(ids), g)
  const byId = new Map(sessions.map((s) => [s.id, s]))
  return (
    <svg width={viewport.width} height={viewport.height} className="block" role="img" aria-label="session graph">
      {nodes.map((n) => (
        <line key={`edge-${n.id}`} x1={g.cx} y1={g.cy} x2={n.x} y2={n.y} stroke="var(--color-border)" strokeWidth={1.5} />
      ))}
      {nodes.map((n) => {
        const s = byId.get(n.id)!
        const color = healthColor(s.health)
        return (
          <g key={`sess-${n.id}`} transform={`translate(${n.x},${n.y})`}>
            <circle className={s.health === 'working' ? 'graph-breathe' : undefined} r={g.nodeR} fill="var(--color-panel)" stroke={color} strokeWidth={2} />
            <text textAnchor="middle" dy="0.32em" fontSize="9" fill="var(--color-fg-muted)" className="mono">{s.label}</text>
            <title>{`${s.label} · ${s.health}`}</title>
          </g>
        )
      })}
      <g transform={`translate(${g.cx},${g.cy})`}>
        <circle r={g.nodeR + 4} fill="var(--color-panel-2)" stroke="var(--color-border-strong)" strokeWidth={1.5} />
        <text textAnchor="middle" dy="0.32em" fontSize="10" fill="var(--color-fg-muted)" className="mono">caprock</text>
      </g>
    </svg>
  )
}
