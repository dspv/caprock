import { describe, expect, it } from 'vitest'
import { ApiError, type SessionPRLive, type SessionSummary } from './api'
import { agentWord, fixCIMessage, fixConflictMessage, forceErrText, prAgents, prChips, progressStands, rerunText, typeable } from './prforce'

const pr = (live: object = {}): SessionPRLive => ({ session_id: 's', url: 'https://github.com/a/b/pull/9', number: 9, last_at: 0,
  live: { project_id: 0, worktree: '', branch: 'feat/x', repo: 'a/b', number: 9, url: 'https://github.com/a/b/pull/9', title: 'Add x', state: 'open', draft: false,
    base: 'main', head_sha: 'h1', mergeable: null, review: '', reviews: [], checks: { state: 'pass', passed: 1, failed: 0, pending: 0, items: [] }, at: 0, ...live } } as SessionPRLive)
const sess = (p: Partial<SessionSummary>) => ({ session_id: 'a', status: 'active', owned: true, title: 'ada', ...p }) as SessionSummary

describe('prChips', () => {
  it('says what GitHub said and nothing while it computes', () => {
    expect(prChips(pr({ mergeable: false })).map((c) => c.word)).toEqual(['conflict'])
    expect(prChips(pr({ mergeable: null, mergeable_state: 'dirty' })).map((c) => c.word)).toEqual(['conflict'])
    // A conflict is not also "behind".
    expect(prChips(pr({ mergeable: false, mergeable_state: 'behind' })).map((c) => c.word)).toEqual(['conflict'])
    expect(prChips(pr({ mergeable: true, mergeable_state: 'behind' })).map((c) => c.word)).toEqual(['behind'])
    expect(prChips(pr({ mergeable: null, mergeable_state: 'unknown' }))).toEqual([])
    expect(prChips(pr({ mergeable: true, mergeable_state: 'clean', review: 'changes_requested', draft: true })).map((c) => c.word)).toEqual(['review', 'draft'])
    expect(prChips(pr({ mergeable: false, state: 'merged' }))).toEqual([])
    expect(prChips({ ...pr(), live: undefined })).toEqual([])
  })
})

describe('who is on the branch', () => {
  it('words a sidebar dot', () => {
    expect(agentWord('working')).toBe('fixing')
    expect(agentWord('looping')).toBe('fixing')
    expect(agentWord('waiting')).toBe('waiting')
    expect(agentWord('idle')).toBe('idle')
  })
  it('counts live agents in a checkout on the branch, working first', () => {
    const wts = [
      { branch: 'feat/x', path: '/a', agents: [{ session: sess({ session_id: '1', title: 'zed' }), dot: 'idle' as const }, { session: sess({ session_id: '2', title: 'amy' }), dot: 'working' as const },
        { session: sess({ session_id: '3', status: 'ended' }), dot: 'idle' as const }, { session: sess({ session_id: '4', kind: 'shell' }), dot: 'working' as const }] },
      { branch: 'feat/y', path: '/b', agents: [{ session: sess({ session_id: '5' }), dot: 'working' as const }] },
    ]
    const got = prAgents('feat/x', wts)
    expect(got.map((a) => [a.session.session_id, a.word, a.initial])).toEqual([['2', 'fixing', 'A'], ['1', 'idle', 'Z']])
    expect(prAgents(undefined, wts)).toEqual([])
  })
  it('types only into a session Caprock started and still runs here', () => {
    expect(typeable(sess({}))).toBe(true)
    expect(typeable(sess({ owned: false }))).toBe(false)
    expect(typeable(sess({ status: 'ended' }))).toBe(false)
    expect(typeable(sess({ detached: true }))).toBe(false)
  })
})

describe('the messages', () => {
  it('asks for a merge of the base, the checks and a push; a new worktree pushes to the PR branch by name', () => {
    const m = fixConflictMessage({ number: 9, title: 'Add x', url: 'https://github.com/a/b/pull/9', base: 'master', branch: 'feat/x' })
    expect(m).toMatch(/^Pull request #9 "Add x" \(https:\/\/github.com\/a\/b\/pull\/9\) has merge conflicts with master\./)
    expect(m).toMatch(/git merge origin\/master/)
    expect(m).toMatch(/Push to the pull request's branch, feat\/x\./)
    expect(fixConflictMessage({ number: 9, title: '', url: 'u', base: 'main', branch: 'feat/x' }, true)).toMatch(/git push origin HEAD:feat\/x$/)
    expect(fixCIMessage({ number: 9, title: 'Add x', url: 'u', branch: 'feat/x' })).toMatch(/^Look at the CI of pull request #9 "Add x" \(u\/checks\)\./)
  })
  it('names the permission GitHub asked for', () => {
    const e = new ApiError(502, '502', { error: 'Re-running the checks: no (403).', needs: ['"Actions" repository permission (write), for a fine-grained token', '"repo" scope, for a classic token'] })
    expect(forceErrText(e)).toBe('Re-running the checks: no (403). Needs the token\'s "Actions" repository permission (write), for a fine-grained token or "repo" scope, for a classic token.')
    expect(forceErrText(new Error('boom'))).toBe('boom')
    expect(rerunText(1)).toBe('re-running 1 job…')
    expect(rerunText(3)).toBe('re-running 3 jobs…')
  })
})

describe('progressStands', () => {
  const t = 1_000_000
  it('a re-run until the checks run again; an update until the head moves; any at most four minutes', () => {
    const rerun = { kind: 'rerun' as const, text: '', at: t, head: 'h1' }
    expect(progressStands(rerun, pr(), [], t + 10_000)).toBe(true)
    expect(progressStands(rerun, pr({ checks: { state: 'pending', passed: 0, failed: 0, pending: 1, items: [] } }), [], t + 10_000)).toBe(false)
    const update = { kind: 'update' as const, text: '', at: t, head: 'h1' }
    expect(progressStands(update, pr(), [], t + 60_000)).toBe(true)
    expect(progressStands(update, pr({ head_sha: 'h2' }), [], t + 60_000)).toBe(false)
    expect(progressStands(update, pr(), [], t + 5 * 60_000)).toBe(false)
  })
  it('an agent while it works on the branch, until its push', () => {
    const g = { kind: 'agent' as const, text: '', at: t, head: 'h1' }
    const working = [{ session: sess({}), word: 'fixing' as const, initial: 'A', title: '' }]
    expect(progressStands(g, pr(), [], t + 10_000)).toBe(true)
    expect(progressStands(g, pr(), working, t + 90_000)).toBe(true)
    expect(progressStands(g, pr(), [], t + 90_000)).toBe(false)
    expect(progressStands(g, pr({ head_sha: 'h2' }), working, t + 90_000)).toBe(false)
  })
})
