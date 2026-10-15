import { describe, expect, it } from 'vitest'
import { dotRadius, linkShape } from './BrainGraphCanvas'

describe('the knowledge-graph look', () => {
  it('draws every memory as the same tiny dot, and a hub a little bigger with its links, capped', () => {
    const mem = dotRadius({ kind: 'decision', degree: 1, pinned: false })
    expect(dotRadius({ kind: 'finding', degree: 9, pinned: false })).toBe(mem)
    expect(mem * 2).toBeLessThanOrEqual(4)
    const topic = dotRadius({ kind: 'topic', degree: 4, pinned: false })
    expect(topic).toBeGreaterThan(mem)
    expect(dotRadius({ kind: 'topic', degree: 30, pinned: false })).toBeGreaterThan(topic)
    expect(dotRadius({ kind: 'project', degree: 4, pinned: false })).toBeGreaterThan(topic)
    expect(dotRadius({ kind: 'project', degree: 5000, pinned: false })).toBeLessThanOrEqual(6.5)
  })

  it('ties a memory loosely to its project and tightly to its topics, so topics burst and projects are regions', () => {
    const project = linkShape('decision', 'project')
    const topic = linkShape('topic', 'idea')
    const memory = linkShape('idea', 'finding')
    expect(project.w).toBeLessThan(memory.w)
    expect(memory.w).toBeLessThan(topic.w)
    expect(topic.d).toBeLessThan(memory.d)
    expect(memory.d).toBeLessThan(project.d)
  })
})
