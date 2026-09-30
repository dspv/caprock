import { describe, expect, it } from 'vitest'
import { foldChains } from './chains'
import type { SessionSummary } from './api'

const s = (id: string, over: Partial<SessionSummary> = {}) =>
  ({ session_id: id, status: 'ended', last_event_at: 0, ...over }) as SessionSummary

describe('foldChains', () => {
  it('folds a /clear chain into its latest part', () => {
    const { shown, earlier } = foldChains([
      s('c', { parent_session: 'b', worked_at: 3 }),
      s('b', { parent_session: 'a', worked_at: 2 }),
      s('a', { worked_at: 1 }),
      s('x'),
    ])
    expect(shown.map((x) => x.session_id)).toEqual(['c', 'x'])
    expect(earlier.get('c')!.map((x) => x.session_id)).toEqual(['b', 'a'])
  })

  it('folds an ended part into a live continuation', () => {
    const { shown, earlier } = foldChains([s('live', { status: 'active', parent_session: 'old' }), s('old')])
    expect(shown.map((x) => x.session_id)).toEqual(['live'])
    expect(earlier.get('live')!.map((x) => x.session_id)).toEqual(['old'])
  })

  it('shows an earlier part whose continuation is not in the list', () => {
    const { shown } = foldChains([s('b', { parent_session: 'gone' })])
    expect(shown.map((x) => x.session_id)).toEqual(['b'])
  })

  it('never folds a session that is still open', () => {
    const { shown } = foldChains([s('fork', { parent_session: 'orig' }), s('orig', { status: 'active' })])
    expect(shown.map((x) => x.session_id).sort()).toEqual(['fork', 'orig'])
  })

  it('survives a cycle', () => {
    const { shown } = foldChains([s('a', { parent_session: 'b' }), s('b', { parent_session: 'a' })])
    expect(shown.length).toBeGreaterThan(0)
  })
})
