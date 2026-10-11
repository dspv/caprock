import { describe, expect, it } from 'vitest'
import { BRANCHES_SHOWN, aheadBehind, branchPRDot, branchSpend, lastCommit, shortAge, shownBranches, type SessionBranch } from './branches'

const br = (p: Partial<SessionBranch> = {}): SessionBranch => ({ name: 'feat/x', local: true, remote: true, committed_ms: 0, cost_usd: 0, sessions: 0, agents: [], activity_at: 0, ...p })

describe('branch rows', () => {
  it('says ahead and behind the default branch, and nothing for the default or an uncounted branch', () => {
    expect(aheadBehind(br({ ahead: 2, behind: 1 }))).toEqual({ text: '↑2 ↓1', title: '2 commits ahead of the default branch, 1 behind' })
    expect(aheadBehind(br({ ahead: 3, behind: 0 })).text).toBe('↑3')
    expect(aheadBehind(br({ ahead: 0, behind: 4 })).text).toBe('↓4')
    expect(aheadBehind(br({ ahead: 0, behind: 0 })).text).toBe('even')
    expect(aheadBehind(br({ ahead: 0, behind: 0, default: true })).text).toBe('')
    expect(aheadBehind(br()).text).toBe('')
  })

  it('words the last commit and its author', () => {
    const now = Date.now()
    expect(lastCommit(br({ committed_ms: now - 2 * 3_600_000, author: 'Ada' }), now).text).toBe('2h · Ada')
    expect(lastCommit(br(), now).text).toBe('')
    expect(shortAge(90 * 86_400_000)).toBe('3mo')
  })

  it('says what Caprock’s sessions on the branch cost, or nothing', () => {
    const s = branchSpend(br({ cost_usd: 4.5, sessions: 3, agents: ['claude', 'codex'] }))
    expect(s.text).toBe('$4.50 · 3 sessions')
    expect(s.title).toMatch(/3 sessions recorded on feat\/x \(claude, codex\)/)
    expect(s.title).toMatch(/API list price/)
    expect(branchSpend(br()).text).toBe('')
  })

  it('caps the rows until all are asked for', () => {
    const many = Array.from({ length: BRANCHES_SHOWN + 5 }, (_, i) => br({ name: `b${i}` }))
    expect(shownBranches(many, false)).toHaveLength(BRANCHES_SHOWN)
    expect(shownBranches(many, true)).toHaveLength(BRANCHES_SHOWN + 5)
  })

  it('draws a PR’s state as the PRs view does', () => {
    expect(branchPRDot({ number: 1, url: '', state: 'open', draft: true })).toBe('draft')
    expect(branchPRDot({ number: 1, url: '', state: 'merged' })).toBe('merged')
  })
})
