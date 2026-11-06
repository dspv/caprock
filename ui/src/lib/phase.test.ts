import { describe, expect, it } from 'vitest'
import type { SessionSummary } from './api'
import { phaseOf, PHASE_WORD, projectSummary } from './phase'
import { dotOf } from './sidebar'

const session = (over: Partial<SessionSummary>): SessionSummary =>
  ({ session_id: 's', status: 'active', started_at: 0, ...over }) as SessionSummary
const health = (h: string) => ({ activity: { health: h } }) as Partial<SessionSummary>

describe('a session’s phase (owner, 2026-11-05: V1’s chips)', () => {
  it('maps each health, the permission prompt and an ended session to one of five phases', () => {
    const cases: [Partial<SessionSummary>, boolean, string][] = [
      [health('working'), false, 'working'],
      [health('waiting-on-you'), false, 'needs-you'],
      [health('working'), true, 'needs-you'],
      [health('done'), false, 'done'],
      [{ status: 'ended' }, false, 'done'],
      [health('looping'), false, 'failed'],
      [health('error'), false, 'failed'],
      [health('idle'), false, 'idle'],
      [{}, false, 'idle'],
    ]
    for (const [over, asks, want] of cases) expect(phaseOf(dotOf(session(over), asks))).toBe(want)
  })

  it('says each phase in the words of the mockup', () => {
    expect(Object.values(PHASE_WORD)).toEqual(['working', 'needs you', 'idle', 'done', 'failed'])
  })
})

describe('a folded project’s summary', () => {
  it('says what needs you first, then what runs, then what idles, and nothing for a quiet project', () => {
    expect(projectSummary({ waiting: 1, working: 2, agents: 3 })).toEqual({ text: '1 needs you', tone: 'warn' })
    expect(projectSummary({ waiting: 0, working: 1, agents: 3 })).toEqual({ text: '1 running', tone: 'ok' })
    expect(projectSummary({ waiting: 0, working: 0, agents: 2 })).toEqual({ text: '2 idle' })
    expect(projectSummary({ waiting: 0, working: 0, agents: 0 })).toBeUndefined()
  })
})
