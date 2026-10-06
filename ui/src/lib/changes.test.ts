import { describe, expect, it } from 'vitest'
import { entriesOf, isLargePatch, messageFromSummary, splitRows, unifiedRows, type Changes } from './changes'

const PATCH = [
  'diff --git a/f b/f',
  'index 1..2 100644',
  '--- a/f',
  '+++ b/f',
  '@@ -1,4 +1,4 @@',
  ' keep',
  '-old one',
  '-old two',
  '+new one',
  ' tail',
  '@@ -10,2 +10,3 @@',
  ' ctx',
  '+added',
  '',
].join('\n')

describe('diff rows', () => {
  it('numbers unified rows and says which hunk each is in', () => {
    const rows = unifiedRows(PATCH)
    expect(rows.map((r) => `${r.kind}:${r.hunk}`)).toEqual(['hunk:0', 'ctx:0', 'del:0', 'del:0', 'add:0', 'ctx:0', 'hunk:1', 'ctx:1', 'add:1'])
    expect(rows[2]).toMatchObject({ text: 'old one', old: 2 })
    expect(rows[8]).toMatchObject({ text: 'added', new: 11 })
  })

  it('pairs removed and added runs side by side, the shorter padded', () => {
    const rows = splitRows(unifiedRows(PATCH))
    const lines = rows.filter((r) => r.kind === 'line')
    expect(lines[1]).toMatchObject({ left: { kind: 'del', text: 'old one', n: 2 }, right: { kind: 'add', text: 'new one', n: 2 } })
    expect(lines[2]).toMatchObject({ left: { kind: 'del', text: 'old two' } })
    expect((lines[2] as { right?: unknown }).right).toBeUndefined()
    expect(lines[3]).toMatchObject({ left: { kind: 'ctx', text: 'tail' }, right: { kind: 'ctx', text: 'tail' } })
    expect(rows.filter((r) => r.kind === 'hunk')).toHaveLength(2)
  })

  it('collapses a diff past the line or byte limit', () => {
    const big = Array.from({ length: 3200 }, (_, i) => `+line ${i}`).join('\n')
    expect(isLargePatch({ patch: big, bytes: big.length })).toBe(true)
    expect(isLargePatch({ patch: PATCH, bytes: PATCH.length })).toBe(false)
    expect(isLargePatch({ patch: 'x', bytes: 500 * 1024 })).toBe(true)
  })
})

describe('messageFromSummary', () => {
  it('takes the first sentence as the subject and keeps the rest as the body', () => {
    expect(messageFromSummary('## Done\n\nFixed the **login** bug in `auth.ts`.')).toBe('Done\n\nFixed the **login** bug in `auth.ts`.')
    expect(messageFromSummary('Fixed the login bug. Then I ran the tests.\n- 12 passed')).toBe('Fixed the login bug\n\nThen I ran the tests.\n- 12 passed')
  })

  it('cuts a long subject at a word', () => {
    const m = messageFromSummary('Refactored the session reconnect policy so that every socket shares one backoff and one liveness check')
    const subject = m.split('\n')[0]!
    expect(subject.length).toBeLessThanOrEqual(72)
    expect(subject.endsWith('…')).toBe(true)
  })

  it('is empty for nothing', () => {
    expect(messageFromSummary('  \n\n')).toBe('')
  })
})

describe('entriesOf', () => {
  it('lists conflicts, then staged, then unstaged, one key per area', () => {
    const c = {
      staged: [{ path: 'a', status: 'modified', additions: 1, deletions: 0 }],
      unstaged: [{ path: 'a', status: 'modified', additions: 1, deletions: 0 }, { path: 'n', status: 'untracked', additions: 2, deletions: 0 }],
      conflicted: [{ path: 'c', status: 'conflicted', additions: 0, deletions: 0 }],
    } as unknown as Changes
    expect(entriesOf(c).map((e) => e.key)).toEqual(['c:c', 's:a', 'u:a', 'u:n'])
  })
})
