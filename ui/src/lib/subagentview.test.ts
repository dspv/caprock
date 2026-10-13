import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SUBAGENT_FIELDS, SUBAGENT_FIELDS_KEY, getSubagentFields, normalizeSubagentFields, orderSubagents, presetOf,
  resetSubagentFieldsForTest, setSubagentFields,
} from './subagentview'

describe('orderSubagents', () => {
  const row = (agent_id: string, started_at: number) => ({ agent_id, started_at })

  it('orders by start, first on top, the id breaking a tie', () => {
    const seen = new Map<string, number>()
    expect(orderSubagents([row('c', 30), row('b', 10), row('a', 10)], seen).map((r) => r.agent_id)).toEqual(['a', 'b', 'c'])
  })

  it('keeps the start first seen, so a sliding window start moves nothing', () => {
    const seen = new Map<string, number>()
    orderSubagents([row('a', 10), row('b', 20)], seen)
    // a's first event slid out of the live window: its start now reads later than b's.
    expect(orderSubagents([row('b', 20), row('a', 40)], seen).map((r) => r.agent_id)).toEqual(['a', 'b'])
  })

  it('appends a newcomer and keeps the rest when one leaves', () => {
    const seen = new Map<string, number>()
    orderSubagents([row('a', 10), row('b', 20), row('c', 30)], seen)
    expect(orderSubagents([row('d', 40), row('c', 30), row('a', 10)], seen).map((r) => r.agent_id)).toEqual(['a', 'c', 'd'])
  })
})

describe('what a subagent row shows', () => {
  beforeEach(() => {
    localStorage.clear()
    resetSubagentFieldsForTest()
  })

  it('defaults to cost and time', () => {
    expect(getSubagentFields()).toEqual(DEFAULT_SUBAGENT_FIELDS)
    expect(DEFAULT_SUBAGENT_FIELDS).toEqual({ calls: false, cost: true, model: false, time: true })
    expect(presetOf(getSubagentFields())).toBe('cost')
  })

  it('names a preset only when the fields match one', () => {
    expect(presetOf({ calls: false, cost: false, model: false, time: false })).toBe('compact')
    expect(presetOf({ calls: true, cost: true, model: true, time: true })).toBe('full')
    expect(presetOf({ calls: true, cost: false, model: false, time: false })).toBeUndefined()
  })

  it('makes whatever was stored valid, field by field', () => {
    expect(normalizeSubagentFields({ calls: true, cost: 'yes', bogus: 1 })).toEqual({ calls: true, cost: true, model: false, time: true })
    expect(normalizeSubagentFields(null)).toEqual(DEFAULT_SUBAGENT_FIELDS)
    expect(normalizeSubagentFields([true])).toEqual(DEFAULT_SUBAGENT_FIELDS)
  })

  it('remembers a choice across a reload, and survives broken storage', () => {
    setSubagentFields({ model: true, cost: false })
    resetSubagentFieldsForTest()
    expect(getSubagentFields()).toEqual({ calls: false, cost: false, model: true, time: true })
    localStorage.setItem(SUBAGENT_FIELDS_KEY, '{not json')
    resetSubagentFieldsForTest()
    expect(getSubagentFields()).toEqual(DEFAULT_SUBAGENT_FIELDS)
  })
})
