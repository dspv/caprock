/**
 * Gemini was added to the New Session dialog and to nothing else. A session
 * started with it landed in the list wearing no badge, could not be filtered
 * for, and was described in prose as Claude Code — because three separate
 * places asked `agent === 'opencode'` and treated everything else as Claude.
 * Adding a launcher without teaching the rest of the product the agent exists
 * is the shape of that bug, so these tests are about every agent, not Gemini.
 */
import { describe, expect, it } from 'vitest'
import { AGENTS, agentMark, agentName } from './Projects'

const OTHERS = ['opencode', 'gemini']

describe('an agent that is not Claude is marked as itself', () => {
  it('gives every non-Claude agent a distinct mark', () => {
    const marks = OTHERS.map(agentMark)
    for (const m of marks) expect(m).not.toBe('')
    expect(new Set(marks).size).toBe(marks.length)
  })

  it('leaves Claude unmarked, because it is almost every row', () => {
    expect(agentMark('claude')).toBe('')
    expect(agentMark(undefined)).toBe('')
  })

  it('never calls another agent Claude Code in prose', () => {
    for (const a of OTHERS) expect(agentName(a)).not.toBe('Claude Code')
    expect(agentName('claude')).toBe('Claude Code')
    expect(agentName(undefined)).toBe('Claude Code')
  })
})

describe('the filter offers every agent', () => {
  it('has a chip for each agent the product can show', () => {
    const keys = AGENTS.map((a) => a.key)
    expect(keys).toContain('all')
    expect(keys).toContain('claude')
    for (const a of OTHERS) expect(keys).toContain(a)
  })
})
