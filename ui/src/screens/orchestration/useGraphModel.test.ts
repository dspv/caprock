import { describe, expect, it } from 'vitest'
import { applyTask, buildFromSnapshot, emptyModel, hasOrchestration, tasksByWorker, ORCHESTRATOR, VERIFIER, type GraphTask } from './useGraphModel'
import type { Task } from '@/lib/api'

const T = (id: string, assignee: string, status: string): GraphTask => ({ id, title: id, assignee, status })

function row(id: string, assignee: string, status: string): Task {
  return { id, title: id, status, assignee, budget_usd: 0, verify_rounds: 0, cost_usd: 0, created_at: 0, updated_at: 0 }
}

describe('useGraphModel reducer', () => {
  it('adds workers to the registry sorted, and grows it monotonically', () => {
    let m = emptyModel()
    m = applyTask(m, T('t1', 'worker-2', 'assigned'))
    m = applyTask(m, T('t2', 'worker-1', 'assigned'))
    expect(m.registry).toEqual(['worker-1', 'worker-2']) // sorted
  })

  it('keeps a finished worker in the registry (no slot vacate)', () => {
    let m = emptyModel()
    m = applyTask(m, T('t1', 'worker-1', 'in_progress'))
    m = applyTask(m, T('t1', 'worker-1', 'done'))
    // Even though its task is done, the worker stays registered — its slot holds.
    expect(m.registry).toContain('worker-1')
    expect(m.workers.has('worker-1')).toBe(true)
  })

  it('drives a task through the full lifecycle to the verified (done) state', () => {
    let m = emptyModel()
    for (const s of ['inbox', 'assigned', 'in_progress', 'verifying', 'done']) {
      m = applyTask(m, T('t1', 'worker-1', s))
    }
    expect(m.tasks.get('t1')!.status).toBe('done')
  })

  it('renders needs_you and failed calmly (kept, not dropped)', () => {
    let m = emptyModel()
    m = applyTask(m, T('t1', 'worker-1', 'needs_you'))
    m = applyTask(m, T('t2', 'worker-2', 'failed'))
    expect(m.tasks.get('t1')!.status).toBe('needs_you')
    expect(m.tasks.get('t2')!.status).toBe('failed')
  })

  it('does not treat orchestrator/verifier/empty as worker nodes', () => {
    let m = emptyModel()
    m = applyTask(m, T('t1', ORCHESTRATOR, 'assigned'))
    m = applyTask(m, T('t2', VERIFIER, 'verifying'))
    m = applyTask(m, T('t3', '', 'inbox'))
    expect(m.workers.size).toBe(0)
    expect(m.registry).toEqual([])
  })

  it('builds from a snapshot and preserves a prior registry across refetches', () => {
    const first = buildFromSnapshot([row('t1', 'worker-1', 'done'), row('t2', 'worker-2', 'in_progress')])
    expect(first.registry).toEqual(['worker-1', 'worker-2'])
    // A later snapshot momentarily omits worker-1's task — its slot must survive.
    const second = buildFromSnapshot([row('t2', 'worker-2', 'verifying')], first.registry)
    expect(second.registry).toContain('worker-1')
  })

  it('hasOrchestration and tasksByWorker reflect the current tasks', () => {
    let m = emptyModel()
    expect(hasOrchestration(m)).toBe(false)
    m = applyTask(m, T('t1', 'worker-1', 'in_progress'))
    m = applyTask(m, T('t2', 'worker-1', 'done'))
    expect(hasOrchestration(m)).toBe(true)
    const byWorker = tasksByWorker(m)
    expect(byWorker.get('worker-1')!.length).toBe(2)
  })
})
