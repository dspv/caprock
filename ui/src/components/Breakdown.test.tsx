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
      models: [{ model: 'claude-opus-5', tokens: 10_082_171_962, output: 14_600_000, turns: 28_000, cost_usd: 5398.7 }],
      projects: [],
      tokens_in: 38_927_644,
      tokens_out: 25_636_758,
      cache_read: 21_939_135_685,
      cache_write: 233_082_627,
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

  it('gives each row its share of the whole, floored', async () => {
    data.value = history()
    render(<BreakdownPanel />)
    // 40,839 of 42,543 calls is 95.99% — floored to 95, never rounded up into
    // looking larger than it measured.
    expect(await screen.findByText('95%')).toBeTruthy()
    // And the share is of everything, not of the rows on screen: the two
    // tools here are the whole list, so they must add to 100.
    expect(screen.getByText('4%')).toBeTruthy()
  })

  it('marks a sliver rather than rounding it away to 0%', async () => {
    data.value = {
      ...history(),
      tools: [
        { tool: 'Bash', count: 10_000 },
        { tool: 'Write', count: 20 },
      ],
    } as unknown as History
    render(<BreakdownPanel />)
    // 0.2% is not 0% — a row with real calls must not read as having none.
    expect(await screen.findByText('<1%')).toBeTruthy()
  })

  it('links to the screen holding the full tables', async () => {
    data.value = history()
    render(<BreakdownPanel />)
    expect(
      await screen.findByRole('link', { name: /every tool, model and project/i }),
    ).toHaveAttribute('href', '#/history')
  })

  it('states the size of the spend, not only how it divides', async () => {
    // A share says how the money split and nothing about how much there was:
    // "opus-5, 54%" reads the same at forty dollars and at four thousand. The
    // absolute figures were a screen away on Cost.
    data.value = history()
    render(<BreakdownPanel />)
    await screen.findByText('claude-opus-5')
    expect(screen.getByText('$5,398.70')).toBeTruthy()
  })

  // The token column used to be every token — and on a normal workload that is
  // ~99% cache read: 10.08B against 14.6M of output for the same model. It read
  // as "how much work went through here" while measuring how many times one
  // context was re-read, at a tenth of the price. Output is the model's own
  // work, all of it at the top rate, and comparable between models.
  it('counts what the model wrote, not what it re-read', async () => {
    data.value = history()
    render(<BreakdownPanel />)
    await screen.findByText('claude-opus-5')
    expect(screen.getByText('14.60M')).toBeTruthy()
    expect(screen.queryByText('10.08B')).toBeNull()
  })

  // The only figure in this panel that compares models rather than measuring
  // them: a Fable turn costs 25× a DeepSeek one, and nothing said so.
  it('prices a turn, which is what compares one model to another', async () => {
    data.value = history()
    render(<BreakdownPanel />)
    await screen.findByText('claude-opus-5')
    expect(screen.getByText('$0.19')).toBeTruthy() // 5398.70 / 28,000
  })

  it('splits input from output, which no per-model row can show', async () => {
    // Output costs five times input, so the ratio is the explanation of the
    // bill. Cache read sits beside them because it dwarfs both here and would
    // otherwise make the two look like they should sum to the total.
    data.value = history()
    render(<BreakdownPanel />)
    await screen.findByText('claude-opus-5')
    expect(screen.getByText('input')).toBeTruthy()
    expect(screen.getByText('38.93M')).toBeTruthy()
    // "output" now names a column too, so this asserts the totals row's figure
    // rather than the word.
    expect(screen.getByText('25.64M')).toBeTruthy()
    expect(screen.getByText('cache read')).toBeTruthy()
  })

  it('omits the token line rather than showing four zeroes', async () => {
    // Zeroes claim "you used nothing", which is a different statement from
    // "this build does not report it".
    data.value = history({
      summary: {
        models: [{ model: 'claude-opus-5', tokens: 0, turns: 1, cost_usd: 5398.7 }],
        projects: [],
      },
    } as unknown as Partial<History>)
    render(<BreakdownPanel />)
    await screen.findByText('claude-opus-5')
    expect(screen.queryByText('cache read')).toBeNull()
  })
})
