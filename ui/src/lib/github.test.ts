import { describe, expect, it } from 'vitest'
import { agoText, checksText, mergeText, prTone, type PullRequest } from './github'

const base: PullRequest = {
  project_id: 1, worktree: '', branch: 'b', repo: 'a/b', number: 1, url: '', title: 't', state: 'open', draft: false, base: 'main', head_sha: '',
  mergeable: true, mergeable_state: 'clean', review: '', reviews: [], checks: { state: 'none', passed: 0, failed: 0, pending: 0, items: [] }, at: 0,
}

describe('GitHub words', () => {
  it('sums checks', () => {
    expect(checksText(base.checks)).toBe('no checks')
    expect(checksText({ state: 'fail', passed: 0, failed: 3, pending: 0, items: [{ name: 'a', state: 'fail' }, { name: 'b', state: 'fail' }, { name: 'c', state: 'fail' }] })).toBe('a, b +1 failed')
    expect(checksText({ state: 'pending', passed: 1, failed: 0, pending: 1, items: [{ name: 'a', state: 'pass' }, { name: 'b', state: 'pending' }] })).toBe('1 of 2 checks running')
    expect(checksText({ state: 'pass', passed: 2, failed: 0, pending: 0, items: [{ name: 'a', state: 'pass' }, { name: 'b', state: 'pass' }] })).toBe('all 2 checks passed')
  })

  it('says whether it can be merged', () => {
    expect(mergeText(base)).toBe('ready to merge')
    expect(mergeText({ ...base, mergeable: null })).toBe('checking mergeability')
    expect(mergeText({ ...base, mergeable: false, mergeable_state: 'dirty' })).toBe('has conflicts')
    expect(mergeText({ ...base, state: 'merged' })).toBe('merged')
    expect(mergeText({ ...base, draft: true })).toBe('draft')
  })

  it('tones: a requested change is a failure, merged is its own', () => {
    expect(prTone({ ...base, review: 'changes_requested' })).toBe('fail')
    expect(prTone({ ...base, state: 'merged' })).toBe('merged')
    expect(prTone({ ...base, checks: { ...base.checks, state: 'pending' } })).toBe('pending')
  })

  it('says how long ago', () => {
    expect(agoText(1000, 1000)).toBe('just now')
    expect(agoText(0, 5 * 60_000)).toBe('5 min ago')
    expect(agoText(0, 3 * 3_600_000)).toBe('3 h ago')
  })
})
