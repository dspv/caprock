/**
 * Gemini was added to the New Session dialog and to nothing else. A session
 * started with it landed in the list wearing no badge, could not be filtered
 * for, and was described in prose as Claude Code — because three separate
 * places asked `agent === 'opencode'` and treated everything else as Claude.
 * Adding a launcher without teaching the rest of the product the agent exists
 * is the shape of that bug, so these tests are about every agent, not Gemini.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AGENTS, agentName, showsAgentMark } from './Projects'
import { AgentGlyph } from './AgentMarks'

const OTHERS = ['opencode', 'gemini', 'codex', 'deepseek']

describe('an agent that is not Claude is marked as itself', () => {
  it('marks every non-Claude agent in a list row', () => {
    for (const a of OTHERS) expect(showsAgentMark(a)).toBe(true)
  })

  it('leaves Claude unmarked in lists, because it is almost every row', () => {
    expect(showsAgentMark('claude')).toBe(false)
    expect(showsAgentMark(undefined)).toBe(false)
  })

  it('never calls another agent Claude Code in prose', () => {
    for (const a of OTHERS) expect(agentName(a)).not.toBe('Claude Code')
    expect(agentName('claude')).toBe('Claude Code')
    expect(agentName(undefined)).toBe('Claude Code')
  })
})

describe('the agent glyph is a mark that says its name', () => {
  const cases: [string | undefined, boolean, string][] = [
    ['claude', false, 'Claude Code'],
    [undefined, false, 'Claude Code'],
    ['codex', false, 'Codex'],
    ['gemini', false, 'Gemini CLI'],
    ['opencode', false, 'OpenCode'],
    ['deepseek', false, 'DeepSeek'],
    ['claude', true, 'Shell'],
    ['someday-agent', false, 'someday-agent'],
  ]
  for (const [agent, shell, name] of cases) {
    it(`${shell ? 'a shell' : agent ?? 'no agent'} reads as ${name}`, () => {
      render(<AgentGlyph agent={agent} shell={shell} />)
      const g = screen.getByRole('img', { name })
      expect(g).toHaveAttribute('title', name)
      // A drawn mark, not the old text monogram.
      expect(g.querySelector('svg')).not.toBeNull()
      expect(g.textContent).toBe('')
    })
  }

  it('gives every agent its own mark', () => {
    const marks = ['claude', ...OTHERS].map((a) => {
      const { container, unmount } = render(<AgentGlyph agent={a} />)
      const html = container.querySelector('svg')!.innerHTML
      unmount()
      return html
    })
    expect(new Set(marks).size).toBe(marks.length)
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
