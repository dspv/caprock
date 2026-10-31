/**
 * At a glance shares like the other figure panels (owner, 2026-10-31: it had
 * no share button): the icon in its header while it is open, Copy as text
 * with the Numbers view's tables, and the picture without its controls.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Glance, History } from '@/lib/api'

const history = vi.hoisted(() => ({
  summary: { models: [{ model: 'claude-opus-5', cost_usd: 600 }, { model: 'claude-sonnet-5', cost_usd: 200 }] },
  tools: [{ tool: 'Bash', count: 300 }, { tool: 'Read', count: 100 }],
  totals: { sessions: 10, cost_usd: 800, days: 3 },
}))
const glance = vi.hoisted(() => ({
  display: { 'claude-opus-5': 'Claude Opus 5', 'claude-sonnet-5': 'Claude Sonnet 5' },
  bill: { cache_read_usd: 500, cache_write_usd: 200, output_usd: 80, input_usd: 20 },
  agents: [{ agent: 'claude', subagent: false, turns: 900, cost_usd: 700, sessions: 9 }, { agent: 'codex', subagent: false, turns: 100, cost_usd: 100, sessions: 1 }],
}))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, history: async () => history, glance: async () => glance } }
})

import { AtAGlancePanel, agentRows, glanceCharts, glanceText } from './AtAGlance'
import { stripChrome } from '@/lib/panelShare'

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

describe('At a glance, shared', () => {
  it('writes the Numbers view as Markdown: models, the bill, tools and agents', () => {
    const c = glanceCharts(history as unknown as History, glance as unknown as Glance)
    const t = glanceText(c, agentRows(glance.agents as never))
    expect(t).toContain('All time, every agent.')
    expect(t).toContain('Where the money went')
    expect(t).toContain('| Opus 5 | $600.00 | 75% |')
    expect(t).toContain('The bill by token type')
    expect(t).toContain('| cache read | $500.00 | 62% |')
    expect(t).toContain('| Bash | 300 | 75% |')
    expect(t).toContain('| Agent | Turns | Cost | Share |')
    expect(t).toContain('| Codex | 100 | $100.00 | 12% |')
  })

  it('has the share button while open, none folded, and its picture leaves the controls out', async () => {
    render(<AtAGlancePanel />)
    const share = await screen.findByRole('button', { name: 'Share At a glance' })
    fireEvent.click(share)
    expect(screen.getByRole('menu', { name: 'Share At a glance' }).textContent).toContain('Copy as text')

    const section = share.closest('section')!
    const copy = section.cloneNode(true) as HTMLElement
    stripChrome(copy)
    expect(copy.querySelector('[role="group"][aria-label="View"]')).toBeNull()
    expect(copy.querySelector('[data-panel-share]')).toBeNull()
    expect(copy.textContent).not.toMatch(/fold to icons|show cards/)
    expect(copy.textContent).toContain('At a glance')
    expect(copy.textContent).toContain('Where the money went')

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'At a glance', expanded: true })) })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Share At a glance' })).toBeNull())
  })
})
