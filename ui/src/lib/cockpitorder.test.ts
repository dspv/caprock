import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ORDER, ORDER_KEY, getOrder, isDefaultOrder, moveSection, normalizeOrder, resetOrderForTest, setOrder } from './cockpitorder'

beforeEach(() => {
  localStorage.clear()
  resetOrderForTest()
})

describe('the cockpit’s section order', () => {
  it('makes whatever was stored a whole order', () => {
    expect(normalizeOrder(undefined)).toEqual(DEFAULT_ORDER)
    expect(normalizeOrder('spend')).toEqual(DEFAULT_ORDER)
    // Unknown and repeated names dropped; a missing section after the one before it by default.
    expect(normalizeOrder(['now', 'tools', 'bogus', 'now', 'spend'])).toEqual(['now', 'context', 'limits', 'tools', 'changes', 'spend', 'subagents', 'tasks'])
    expect(normalizeOrder(['changes', 'context'])).toEqual(['now', 'changes', 'context', 'limits', 'spend', 'subagents', 'tasks', 'tools'])
  })

  it('moves a section one place, never past an edge', () => {
    expect(moveSection(DEFAULT_ORDER, 'context', -1).slice(0, 2)).toEqual(['context', 'now'])
    expect(moveSection(DEFAULT_ORDER, 'now', -1)).toEqual(DEFAULT_ORDER)
    expect(moveSection(DEFAULT_ORDER, 'changes', 1)).toEqual(DEFAULT_ORDER)
    expect(isDefaultOrder(moveSection(DEFAULT_ORDER, 'spend', 1))).toBe(false)
  })

  it('keeps an order per viewer and stores the default as nothing', () => {
    setOrder(moveSection(DEFAULT_ORDER, 'tools', -1))
    expect(JSON.parse(localStorage.getItem(ORDER_KEY)!)).toContain('tools')
    resetOrderForTest()
    expect(getOrder().indexOf('tools')).toBe(DEFAULT_ORDER.indexOf('tools') - 1)
    setOrder(DEFAULT_ORDER)
    expect(localStorage.getItem(ORDER_KEY)).toBeNull()
  })

  it('reads broken storage as the default', () => {
    localStorage.setItem(ORDER_KEY, '{not json')
    expect(getOrder()).toEqual(DEFAULT_ORDER)
  })
})
