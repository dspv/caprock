import { beforeEach, describe, expect, it } from 'vitest'
import type { LoopAlert } from './api'
import { dismissLoop, loopHeadline, loopHidden, loopInput, muteLoop, resetLoopMutesForTest, shortInput, tellAgentMessage } from './loopalert'

const t0 = Date.parse('2026-10-14T10:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

function alert(over: Partial<LoopAlert> = {}): LoopAlert {
  return {
    kind: 'loop', session_id: 's1', tool: 'Bash', count: 5, window_min: 3,
    sample: 'Bash: python3 /private/tmp/claude-501/x/scratchpad/brain/p2e.py',
    first_ts: iso(t0), last_ts: iso(t0 + 150_000), ts: iso(t0 + 150_000),
    ...over,
  }
}

describe('the loop sentence', () => {
  // The owner's card, 2026-10-14: the fragments read as "many buttons, zero
  // meaning". One sentence says what happened.
  it('says what happened in one plain sentence, the command shortened', () => {
    const h = loopHeadline('caprock', alert())
    expect(h.sentence).toBe('caprock ran the same command 5 times in 3 minutes')
    expect(h.short).toBe('python3 …/p2e.py')
    expect(h.input).toBe('python3 /private/tmp/claude-501/x/scratchpad/brain/p2e.py')
  })

  it('measures the span from the calls, not the detector window', () => {
    expect(loopHeadline('p', alert({ last_ts: iso(t0 + 40_000) })).sentence).toBe('p ran the same command 5 times in 40 seconds')
  })

  it('names other tools in their own words', () => {
    expect(loopHeadline('p', alert({ tool: 'Read', sample: 'Read: /a/b/c/d.go' })).sentence).toMatch(/^p read the same file 5 times/)
    expect(loopHeadline('p', alert({ tool: 'mcp__x', sample: 'mcp__x' })).sentence).toMatch(/made the same mcp__x call/)
    expect(loopHeadline('', alert()).sentence).toMatch(/^This session ran/)
  })

  it('takes a sample with or without the tool prefix', () => {
    expect(loopInput({ tool: 'Bash', sample: 'npm test' })).toBe('npm test')
    expect(loopInput({ tool: 'Bash', sample: 'Bash: npm test' })).toBe('npm test')
    expect(loopInput({ tool: 'Bash', sample: 'Bash' })).toBe('')
  })

  it('clips what is still too long', () => {
    const s = shortInput('x'.repeat(100), 20)
    expect(Array.from(s)).toHaveLength(20)
    expect(s.endsWith('…')).toBe(true)
  })
})

describe('the message the agent gets', () => {
  it('is marked as from Caprock, not the user, and carries the exact command', () => {
    expect(tellAgentMessage(alert())).toBe(
      "[Caprock] Heads-up: in the last 3 minutes you ran the same command 5 times: `python3 /private/tmp/claude-501/x/scratchpad/brain/p2e.py`. "
      + "If you're stuck, step back and try a different approach, or tell me what's blocking. "
      + "(Sent by Caprock's loop alert — not by the user.)",
    )
  })

  // A newline typed into a terminal prompt submits the line before it.
  it('is one line, whatever the command held', () => {
    const m = tellAgentMessage(alert({ sample: 'Bash: echo a\nb  `c`' }))
    expect(m).not.toMatch(/\n/)
    expect(m).toContain("`echo a b 'c'`")
  })
})

describe('dismiss and mute', () => {
  beforeEach(() => { localStorage.clear(); resetLoopMutesForTest() })

  it('dismiss hides this episode only; a later alert shows again', () => {
    const a = alert()
    dismissLoop(a)
    expect(loopHidden(a)).toBe(true)
    expect(loopHidden(alert({ ts: iso(t0 + 900_000) }))).toBe(false)
  })

  it('mute hides this command in this session for good', () => {
    muteLoop(alert())
    expect(loopHidden(alert({ ts: iso(t0 + 900_000) }))).toBe(true)
    expect(loopHidden(alert({ session_id: 's2' }))).toBe(false)
    expect(loopHidden(alert({ sample: 'Bash: go test' }))).toBe(false)
    resetLoopMutesForTest() // re-reads storage: it outlives a reload
    expect(loopHidden(alert())).toBe(true)
  })
})
