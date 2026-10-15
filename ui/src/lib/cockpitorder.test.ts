import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ORDER, ORDER_KEY, dropIndex, getOrder, isDefaultOrder, dropSection, moveSection, moveSectionTo, normalizeOrder, stepSection, resetOrderForTest, setOrder } from './cockpitorder'

beforeEach(() => {
  localStorage.clear()
  resetOrderForTest()
})

describe('the cockpit’s section order', () => {
  it('makes whatever was stored a whole order', () => {
    expect(normalizeOrder(undefined)).toEqual(DEFAULT_ORDER)
    expect(normalizeOrder('spend')).toEqual(DEFAULT_ORDER)
    // Unknown and repeated names dropped; a missing section after the one before it by default.
    expect(normalizeOrder(['now', 'tools', 'bogus', 'now', 'spend'])).toEqual(['now', 'context', 'limits', 'tools', 'changes', 'ci', 'release', 'processes', 'spend', 'subagents', 'tasks'])
    expect(normalizeOrder(['changes', 'context'])).toEqual(['now', 'changes', 'ci', 'release', 'processes', 'context', 'limits', 'spend', 'subagents', 'tasks', 'tools'])
  })

  it('moves a section one place, never past an edge', () => {
    expect(moveSection(DEFAULT_ORDER, 'context', -1).slice(0, 2)).toEqual(['context', 'now'])
    expect(moveSection(DEFAULT_ORDER, 'now', -1)).toEqual(DEFAULT_ORDER)
    expect(moveSection(DEFAULT_ORDER, 'processes', 1)).toEqual(DEFAULT_ORDER)
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

  // Owner, 2026-10-15: a Release section, added after CI; an order chosen
  // before it existed gets it after CI wherever CI was moved to.
  it('adds Release after CI, in the default and in an order kept from before', () => {
    expect(DEFAULT_ORDER.indexOf('release')).toBe(DEFAULT_ORDER.indexOf('ci') + 1)
    const before = ['ci', 'now', 'context', 'limits', 'spend', 'subagents', 'tasks', 'tools', 'changes', 'processes']
    expect(normalizeOrder(before).slice(0, 3)).toEqual(['ci', 'release', 'now'])
  })

  it('puts a section at a place: the top, the end, anywhere between', () => {
    expect(moveSectionTo(DEFAULT_ORDER, 'release', 0)[0]).toBe('release')
    expect(moveSectionTo(DEFAULT_ORDER, 'now', 99).at(-1)).toBe('now')
    expect(moveSectionTo(DEFAULT_ORDER, 'spend', 1).slice(0, 3)).toEqual(['now', 'spend', 'context'])
    expect(moveSectionTo(DEFAULT_ORDER, 'now', -3)).toEqual(DEFAULT_ORDER)
  })

  it('drops a dragged section above the first middle the pointer is above', () => {
    const mids = [10, 50, 90]
    expect(dropIndex(mids, 0)).toBe(0)
    expect(dropIndex(mids, 49)).toBe(1)
    expect(dropIndex(mids, 89)).toBe(2)
    expect(dropIndex(mids, 200)).toBe(3)
    expect(dropIndex([], 5)).toBe(0)
  })

  it('steps a section past the next one shown, skipping those with nothing to show', () => {
    const shown = ['now', 'context', 'spend', 'tools', 'ci', 'release'] as const
    // Plan limits, Subagents and Tasks are not shown: Spend goes above Context in one press.
    expect(stepSection(DEFAULT_ORDER, 'spend', shown, -1).slice(0, 3)).toEqual(['now', 'spend', 'context'])
    expect(stepSection(DEFAULT_ORDER, 'release', shown, 1)).toEqual(DEFAULT_ORDER)
    expect(stepSection(DEFAULT_ORDER, 'now', shown, -1)).toEqual(DEFAULT_ORDER)
    const down = stepSection(DEFAULT_ORDER, 'context', shown, 1)
    expect(down.indexOf('context')).toBe(down.indexOf('spend') + 1)
  })

  it('drops a dragged section among the others shown', () => {
    const others = ['now', 'context', 'spend'] as const
    expect(dropSection(DEFAULT_ORDER, 'release', others, 0)[0]).toBe('release')
    const mid = dropSection(DEFAULT_ORDER, 'release', others, 2)
    expect(mid.indexOf('release')).toBe(mid.indexOf('spend') - 1)
    const end = dropSection(DEFAULT_ORDER, 'release', others, 3)
    expect(end.indexOf('release')).toBe(end.indexOf('spend') + 1)
  })
})
