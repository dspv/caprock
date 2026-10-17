import { describe, expect, it } from 'vitest'
import type { BrainGraph, BrainNode } from './api'
import { entityView, indexGraph, OTHER_COLOR, pickNodes, PROJECT_COLORS } from './brainview'

const node = (p: Partial<BrainNode> & { id: number }): BrainNode => ({
  kind: 'decision', title: `memory ${p.id}`, summary: '', source: {}, manual: false, pinned: false, created_at: p.id * 1000, updated_at: 0, ...p,
})

// Two projects, one topic shared, one memory with no source project but a
// part_of link to a project node.
const graph: BrainGraph = {
  nodes: [
    node({ id: 1, title: 'Keep SQLite in WAL mode', source: { project: 'acme-api', session_id: 's1', ts: 1500 } }),
    node({ id: 2, title: 'Retry the queue', source: { project: 'acme-api', session_id: 's2', ts: 2500 } }),
    node({ id: 3, title: 'Café menu is cached', source: { project: 'web', session_id: 's3', ts: 3500 } }),
    node({ id: 4, title: 'Linked only by its project' }),
    node({ id: 10, kind: 'project', title: 'acme-api' }),
    node({ id: 11, kind: 'project', title: 'web' }),
    node({ id: 20, kind: 'topic', title: 'storage' }),
  ],
  edges: [
    { from: 1, to: 10, kind: 'part_of', weight: 1 },
    { from: 2, to: 10, kind: 'part_of', weight: 1 },
    { from: 3, to: 11, kind: 'part_of', weight: 1 },
    { from: 4, to: 10, kind: 'part_of', weight: 1 },
    { from: 1, to: 20, kind: 'part_of', weight: 1 },
    { from: 2, to: 20, kind: 'part_of', weight: 1 },
    { from: 3, to: 20, kind: 'part_of', weight: 1 },
    { from: 1, to: 99, kind: 'relates', weight: 1 },
  ],
  total: 4,
}

describe('indexGraph', () => {
  const idx = indexGraph(graph)
  it('counts what was read, and only links whose two ends were', () => {
    expect([idx.memories, idx.topics, idx.people, idx.links]).toEqual([4, 1, 0, 7])
  })
  it('gives every node a project: its source, its project link, or (a topic) where most of its memories are', () => {
    expect(idx.projectOf.get(1)).toBe('acme-api')
    expect(idx.projectOf.get(4)).toBe('acme-api')
    expect(idx.projectOf.get(20)).toBe('acme-api')
    expect(idx.projectOf.get(11)).toBe('web')
  })
  it('lists the projects biggest first, coloured in that order', () => {
    expect(idx.projects.map((p) => [p.name, p.memories, p.nodeId])).toEqual([['acme-api', 3, 10], ['web', 1, 11]])
    expect(idx.colorOf.get(1)).toBe(PROJECT_COLORS[0])
    expect(idx.colorOf.get(3)).toBe(PROJECT_COLORS[1])
  })
  it('draws a project past the named colours in the other colour', () => {
    const many: BrainGraph = { nodes: Array.from({ length: PROJECT_COLORS.length + 1 }, (_, i) => node({ id: i + 1, source: { project: `p${i}` } })), edges: [], total: 0 }
    const m = indexGraph(many)
    expect(m.projects.at(-1)!.color).toBe(OTHER_COLOR)
  })
})

describe('pickNodes', () => {
  const idx = indexGraph(graph)
  it('picks nothing out with no search and no project', () => {
    expect(pickNodes(graph, idx, '  ', '')).toBeNull()
  })
  it('matches every word, in any case or accent, in a title, its project or its topics', () => {
    expect([...pickNodes(graph, idx, 'cafe', '')!]).toEqual([3])
    expect([...pickNodes(graph, idx, 'STORAGE wal', '')!]).toEqual([1])
    expect([...pickNodes(graph, idx, 'acme', '')!].sort()).toEqual([1, 10, 2, 4])
  })
  it('keeps a project its node, its memories and the topics most of them are in', () => {
    expect([...pickNodes(graph, idx, '', 'acme-api')!].sort((a, b) => a - b)).toEqual([1, 2, 4, 10, 20])
    expect([...pickNodes(graph, idx, 'retry', 'web')!]).toEqual([])
  })
})

describe('entityView', () => {
  const idx = indexGraph(graph)
  it('a project: its memories newest first, the sessions they came from, its topics', () => {
    const v = entityView(graph, idx, 10)
    expect(v.memories.map((n) => n.id)).toEqual([4, 2, 1])
    expect(v.sessions).toEqual([{ id: 's2', ts: 2500, memories: 1 }, { id: 's1', ts: 1500, memories: 1 }])
    expect(v.topics.map((t) => [t.node.title, t.memories])).toEqual([['storage', 2]])
  })
  it('a topic: the memories linked to it', () => {
    expect(entityView(graph, idx, 20).memories.map((n) => n.id)).toEqual([3, 2, 1])
  })
})
