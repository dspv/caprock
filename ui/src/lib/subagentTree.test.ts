import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Subagent, SubagentDone, SubagentsNow } from './api'
import { DEFAULT_NOW_VIEW, NOW_VIEW_KEY, buildSubagentTree, getNowView, nodeTool, resetNowViewForTest, setNowView, type TreeNode } from './subagentTree'

const w = (id: string, started: number, extra: Partial<Subagent> = {}): Subagent =>
  ({ agent_id: id, tool_calls: 1, started_at: started, last_at: started, running: true, asking: false, ...extra })
const d = (id: string, started: number, extra: Partial<SubagentDone> = {}): SubagentDone =>
  ({ agent_id: id, tool_calls: 1, started_at: started, stopped_at: started + 10, ...extra })
const ids = (ns: TreeNode[]) => ns.map((n) => n.agent_id)

describe('the subagent tree', () => {
  it('lists the working by start, folds the finished apart, and sums the header', () => {
    const subs: SubagentsNow = {
      working: [w('c', 300), w('a', 100), w('b', 200)],
      finished: 2,
      recent: [d('x', 50, { cost_usd: 1.5 }), d('y', 60, { cost_usd: 0.25 })],
      cost_usd: 9.75,
    }
    const t = buildSubagentTree(subs, new Map())
    expect(ids(t.working)).toEqual(['a', 'b', 'c'])
    expect(ids(t.done)).toEqual(['x', 'y'])
    expect(t.count).toBe(3)
    expect(t.doneCount).toBe(2)
    expect(t.doneCost).toBe(1.75)
    expect(t.cost).toBe(9.75)
    expect(t.since).toBe(100)
  })

  it('names no done cost when some finished are not listed or not priced, and no time with none working', () => {
    expect(buildSubagentTree({ working: [], finished: 5, recent: [d('x', 1, { cost_usd: 1 })] }, new Map()).doneCost).toBeUndefined()
    const t = buildSubagentTree({ working: [], finished: 2, recent: [d('x', 1, { cost_usd: 1 }), d('y', 2)] }, new Map())
    expect(t.doneCost).toBeUndefined()
    expect(t.since).toBeUndefined()
    expect(t.cost).toBeUndefined()
    // The count is never below what is listed.
    expect(buildSubagentTree({ working: [], finished: 0, recent: [d('x', 1)] }, new Map()).doneCount).toBe(1)
  })

  it('keeps each entry where it was first seen while the daemon’s window start slides', () => {
    const seen = new Map<string, number>()
    buildSubagentTree({ working: [w('a', 100), w('b', 200)], finished: 0 }, seen)
    // a ran past the window: its start now reads later than b's.
    const t = buildSubagentTree({ working: [w('a', 900), w('b', 200)], finished: 0 }, seen)
    expect(ids(t.working)).toEqual(['a', 'b'])
    expect(t.since).toBe(100)
  })

  it('nests a subagent under its parent, recursively, a finished child staying with its working parent', () => {
    const parents: Record<string, string> = { b: 'a', c: 'b', y: 'a' }
    const subs: SubagentsNow = { working: [w('a', 1), w('b', 2), w('c', 3), w('z', 4)], finished: 2, recent: [d('y', 5), d('x', 6)] }
    const t = buildSubagentTree(subs, new Map(), (x) => parents[x.agent_id])
    expect(ids(t.working)).toEqual(['a', 'z'])
    const a = t.working[0]!
    expect(ids(a.children)).toEqual(['b', 'y'])
    expect(ids(a.children[0]!.children)).toEqual(['c'])
    expect(a.children[1]!.d).toBeDefined()
    expect(ids(t.done)).toEqual(['x'])
    // Every working one counts in the header, nested or not.
    expect(t.count).toBe(4)
  })

  it('makes a root of one whose parent is not listed, is itself, or loops', () => {
    const parents: Record<string, string> = { a: 'gone', b: 'b', c: 'd', d: 'c' }
    const t = buildSubagentTree({ working: [w('a', 1), w('b', 2), w('c', 3), w('d', 4)], finished: 0 }, new Map(), (x) => parents[x.agent_id])
    expect(ids(t.working)).toEqual(['a', 'b', 'c', 'd'])
    expect(t.working.every((n) => n.children.length === 0)).toBe(true)
  })

  it('names an MCP tool by its server', () => {
    expect(nodeTool({ agent_id: 'a', started_at: 0, a: w('a', 0, { tool: 'mcp__github__search' }), children: [] })).toBe('github·search')
    expect(nodeTool({ agent_id: 'a', started_at: 0, d: d('a', 0), children: [] })).toBe('')
  })
})

describe('the Rows · Cards choice', () => {
  afterEach(() => { localStorage.removeItem(NOW_VIEW_KEY); resetNowViewForTest(); vi.restoreAllMocks() })

  it('is Cards until picked, kept in localStorage, read back on a fresh page', () => {
    resetNowViewForTest()
    expect(getNowView()).toBe(DEFAULT_NOW_VIEW)
    expect(DEFAULT_NOW_VIEW).toBe('cards')
    setNowView('rows')
    expect(localStorage.getItem(NOW_VIEW_KEY)).toBe('rows')
    resetNowViewForTest()
    expect(getNowView()).toBe('rows')
  })

  it('reads anything else stored as Cards, and holds a choice when storage throws', () => {
    localStorage.setItem(NOW_VIEW_KEY, 'tiles')
    resetNowViewForTest()
    expect(getNowView()).toBe('cards')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('private') })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('private') })
    resetNowViewForTest()
    expect(getNowView()).toBe('cards')
    setNowView('rows')
    expect(getNowView()).toBe('rows')
  })
})
