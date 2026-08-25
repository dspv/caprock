/**
 * The lifetime breakdown moved out of the all-time line and into its own panel
 * between the live feed and the session rows. Hidden inside that line nobody
 * found it; expanded there it pushed Today and the live pulse below the fold.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BreakdownPanel } from './Breakdown'
import type { History } from '@/lib/api'

const data = vi.hoisted(() => ({ value: undefined as unknown }))

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, history: async () => data.value } }
})

const history = (over: Partial<History> = {}): History =>
  ({
    totals: {},
    tools: [
      { tool: 'Bash', count: 40839 },
      { tool: 'mcp__claude-in-chrome__computer', count: 1704 },
    ],
    summary: {
      models: [{ model: 'claude-opus-5', tokens: 1, turns: 1, cost_usd: 5398.7 }],
      projects: [],
    },
    ...over,
  }) as unknown as History

describe('BreakdownPanel', () => {
  it('shows both breakdowns without anything to click', async () => {
    data.value = history()
    render(<BreakdownPanel />)
    expect(await screen.findByText('Most-used tools')).toBeTruthy()
    expect(screen.getByText('Where the money went')).toBeTruthy()
    expect(screen.getByText('Bash')).toBeTruthy()
    expect(screen.getByText('claude-opus-5')).toBeTruthy()
  })

  it('shortens an MCP tool name rather than letting it push the bar off the row', async () => {
    data.value = history()
    render(<BreakdownPanel />)
    // `mcp__server__tool` is rendered as `server·tool`; the raw form is 31
    // characters of prefix before anything meaningful.
    expect(await screen.findByText('claude-in-chrome·computer')).toBeTruthy()
  })

  it('renders nothing at all on a machine with no history', async () => {
    data.value = { ...history(), tools: [], summary: { models: [], projects: [] } } as unknown as History
    const { container } = render(<BreakdownPanel />)
    await new Promise((r) => setTimeout(r, 0))
    expect(container.textContent).toBe('')
  })

  it('links to the screen holding the full tables', async () => {
    data.value = history()
    render(<BreakdownPanel />)
    expect(
      await screen.findByRole('link', { name: /every tool, model and project/i }),
    ).toHaveAttribute('href', '#/history')
  })
})
