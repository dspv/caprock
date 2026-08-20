import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Graph, SessionRing, gateStatusFor, healthColor, statusColor } from './Graph'
import { applyTask, emptyModel, type GraphTask } from './useGraphModel'

const T = (id: string, assignee: string, status: string): GraphTask => ({ id, title: id, assignee, status })

describe('orchestration Graph', () => {
  it('maps status to the theme color vars (done = verified green)', () => {
    expect(statusColor('done')).toBe('var(--color-ok)')
    expect(statusColor('needs_you')).toBe('var(--color-warn)')
    expect(statusColor('failed')).toBe('var(--color-danger)')
    expect(statusColor('in_progress')).toBe('var(--color-accent)')
  })

  it('summarizes a spoke gate: passed > verifying > idle', () => {
    expect(gateStatusFor([T('a', 'w1', 'done'), T('b', 'w1', 'in_progress')])).toBe('done')
    expect(gateStatusFor([T('a', 'w1', 'verifying')])).toBe('verifying')
    expect(gateStatusFor([T('a', 'w1', 'in_progress')])).toBe('idle')
    expect(gateStatusFor([])).toBe('idle')
  })

  it('renders nodes, spokes with verify gates, and task dots', () => {
    let m = emptyModel()
    m = applyTask(m, T('t1', 'worker-1', 'done'))
    m = applyTask(m, T('t2', 'worker-2', 'verifying'))
    const { container } = render(<Graph model={m} viewport={{ width: 800, height: 600 }} />)
    // worker nodes + center + gates + dots all exist
    expect(container.querySelectorAll('.graph-dot').length).toBe(2)
    expect(container.querySelectorAll('.graph-gate').length).toBeGreaterThanOrEqual(2)
    // the done task's gate is the verified green
    const gates = Array.from(container.querySelectorAll('.graph-gate')) as SVGRectElement[]
    expect(gates.some((g) => g.getAttribute('fill') === 'var(--color-ok)')).toBe(true)
  })

  // The money shot: a task at verifying, then done, colors green. (The one-shot
  // pop class is timer-driven; here we assert the steady-state verified color,
  // which is the durable, deterministic signal.)
  it('colors a task dot green once it reaches done', () => {
    let m = emptyModel()
    m = applyTask(m, T('t1', 'worker-1', 'done'))
    const { container } = render(<Graph model={m} viewport={{ width: 800, height: 600 }} />)
    const dot = container.querySelector('.graph-dot') as SVGCircleElement
    expect(dot.getAttribute('fill')).toBe('var(--color-ok)')
  })
})

describe('SessionRing (empty-state)', () => {
  it('maps session health to colors', () => {
    expect(healthColor('working')).toBe('var(--color-ok)')
    expect(healthColor('waiting-on-you')).toBe('var(--color-warn)')
    expect(healthColor('looping')).toBe('var(--color-danger)')
    expect(healthColor('idle')).toBe('var(--color-fg-muted)')
  })

  it('renders a node per session plus the caprock hub, never blank', () => {
    const sessions = [
      { id: 's1', label: 's1', health: 'working' },
      { id: 's2', label: 's2', health: 'idle' },
    ]
    const { container } = render(<SessionRing sessions={sessions} viewport={{ width: 800, height: 600 }} />)
    const circles = container.querySelectorAll('circle')
    // 2 session nodes + 1 hub = 3
    expect(circles.length).toBe(3)
    // the working session's ring is the ok color
    expect(Array.from(circles).some((c) => c.getAttribute('stroke') === 'var(--color-ok)')).toBe(true)
  })

  it('renders the hub even with zero sessions (never blank)', () => {
    const { container } = render(<SessionRing sessions={[]} viewport={{ width: 800, height: 600 }} />)
    expect(container.querySelectorAll('circle').length).toBe(1) // just the hub
  })
})
