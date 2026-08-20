/**
 * useGraphModel — the brain of the orchestration graph. Reduces the /v1/tasks
 * snapshot plus live "task" frames into a stable node/edge/task-in-flight model.
 * Pure derivation over a small persisted registry (worker slots) + task states;
 * no physics. Split into a pure reducer (unit-testable) and a thin React hook.
 */
import { useEffect, useRef, useState } from 'react'
import { api, type Task, type TaskFrame } from '@/lib/api'
import { live } from '@/lib/live'
import { useApi } from '@/lib/useApi'

// The reserved, well-known agent ids (mirror of the hive constants).
export const ORCHESTRATOR = 'orchestrator'
export const VERIFIER = 'verifier'

export interface GraphTask {
  id: string
  title: string
  assignee: string // the worker id this task lives on
  status: string // inbox|assigned|in_progress|verifying|needs_you|done|failed
}

export interface GraphModel {
  /** Every worker id ever seen, sorted — the stable slot registry (grows only). */
  registry: string[]
  /** Workers to render right now (had a task at some point this session). */
  workers: Set<string>
  /** Tasks keyed by id, at their current status. */
  tasks: Map<string, GraphTask>
}

function isWorker(assignee: string): boolean {
  return assignee !== '' && assignee !== ORCHESTRATOR && assignee !== VERIFIER
}

// applyTask folds one task's state (from snapshot or frame) into the model,
// growing the registry as new workers appear and never removing a worker (a
// finished worker fades to idle in place, keeping its slot — anti-jitter).
export function applyTask(model: GraphModel, t: GraphTask): GraphModel {
  const registry = model.registry.slice()
  const workers = new Set(model.workers)
  if (isWorker(t.assignee) && !registry.includes(t.assignee)) {
    registry.push(t.assignee)
    registry.sort()
  }
  if (isWorker(t.assignee)) workers.add(t.assignee)
  const tasks = new Map(model.tasks)
  tasks.set(t.id, t)
  return { registry, workers, tasks }
}

export function emptyModel(): GraphModel {
  return { registry: [], workers: new Set(), tasks: new Map() }
}

// buildFromSnapshot folds a full task list into a fresh model, preserving a prior
// registry so slots stay stable across refetches (a task list that momentarily
// omits a worker must not vacate its slot).
export function buildFromSnapshot(tasks: Task[], priorRegistry: string[] = []): GraphModel {
  let model: GraphModel = { registry: priorRegistry.slice(), workers: new Set(), tasks: new Map() }
  for (const t of tasks) {
    model = applyTask(model, { id: t.id, title: t.title, assignee: t.assignee, status: t.status })
  }
  return model
}

function frameToTask(f: TaskFrame): GraphTask {
  return { id: f.id, title: f.title, assignee: f.assignee, status: f.status }
}

/**
 * The hook: seeds from the /v1/tasks snapshot (refetched on tick), and applies
 * live "task" frames immediately for smooth animation. The registry is kept in a
 * ref so it survives refetches and frame order — slots never reshuffle.
 */
export function useGraphModel(): GraphModel {
  const tasksQ = useApi(() => api.tasks(), [], { intervalMs: 8000 })
  const registryRef = useRef<string[]>([])
  const [model, setModel] = useState<GraphModel>(emptyModel)

  // Rebuild from each snapshot, carrying the registry forward.
  useEffect(() => {
    if (!tasksQ.data) return
    const next = buildFromSnapshot(tasksQ.data, registryRef.current)
    registryRef.current = next.registry
    setModel(next)
  }, [tasksQ.data])

  // Apply live task frames without waiting for the next snapshot.
  useEffect(() => {
    return live.onFrame((f) => {
      if (f.type !== 'task') return
      setModel((m) => {
        const next = applyTask(m, frameToTask(f.data))
        registryRef.current = next.registry
        return next
      })
    })
  }, [])

  return model
}

// hasOrchestration is true when there is anything to render as a real graph
// (a worker with a task). Screens use it to choose the empty-state fallback.
export function hasOrchestration(model: GraphModel): boolean {
  return model.workers.size > 0 || model.tasks.size > 0
}

// tasksByWorker groups the current tasks under each worker for rendering dots.
export function tasksByWorker(model: GraphModel): Map<string, GraphTask[]> {
  const out = new Map<string, GraphTask[]>()
  for (const t of model.tasks.values()) {
    if (!isWorker(t.assignee)) continue
    const arr = out.get(t.assignee) ?? []
    arr.push(t)
    out.set(t.assignee, arr)
  }
  return out
}
