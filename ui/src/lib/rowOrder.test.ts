import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadRowOrders, moveKey, orderRows, ROW_ORDER_EVENT, ROW_ORDER_KEY, saveRowOrder, tabRowKey } from './rowOrder'
import type { Tab } from './tabs'

type Row = { k: string; at?: number }
const order = (rows: Row[], manual?: string[]) => orderRows(rows, (r) => r.k, (r) => r.at, manual).map((r) => r.k)

beforeEach(() => localStorage.clear())

describe('the fixed order of rows under a project', () => {
  it('goes by when each session started, unknown last, then by key: never by the order it was given', () => {
    expect(order([{ k: 'c', at: 3 }, { k: 'a', at: 1 }, { k: 'f' }, { k: 'b', at: 2 }])).toEqual(['a', 'b', 'c', 'f'])
    expect(order([{ k: 'b', at: 2 }, { k: 'f' }, { k: 'a', at: 1 }, { k: 'c', at: 3 }])).toEqual(['a', 'b', 'c', 'f'])
    expect(order([{ k: 'y', at: 1 }, { k: 'x', at: 1 }])).toEqual(['x', 'y'])
  })

  it('puts the order set by hand first; a new session lands last, an ended one leaves no gap', () => {
    const manual = ['c', 'a', 'b']
    expect(order([{ k: 'a', at: 1 }, { k: 'b', at: 2 }, { k: 'c', at: 3 }], manual)).toEqual(['c', 'a', 'b'])
    expect(order([{ k: 'a', at: 1 }, { k: 'b', at: 2 }, { k: 'c', at: 3 }, { k: 'new', at: 0 }], manual)).toEqual(['c', 'a', 'b', 'new'])
    expect(order([{ k: 'b', at: 2 }, { k: 'c', at: 3 }], manual)).toEqual(['c', 'b'])
  })

  it('moves a key before or after another, and nothing when either is missing', () => {
    expect(moveKey(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b'])
    expect(moveKey(['a', 'b', 'c'], 'a', 'c', 'after')).toEqual(['b', 'c', 'a'])
    expect(moveKey(['a', 'b', 'c'], 'a', 'b', 'after')).toEqual(['b', 'a', 'c'])
    expect(moveKey(['a', 'b'], 'a', 'zz', 'before')).toEqual(['a', 'b'])
  })

  it('keeps the order set by hand per project across a restart, and says so on window', () => {
    const heard = vi.fn()
    window.addEventListener(ROW_ORDER_EVENT, heard)
    saveRowOrder('alpha', ['b', 'a'])
    saveRowOrder('beta', ['x'])
    window.removeEventListener(ROW_ORDER_EVENT, heard)
    expect(heard).toHaveBeenCalledTimes(2)
    expect(loadRowOrders()).toEqual({ alpha: ['b', 'a'], beta: ['x'] })
    localStorage.setItem(ROW_ORDER_KEY, '{broken')
    expect(loadRowOrders()).toEqual({})
  })

  it('keys a tab by the session it is named after, so a row keeps its place when it becomes a tab', () => {
    const tab: Tab = { id: 't1', projectId: 'alpha', root: { type: 'pane', id: 'p1', target: { kind: 'session', sessionId: 's1' } }, focusedPaneId: 'p1', title: '' }
    expect(tabRowKey(tab)).toBe('s1')
  })
})
