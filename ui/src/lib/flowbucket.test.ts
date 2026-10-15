import { describe, expect, it } from 'vitest'
import { fixedLately, inBucket, noteFixes, reasonOf, FIXED_WINDOW_MS } from './flowbucket'

describe('the count tiles’ buckets', () => {
  it('puts every open stage in flight, and fix and ready in their own', () => {
    const r = (stage: 'draft' | 'fix' | 'ready' | 'merged') => ({ state: 'open' as const, card: { stage } })
    expect(inBucket(r('draft'), 'flight')).toBe(true)
    expect(inBucket(r('fix'), 'flight')).toBe(true)
    expect(inBucket(r('fix'), 'fix')).toBe(true)
    expect(inBucket(r('ready'), 'fix')).toBe(false)
    expect(inBucket(r('merged'), 'flight')).toBe(false)
  })

  it('says why one needs a fix, naming the failed checks', () => {
    expect(reasonOf({ stage: 'fix', ci: 'fail', why: 'ci', failed: ['lint', 'test (windows)'] })).toMatchObject({ text: 'CI red', title: 'Failed checks: lint, test (windows)', fail: true })
    expect(reasonOf({ stage: 'fix', ci: 'pass', why: 'conflict' }).text).toBe('Conflict')
    expect(reasonOf({ stage: 'fix', why: 'changes_requested' }).text).toBe('Changes requested')
  })

  it('counts what was seen leaving Needs a fix in the last day, not one closed or back in it', () => {
    const t0 = 1_000_000_000_000
    let seen = noteFixes({}, [{ number: 1, stage: 'fix' }, { number: 2, stage: 'fix' }, { number: 3, stage: 'fix' }, { number: 4, stage: 'fix' }], t0)
    expect(fixedLately(seen, t0)).toBe(0)
    // #1 went green, #2 merged, #3 closed (gone from the board), #4 still red.
    seen = noteFixes(seen, [{ number: 1, stage: 'ready' }, { number: 2, stage: 'merged' }, { number: 4, stage: 'fix' }], t0 + 60_000)
    expect(fixedLately(seen, t0 + 60_000)).toBe(2)
    // #1 red again: it is back in, not fixed.
    seen = noteFixes(seen, [{ number: 1, stage: 'fix' }, { number: 2, stage: 'merged' }, { number: 4, stage: 'fix' }], t0 + 120_000)
    expect(fixedLately(seen, t0 + 120_000)).toBe(1)
    expect(fixedLately(seen, t0 + 60_000 + FIXED_WINDOW_MS + 1)).toBe(0)
  })
})
