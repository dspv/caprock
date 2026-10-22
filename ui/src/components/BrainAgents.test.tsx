import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const m = vi.hoisted(() => ({ glance: vi.fn() }))
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, glance: m.glance } }
})

import type { WeekAgent } from '@/lib/api'
import { agentsLine, agentsUsed, BrainHero, nameList, useAgentsUsed } from './BrainAgents'
import { SecondBrainModal } from './SecondBrainModal'

const row = (agent: string, sessions: number, over: Partial<WeekAgent> = {}): WeekAgent => ({ agent, subagent: false, turns: sessions * 10, cost_usd: 0, sessions, ...over })

function Probe() {
  const agents = useAgentsUsed()
  return (
    <>
      <BrainHero agents={agents} />
      <p data-line>{agentsLine(agents)}</p>
    </>
  )
}
const drawn = () => [...document.querySelectorAll('[data-brain-agent]')].map((g) => g.getAttribute('data-brain-agent'))

describe('Second Brain agents', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('draws the agents used, most sessions first, subagent rows added in, at most five, only those with a character', () => {
    expect(agentsUsed([
      row('codex', 4),
      row('claude', 3),
      row('claude', 9, { subagent: true }),
      row('gemini', 2),
      row('grok', 50),
      row('custom:aider', 40),
      row('opencode', 1),
      row('deepseek', 1, { turns: 30 }),
    ])).toEqual(['claude', 'codex', 'gemini', 'deepseek', 'opencode'])
    expect(agentsUsed([row('codex', 0, { turns: 0 })])).toEqual(['claude'])
    expect(agentsUsed([])).toEqual(['claude'])
    expect(agentsUsed(undefined)).toEqual(['claude'])
  })

  it('names them in plain list grammar', () => {
    expect(nameList(['Claude Code'])).toBe('Claude Code')
    expect(nameList(['Claude Code', 'Codex'])).toBe('Claude Code and Codex')
    expect(nameList(['Claude Code', 'Codex', 'Gemini CLI'])).toBe('Claude Code, Codex and Gemini CLI')
    expect(agentsLine(['claude'])).toBe('Claude Code remembers across sessions.')
    expect(agentsLine(['claude', 'codex'])).toBe('Claude Code and Codex add to it; Claude Code sessions start with it.')
    expect(agentsLine(['claude', 'codex', 'gemini'])).toBe('Claude Code, Codex and Gemini CLI add to it; Claude Code sessions start with it.')
    expect(agentsLine(['codex'])).toBe('Codex adds to it; Claude Code sessions start with it.')
  })

  it('reads several agents from the last 30 days of usage', async () => {
    m.glance.mockResolvedValue({ agents: [row('gemini', 2), row('claude', 8), row('codex', 5)], display: {} })
    render(<Probe />)
    await waitFor(() => expect(drawn()).toEqual(['claude', 'codex', 'gemini']))
    expect(m.glance).toHaveBeenCalledWith('30d')
    expect(document.querySelector('[data-line]')!.textContent).toBe('Claude Code, Codex and Gemini CLI add to it; Claude Code sessions start with it.')
    // One line and one pulse per agent, into the one brain.
    expect(document.querySelectorAll('.brain-hero-links path')).toHaveLength(3)
    expect(document.querySelectorAll('.brain-hero-pulse')).toHaveLength(3)
    expect(document.querySelectorAll('[data-brain-hero] [data-brain-mark]')).toHaveLength(1)
  })

  it('is Claude Code alone with no usage, and when the read fails', async () => {
    m.glance.mockResolvedValue({ agents: [], display: {} })
    render(<Probe />)
    await waitFor(() => expect(m.glance).toHaveBeenCalled())
    expect(drawn()).toEqual(['claude'])
    expect(document.querySelector('[data-line]')!.textContent).toBe('Claude Code remembers across sessions.')
    cleanup()
    m.glance.mockRejectedValue(new Error('down'))
    render(<Probe />)
    await waitFor(() => expect(m.glance).toHaveBeenCalledTimes(2))
    expect(drawn()).toEqual(['claude'])
  })

  it('draws one agent when one is used', async () => {
    m.glance.mockResolvedValue({ agents: [row('codex', 3)], display: {} })
    render(<Probe />)
    await waitFor(() => expect(drawn()).toEqual(['codex']))
    expect(document.querySelector('[data-line]')!.textContent).toBe('Codex adds to it; Claude Code sessions start with it.')
  })

  it('says Free in the How it works dialog, by the title, and names the agents used', async () => {
    m.glance.mockResolvedValue({ agents: [row('claude', 8), row('codex', 5)], display: {} })
    render(<SecondBrainModal onClose={() => {}} onOpen={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: 'Second Brain' })
    expect(dialog.querySelector('[data-brain-free]')!.textContent).toBe('Free')
    expect(dialog.querySelector('[data-brain-free] + h2')!.textContent).toBe('One memory for all your agents')
    expect(dialog.querySelector('[data-brain-privacy]')!.textContent).toBe('Free — runs on your own Claude, on this computer.')
    await waitFor(() => expect(dialog.querySelector('[data-brain-agents-line]')!.textContent).toBe('Claude Code and Codex add to it; Claude Code sessions start with it.'))
    expect([...dialog.querySelectorAll('[data-brain-agent]')].map((g) => g.getAttribute('data-brain-agent'))).toEqual(['claude', 'codex'])
  })

  it('holds the pulses still under reduced motion, halfway along', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'BrainMark.css'), 'utf8')
    const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toMatch(/\.brain-hero-pulse\s*\{\s*animation:\s*none/)
    // The still picture is the rule's own offset: halfway along the line.
    expect(css).toMatch(/\.brain-hero-pulse\s*\{[^}]*stroke-dashoffset:\s*-0\.5;/)
  })
})
